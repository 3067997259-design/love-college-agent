import { app, BrowserWindow, dialog, powerMonitor } from 'electron'
import { join, resolve } from 'node:path'
import { mkdirSync } from 'node:fs'
import { systemClock } from './clock'
import { createAppController } from './bridge/controller'
import { registerAppBridge } from './bridge/ipc'
import { probeSqlite } from './validation/sqlite'
import { probeImap } from './mail/probe'
import { openSessionStore, resumeSavedSession, type SessionStore } from './store/session'
import { probeJournal } from './validation/journal'
import { probeModel } from './validation/model'
import { readModelProviders, readPrivateCredentialValues } from './config/providers'
import { createModelClient } from './model/client'
import { createHarness } from './harness/loop'
import { builtinTools } from './harness/tools'
import { probeHarness } from './validation/harness'
import { createPluginRegistry } from './plugins/registry'
import { createScheduler, type Scheduler } from './scheduler'
import { prepareRuntime, attachRuntime } from './developer/runtime'
import { createFakePrivacyModel } from './privacy/filter'
import { createPomodoro, type PomodoroService } from './pomodoro/service'
import { pomodoroTools } from './pomodoro/tools'
import { probePomodoro } from './validation/pomodoro'
import { createFakeMailbox, createBlockedImapSource } from './mail/fake'
import { openEvidenceVault, type EvidenceVault } from './mail/evidence-vault'
import { createCampusService, type CampusService } from './campus/service'
import { mailTools } from './mail/tools'
import { probeCampus } from './validation/campus'
import { createArtifactStore } from './artifacts/store'
import { previewArtifact } from './artifacts/viewer'
import { openDocumentVault, type DocumentVault } from './documents/vault'
import { createDocumentService, type DocumentService } from './documents/service'
import { createFakeDocumentModel } from './documents/privacy'
import { documentTools } from './documents/tools'
import { probeDocuments } from './validation/documents'
import { openMemoryRepository, type MemoryRepository } from './memory/repository'
import { createMemoryService, type MemoryService } from './memory/service'
import { createFakeMemoryModel } from './memory/model'
import { memoryTools } from './memory/tools'
import { probeMemory } from './validation/memory'
import { createMcpService, type McpService } from './mcp/service'
import { startMcpFixture } from './mcp/fixture'
import { probeStudentHubMcp } from './validation/mcp'
import { createBackupService, type BackupService } from './backup/service'
import { applyPendingRestore } from './backup/restore'
import { probeBackup } from './validation/backup'
import { createQuillService, quillTools, type QuillService } from './gifts/quill'
import { buildDiagnostics } from './developer/diagnostics'
import { createTaskModelPorts } from './model/task-ports'
import { createModelSettings, providerConfigPath, type ModelSettingsService } from './config/model-settings'
import { createCompanionWindows, type CompanionWindows } from './windows/companion'

const dataRoot = resolve(process.env.LCA_DATA_DIR ?? (app.isPackaged ? app.getPath('userData') : join(process.cwd(), '.local-data')))
const prepared = prepareRuntime(dataRoot, systemClock, process.env.LCA_BOOTH === '1')
const { clock } = prepared
const dataDir = prepared.profile.path
const providersFile = providerConfigPath(dataRoot, process.env.LCA_PROVIDERS_FILE ?? join(app.getAppPath(), 'secrets/providers.json'))
const cdpPort = Number(process.env.LCA_CDP_PORT ?? 9427)
if (prepared.developer) {
  app.commandLine.appendSwitch('remote-debugging-address', '127.0.0.1')
  app.commandLine.appendSwitch('remote-debugging-port', String(cdpPort))
}
mkdirSync(dataDir, { recursive: true })
mkdirSync(join(dataDir, 'chromium'), { recursive: true })
app.setPath('userData', dataDir)
app.setPath('sessionData', join(dataDir, 'chromium'))
const ownsData = app.requestSingleInstanceLock()
if (!ownsData) app.quit()
let controller: ReturnType<typeof createAppController> | undefined
let bridge: ReturnType<typeof registerAppBridge> | undefined
let store: SessionStore | undefined
let harness: ReturnType<typeof createHarness> | undefined
let scheduler: Scheduler | undefined
let runtime: Awaited<ReturnType<typeof attachRuntime>> | undefined
let pomodoro: PomodoroService | undefined
let campus: CampusService | undefined
let vault: EvidenceVault | undefined
let documentVault: DocumentVault | undefined
let documents: DocumentService | undefined
let memoryRepository: MemoryRepository | undefined
let memory: MemoryService | undefined
let mcp: McpService | undefined
let mcpFixture: Awaited<ReturnType<typeof startMcpFixture>> | undefined
let backup: BackupService | undefined
let quill: QuillService | undefined
let modelSettings: ModelSettingsService | undefined
let companionWindows: CompanionWindows | undefined

function createWindow(): void {
  const window = new BrowserWindow({
    width: 1200, height: 800, show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      sandbox: true, contextIsolation: true, nodeIntegration: false,
    },
  })
  bridge!.attach(window)
  companionWindows = createCompanionWindows({ book: window, clock, uiClock: systemClock, scheduler: scheduler!, settings: prepared.pluginSettings, snapshot: controller!.getSnapshot, subscribe: controller!.subscribe, changed: () => controller?.refresh('mode'),
    createMini: (bounds) => {
      const mini = new BrowserWindow({ ...bounds, title: 'Love College Agent · Mini', show: false, frame: false, thickFrame: false, transparent: true, backgroundColor: '#00000000', alwaysOnTop: true, skipTaskbar: true, resizable: false, maximizable: false, minimizable: false, hasShadow: false,
        webPreferences: { preload: join(__dirname, '../preload/index.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false } })
      bridge!.attach(mini, 'mini'); mini.webContents.setWindowOpenHandler(() => ({ action: 'deny' })); mini.webContents.on('will-navigate', (event) => event.preventDefault())
      if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL) { const url = new URL(process.env.ELECTRON_RENDERER_URL); url.searchParams.set('view', 'mini'); void mini.loadURL(url.toString()) }
      else void mini.loadFile(join(__dirname, '../renderer/index.html'), { query: { view: 'mini' } })
      return mini
    } })
  controller!.attachWindows(companionWindows)
  window.once('ready-to-show', () => window.show())
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event) => event.preventDefault())
  if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL) {
    void window.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void window.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

void app.whenReady().then(async () => {
  if (!ownsData) return
  if (prepared.developer && process.argv.some((arg) => arg.startsWith('--lca-probe='))) { console.log('LCA_PROBE:{"ok":false,"error":"DEVELOPER_PROFILE_REFUSED"}'); app.exit(1); return }
  if (process.argv.includes('--lca-probe=mcp-student-hub')) {
    try { const report = await probeStudentHubMcp(dataDir); console.log('LCA_PROBE:' + JSON.stringify(report)); app.exit(report.ok ? 0 : 1) }
    catch { console.log('LCA_PROBE:{"ok":false,"probe":"mcp-student-hub","error":"MCP_STUDENT_HUB_PROBE_FAILED"}'); app.exit(1) }
    return
  }
  if (process.argv.includes('--lca-probe=memory')) {
    try { const report = await probeMemory(dataDir); console.log('LCA_PROBE:' + JSON.stringify(report)); app.exit(report.ok ? 0 : 1) }
    catch { console.log('LCA_PROBE:{"ok":false,"probe":"memory","error":"MEMORY_PROBE_FAILED"}'); app.exit(1) }
    return
  }
  if (process.argv.includes('--lca-probe=backup')) {
    try { const report = await probeBackup(dataDir); console.log('LCA_PROBE:' + JSON.stringify(report)); app.exit(report.ok ? 0 : 1) }
    catch { console.log('LCA_PROBE:{"ok":false,"probe":"backup","error":"PRIVATE_SAVE_PROBE_FAILED"}'); app.exit(1) }
    return
  }
  if (process.argv.includes('--lca-probe=documents')) {
    try { const report = await probeDocuments(dataDir); console.log('LCA_PROBE:' + JSON.stringify(report)); app.exit(0) }
    catch { console.log('LCA_PROBE:{"ok":false,"probe":"documents","error":"DOCUMENT_PROBE_FAILED"}'); app.exit(1) }
    return
  }
  if (process.argv.includes('--lca-probe=campus')) {
    try { const report = await probeCampus(dataDir); console.log('LCA_PROBE:' + JSON.stringify(report)); app.exit(0) }
    catch { console.log('LCA_PROBE:{"ok":false,"probe":"campus","error":"CAMPUS_PROBE_FAILED"}'); app.exit(1) }
    return
  }
  if (process.argv.includes('--lca-probe=harness')) {
    const report = await probeHarness(dataDir, providersFile, systemClock)
    console.log('LCA_PROBE:' + JSON.stringify(report))
    app.exit(report.ok ? 0 : 1)
    return
  }
  if (process.argv.includes('--lca-probe=model')) {
    const report = await probeModel(providersFile, systemClock)
    console.log('LCA_PROBE:' + JSON.stringify(report))
    app.exit(report.ok ? 0 : 1)
    return
  }
  if (process.argv.includes('--lca-probe=journal')) {
    try {
      console.log('LCA_PROBE:' + JSON.stringify(probeJournal(dataDir)))
      app.exit(0)
    } catch {
      console.log('LCA_PROBE:' + JSON.stringify({ ok: false, probe: 'journal', error: 'JOURNAL_PROBE_FAILED' }))
      app.exit(1)
    }
    return
  }
  if (process.argv.includes('--lca-probe=pomodoro')) {
    try { console.log('LCA_PROBE:' + JSON.stringify(probePomodoro(dataDir))); app.exit(0) }
    catch { console.log('LCA_PROBE:{"ok":false,"probe":"pomodoro","error":"POMODORO_PROBE_FAILED"}'); app.exit(1) }
    return
  }
  if (process.argv.includes('--lca-probe=sqlite')) {
    try {
      console.log('LCA_PROBE:' + JSON.stringify(probeSqlite(dataDir)))
      app.exit(0)
    } catch {
      console.log('LCA_PROBE:' + JSON.stringify({ ok: false, probe: 'sqlite', error: 'SQLITE_NATIVE_PROBE_FAILED' }))
      app.exit(1)
    }
    return
  }
  if (process.argv.includes('--lca-probe=imap')) {
    const report = await probeImap(providersFile)
    console.log('LCA_PROBE:' + JSON.stringify(report))
    app.exit(report.ok ? 0 : 1)
    return
  }
  try {
    const restoreReceipt = applyPendingRestore(dataDir, { userId: 'local-user', characterId: 'default-character' }, prepared.developer ? 'fake' : 'real', clock)
    if (restoreReceipt?.status === 'restored') {
      prepared.pluginSettings.update((draft) => { draft.fileFilteringEnabled = restoreReceipt.manifest.fileFilteringEnabled })
      resumeSavedSession(dataDir, restoreReceipt.manifest.owner, restoreReceipt.manifest.activeDayKey, restoreReceipt.manifest.activeSessionId)
    }
    store = openSessionStore(dataDir, { userId: 'local-user', characterId: 'default-character' }, clock)
    if (restoreReceipt?.status === 'restored') {
      const timer = structuredClone(restoreReceipt.manifest.pomodoro)
      if (timer.status === 'running') timer.endsAtMs = clock.nowMs() + timer.remainingMs
      store.append({ type: 'pomodoro/state', view: timer, pauseReason: restoreReceipt.manifest.pomodoroPause, cause: 'restored' })
      store.append({ type: 'save/restored', archiveId: restoreReceipt.manifest.archiveId, restoreId: restoreReceipt.restoreId, exportedAtMs: restoreReceipt.manifest.savedAtMs, restoredAtMs: clock.nowMs() })
    }
    if (prepared.scene && store.records().length === 1) store.append({ type: 'companion/mode', mode: prepared.scene.mode, requestId: 'development-scene', commandHash: 'development-scene' })
    controller = createAppController(clock, undefined, store)
    const providers = prepared.developer ? new Map() : await readModelProviders(providersFile)
    const taskModels = createTaskModelPorts(providers, clock, store)
    scheduler = createScheduler(clock, () => { console.error('Scheduler stopped: local operation failed.'); app.quit() })
    vault = openEvidenceVault(dataDir, store.scope)
    const fakeMailbox = prepared.developer ? createFakeMailbox(clock) : undefined
    const fakeDocuments = prepared.developer ? createFakeDocumentModel(clock) : undefined
    const artifacts = createArtifactStore(dataDir, store.scope)
    documentVault = openDocumentVault(dataDir, store.scope)
    documents = createDocumentService({ clock, store, scheduler, settings: prepared.pluginSettings, vault: documentVault, artifacts, model: fakeDocuments?.model ?? taskModels.document, development: fakeDocuments,
      ...(fakeMailbox?.source.readAttachment ? { readAttachment: (attachment, signal) => fakeMailbox.source.readAttachment!(attachment, signal) } : {}),
      openArtifact: previewArtifact, changed: () => controller?.refresh('task'), emit: (id, text) => { harness?.postEvent('document', text, id) },
      failed: () => { console.error('Document processing stopped: local storage unavailable.'); app.quit() } })
    controller.attachDocuments(documents)
    memoryRepository = openMemoryRepository(dataDir, store)
    const fakeMemory = prepared.developer ? createFakeMemoryModel() : undefined
    memory = createMemoryService({ clock, store, scheduler, repository: memoryRepository, model: fakeMemory?.model ?? taskModels.memory, development: fakeMemory,
      isBusy: () => harness?.isBusy() ?? false, changed: () => controller?.refresh('connection'),
      rolled: () => { controller?.refresh('connection'); harness?.sessionChanged(); pomodoro?.reconcile(); campus?.stateChanged(); documents?.stateChanged() },
      failed: () => { console.error('Memory processing stopped: local storage unavailable.'); app.quit() } })
    controller.attachMemory(memory)
    campus = createCampusService({ clock, store, scheduler, vault, source: fakeMailbox?.source ?? createBlockedImapSource(), privacy: fakeMailbox?.privacy ?? taskModels.mail,
      artifacts, openArtifact: previewArtifact, attachment: (record) => documents!.registerAttachment(record),
      development: fakeMailbox, changed: () => controller?.refresh('task'), emit: (id, text) => { harness?.postEvent('mail', text, id) },
      failed: () => { console.error('Campus processing stopped: local storage unavailable.'); app.quit() } })
    controller.attachCampus(campus)
    bridge = registerAppBridge(controller, async (ref, scope) => vault!.read(ref, scope))
    pomodoro = createPomodoro({ clock, store, scheduler, changed: () => controller?.refresh('timer'), stateChanged: () => harness?.stateChanged(),
      emit: (id, text) => { harness?.postEvent('pomodoro', text, id) } })
    const plugins = createPluginRegistry({ root: join(dataDir, 'plugins'), settings: prepared.pluginSettings, privacyModel: prepared.developer ? createFakePrivacyModel() : taskModels.narrow })
    plugins.registerBuiltin('core', '时钟与任务计划', builtinTools())
    plugins.registerBuiltin('pomodoro', '番茄钟', pomodoroTools(pomodoro))
    plugins.registerBuiltin('mail', '邮箱与校园候选', mailTools(campus), { handlesPrivacy: true, permissions: ['network'] })
    plugins.registerBuiltin('documents', '附件与资料整理', documentTools(documents), { handlesPrivacy: true, permissions: ['filesystem'] })
    plugins.registerBuiltin('memory', '经历记忆与日会话', memoryTools(memory))
    plugins.registerBuiltin('mcp', '外部 MCP 工具连接', [])
    if (prepared.developer) plugins.registerBuiltin('developer', '开发调试 MCP', [])
    plugins.discover()
    const modelReady = prepared.developer || providers.has('chat')
    if (prepared.developer) mcpFixture = await startMcpFixture(clock)
    mcp = createMcpService({ clock, configPath: process.env.LCA_MCP_CONFIG ?? join(dataDir, 'connections/mcp.json'), source: prepared.developer ? 'fake' : 'real',
      privacyModel: prepared.developer ? createFakePrivacyModel() : taskModels.narrow, developmentConfig: mcpFixture?.config,
      chooseConfig: async () => { const selected = await dialog.showOpenDialog({ title: '导入 MCP 配置（配置仅由主进程读取）', properties: ['openFile'], filters: [{ name: 'MCP 配置', extensions: ['json'] }] }); return selected.canceled ? null : selected.filePaths[0] ?? null },
      canConfigure: () => !harness?.isBusy(), changed: () => controller?.refresh('connection') })
    controller.attachMcp(mcp)
    harness = createHarness({ store, clock, model: prepared.scripted?.model ?? createModelClient(providers, ['chat'], clock), tools: [], getTools: () => [...plugins.tools(), ...(mcp?.tools() ?? [])], enabled: () => modelReady, changed: (reason) => controller?.refresh(reason),
      prepareContext: (id, signal) => memory!.prepareContext(id, signal), foreground: () => memory?.foreground(),
      failed: () => { console.error('Execution stopped: local storage unavailable.'); app.quit() } })
    controller.attachExecution(harness, modelReady)
    const privateCredentials = prepared.developer ? [] : await readPrivateCredentialValues(providersFile)
    modelSettings = createModelSettings({ root: dataRoot, developer: prepared.developer, slots: [...providers.keys()], canConfigure: () => !harness?.isBusy() && !backup?.isBusy(),
      choose: async () => { const selected = await dialog.showOpenDialog({ title: '导入模型槽位配置（内容仅由主进程读取）', properties: ['openFile'], filters: [{ name: '模型配置', extensions: ['json'] }] }); return selected.canceled ? null : selected.filePaths[0] ?? null }, changed: () => controller?.refresh('connection') })
    controller.attachModelSettings(modelSettings)
    backup = createBackupService({ root: dataDir, store, clock, source: prepared.developer ? 'fake' : 'real', fileFilteringEnabled: () => prepared.pluginSettings.read().fileFilteringEnabled, credentials: privateCredentials,
      canStart: () => !harness!.isBusy() && campus!.view().status !== 'scanning' && !documents!.view().jobs.some((job) => job.status === 'processing'),
      freeze: async () => { scheduler!.pauseBackground(true); memory!.foreground(); await memory!.idle(); if (harness!.isBusy() || campus!.view().status === 'scanning' || documents!.view().jobs.some((job) => job.status === 'processing')) { scheduler!.pauseBackground(store!.projection().lightsOut); throw new Error('BACKUP_BUSY') }; return () => { scheduler!.pauseBackground(store!.projection().lightsOut); pomodoro?.reconcile() } },
      chooseExport: async (name) => { const selected = await dialog.showSaveDialog({ title: '导出私人存档', defaultPath: name, filters: [{ name: '私人存档', extensions: ['lca-save'] }] }); return selected.canceled ? null : selected.filePath ?? null },
      chooseImport: async () => { const selected = await dialog.showOpenDialog({ title: '选择私人存档', properties: ['openFile'], filters: [{ name: '私人存档', extensions: ['lca-save'] }] }); return selected.canceled ? null : selected.filePaths[0] ?? null },
      restart: () => { systemClock.after(100, () => { app.relaunch(); app.quit() }) }, changed: () => controller?.refresh('restore') })
    controller.attachBackup(backup)
    quill = createQuillService({ clock, store, scheduler, artifacts, memory: memoryRepository, isBusy: () => harness?.isBusy() ?? false, emit: (source, text, id) => harness?.postEvent(source, text, id), changed: () => controller?.refresh('task') })
    controller.attachQuill(quill)
    plugins.registerBuiltin('gifts', '第一件礼物', quillTools(quill))
    controller.attachDiagnostics(() => buildDiagnostics({ clock, store: store!, scheduler: scheduler!, memory: memoryRepository!, fileFilteringEnabled: prepared.pluginSettings.read().fileFilteringEnabled, mailStatus: campus!.view().status,
      pendingFiles: documents!.view().jobs.filter((job) => ['staged', 'queued', 'processing'].includes(job.status)).length }))
    controller.attachPomodoro(pomodoro, () => plugins.views().some((item) => item.id === 'pomodoro' && item.status === 'enabled'))
    plugins.mountService('pomodoro', (enabled) => { if (enabled) pomodoro?.reconcile(); else pomodoro?.pause() })
    plugins.mountService('mail', (enabled) => campus?.setEnabled(enabled))
    plugins.mountService('documents', (enabled) => documents?.setEnabled(enabled))
    plugins.mountService('memory', (enabled) => memory?.setEnabled(enabled))
    plugins.mountService('mcp', (enabled) => mcp?.setEnabled(enabled))
    if (prepared.scene?.preset === 'pomodoro-demo' && store.records().length <= 2) pomodoro.propose({ label: '开发演示', plannedCount: 2, focusDurationMs: 60_000, shortBreakDurationMs: 20_000, longBreakDurationMs: 20_000, longBreakEvery: 4, timing: 'demo' }, 'user')
    harness.stateChanged()
    scheduler.schedule('ui.snapshot', clock.nowMs() + 1000, () => controller?.refresh('timer'), { everyMs: 1000, background: false })
    runtime = await attachRuntime({ prepared, controller, plugins, harness, scheduler, store,
      locked: () => backup?.isBusy() ?? false,
      mcpPort: Number(process.env.LCA_MCP_PORT ?? 5175), cdpPort,
      restart: () => { systemClock.after(100, () => { app.relaunch(); app.quit() }) } })
    powerMonitor.on('resume', () => { if (!backup?.isBusy()) { pomodoro?.reconcile(); scheduler?.reconcile() } })
  } catch {
    console.error('Application storage unavailable; existing data preserved.')
    app.exit(1)
    return
  }
  createWindow()
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow() })
})
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
let closing = false
let storageClosed = false
app.on('before-quit', (event) => {
  if (harness && !storageClosed) {
    event.preventDefault()
    if (closing) return
    closing = true
    pomodoro?.dispose()
    quill?.dispose()
    companionWindows?.dispose()
    const closeCampus = campus?.close()
    const closeDocuments = documents?.close()
    const closeMemory = memory?.close()
    scheduler?.dispose()
    void Promise.all([harness.dispose(), runtime?.close(), closeCampus, closeDocuments, closeMemory, mcp?.close(), backup?.close(), modelSettings?.close()]).then(() => mcpFixture?.close()).catch(() => { console.error('Shutdown interrupted; durable data preserved.') }).finally(() => { controller?.dispose(); bridge?.dispose(); memoryRepository?.close(); documentVault?.close(); vault?.close(); store?.close(); storageClosed = true; app.quit() })
  } else if (!storageClosed) { scheduler?.dispose(); controller?.dispose(); bridge?.dispose(); store?.close(); storageClosed = true }
})
