import { app, BrowserWindow, dialog, powerMonitor, protocol, shell, Notification, nativeImage } from 'electron'
import { join, resolve } from 'node:path'
import { mkdirSync } from 'node:fs'
import { systemClock } from './clock'
import { initialOnboarding } from './onboarding/schema'
import { createBinaryAssets, assetPath } from './storage/assets'
import { createRodinApi, readRodinConfig } from './gifts/rodin-api'
import { createRodinMcp } from './gifts/mcp'
import { createGiftService, giftTools, type GiftService } from './gifts/service'
import { syntheticGlb } from './gifts/fixture'
import { randomUUID } from 'node:crypto'
import { createHeartFlow, deskTools, type HeartFlowService } from './heart-flow/service'
import { contentHash, createDesk } from './heart-flow/desk'
import { createDeskShadow } from './heart-flow/shadow'
import { runIsolatedJavaScript } from './heart-flow/runner'
import { probeHeartFlow } from './validation/heart-flow'
import { createLife, type LifeService } from './life/service'
import { createSleep, type SleepService } from './life/sleep'
import { createLifeWork, type LifeWorkService } from './life/work/service'
import { createFakeLifeWorkModel } from './life/work/fake'
import { createDelegates, type DelegatesService } from './delegates/service'
import { createFakeDelegateModel } from './delegates/fake'
import { createOpticalMemory, type OpticalMemoryService } from './optical/service'
import { renderOpticalPage } from './optical/render'
import { probeLife } from './validation/life'
import { createDiary, type DiaryService } from './diary/service'
import diaryPrompts from './diary/prompts.json'
import { createRoomProjection } from './room/projection'
import { createNotifications, notificationTools, type NotificationsService } from './notifications/service'
import { createCharacterLibrary } from './characters/library'
import { builtinCharacter, createCharacterService, type CharacterService } from './characters/service'
import { definitionSchema } from './characters/package'
import { briefPersona } from './characters/builtin-persona'
import { exportBuiltinCharacter } from './characters/builtin'
import { appliedDeskChanges } from './heart-flow/changes'
import { createHistoryPhotos, type HistoryPhotos } from './history/photos'
import { captureHistoryScene } from './history/capture'
import { createHistoryRecall, type HistoryRecall } from './history/recall'
import { createVoice, type VoiceService } from './voice/service'
import { readVoiceConfig, createSpeechPort, createFakeVoice } from './voice/port'
import { createDeskComputer, type DeskComputer } from './computer/service'
import { openDeskPreview } from './computer/preview'
import { createPublicWebPort } from './web-fetch/port'
import { createFlowFetch, type FlowFetch } from './web-fetch/service'

protocol.registerSchemesAsPrivileged([{ scheme: 'lca-media', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } }])
import { createAppController } from './bridge/controller'
import { registerAppBridge } from './bridge/ipc'
import { probeSqlite } from './validation/sqlite'
import { probeRodin } from './validation/rodin'
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
import { roundedMiniShape, type MiniFallbackReason } from './windows/presentation'
import { resolveRoomLayout, resolveRoomRoot } from './room/paths'
import { migrateLegacyDesk } from './room/legacy-desk'
import { createMinecraft, type MinecraftService } from './minecraft/service'
import { createMinecraftChat, type MinecraftChat } from './minecraft/chat'
import { normalizeGamePixels } from './minecraft/pixels'
import { createResourceBudget, type ResourceBudget } from './resources/service'

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
let lifeWork: LifeWorkService | undefined
let delegates: DelegatesService | undefined
let optical: OpticalMemoryService | undefined
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
let gifts: GiftService | undefined
let heartFlow: HeartFlowService | undefined
let voice: VoiceService | undefined
let computer: DeskComputer | undefined
let webFetch: FlowFetch | undefined
let minecraft: MinecraftService | undefined
let minecraftChat: MinecraftChat | undefined
let resourceBudget: ResourceBudget | undefined
let life: LifeService | undefined
let sleep: SleepService | undefined
let diary: DiaryService | undefined
let notifications: NotificationsService | undefined
let character: CharacterService | undefined
let photos: HistoryPhotos | undefined
let recall: HistoryRecall | undefined
let bookWindow: BrowserWindow | undefined
let modelSettings: ModelSettingsService | undefined
let companionWindows: CompanionWindows | undefined
let miniFallbackReason: MiniFallbackReason | null = process.env.LCA_MINI_OPAQUE === '1' ? 'forced' : null
app.on('gpu-info-update', () => {
  if (!miniFallbackReason && /^(disabled|unavailable)/.test(app.getGPUFeatureStatus().gpu_compositing ?? '')) { miniFallbackReason = 'gpu-unavailable'; companionWindows?.fallback(miniFallbackReason) }
})
app.on('child-process-gone', (_event, details) => {
  if (!miniFallbackReason && details.type === 'GPU' && details.reason !== 'clean-exit') { miniFallbackReason = 'gpu-crash'; companionWindows?.fallback(miniFallbackReason) }
})

function createWindow(): void {
  const window = new BrowserWindow({
    width: 1200, height: 800, show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      sandbox: true, contextIsolation: true, nodeIntegration: false,
    },
  })
  bookWindow = window
  bridge!.attach(window)
  companionWindows = createCompanionWindows({ book: window, clock, uiClock: systemClock, scheduler: scheduler!, settings: prepared.pluginSettings, initialFallbackReason: miniFallbackReason, snapshot: controller!.getSnapshot, subscribe: controller!.subscribe, changed: () => controller?.refresh('mode'),
    createDiagnostics: () => {
      const diagnostics = new BrowserWindow({ width: 800, height: 700, title: 'Love College Agent · Diagnostics', show: false, autoHideMenuBar: true,
        webPreferences: { preload: join(__dirname, '../preload/index.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false } })
      bridge!.attach(diagnostics, 'diagnostics'); diagnostics.webContents.setWindowOpenHandler(() => ({ action: 'deny' })); diagnostics.webContents.on('will-navigate', (event) => event.preventDefault())
      if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL) { const url = new URL(process.env.ELECTRON_RENDERER_URL); url.searchParams.set('view', 'diagnostics'); void diagnostics.loadURL(url.toString()) }
      else void diagnostics.loadFile(join(__dirname, '../renderer/index.html'), { query: { view: 'diagnostics' } })
      return diagnostics
    },
    createMini: (bounds, opaque) => {
      const mini = new BrowserWindow({ ...bounds, useContentSize: true, title: 'Love College Agent · Mini', show: false, frame: false, thickFrame: false, roundedCorners: true, transparent: !opaque, backgroundColor: opaque ? '#F5EEDC' : '#00000000', alwaysOnTop: true, skipTaskbar: true, resizable: false, maximizable: false, minimizable: false, hasShadow: false,
        webPreferences: { preload: join(__dirname, '../preload/index.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false } })
      if (opaque && ['win32', 'linux'].includes(process.platform)) {
        const shape = () => { if (!mini.isDestroyed()) { const [width, height] = mini.getSize(); mini.setShape(roundedMiniShape(width, height)) } }
        shape(); mini.on('resize', shape)
      }
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
  if (process.argv.includes('--lca-probe=life')) {
    try { console.log('LCA_PROBE:' + JSON.stringify(probeLife(dataDir))); app.exit(0) }
    catch { console.log('LCA_PROBE:{"ok":false,"probe":"life","error":"LIFE_PROBE_FAILED"}'); app.exit(1) }; return
  }
  if (process.argv.includes('--lca-probe=heart-flow')) {
    try { const report = await probeHeartFlow(dataDir); console.log('LCA_PROBE:' + JSON.stringify(report)); app.exit(0) }
    catch { console.log('LCA_PROBE:{"ok":false,"probe":"heart-flow","error":"FLOW_PROBE_FAILED"}'); app.exit(1) }
    return
  }
  if (process.argv.includes('--lca-probe=rodin')) {
    try { const report = await probeRodin(dataDir, providersFile, join(app.getAppPath(), '.local-data', 'rodin-live-budget-20261017.json'), systemClock); console.log('LCA_PROBE:' + JSON.stringify(report)); app.exit(report.ok ? 0 : 1) }
    catch { console.log('LCA_PROBE:{"ok":false,"probe":"rodin","error":"RODIN_LIVE_PROBE_FAILED"}'); app.exit(1) }
    return
  }
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
    const characterLibrary = createCharacterLibrary(dataDir)
    const selectedCharacter = prepared.pluginSettings.read().activeCharacterId ?? 'default-character'
    const activeCharacter = selectedCharacter === 'default-character' ? builtinCharacter : characterLibrary.read(selectedCharacter)
    const owner = { userId: 'local-user', characterId: activeCharacter.id }
    const restoreReceipt = applyPendingRestore(dataDir, owner, prepared.developer ? 'fake' : 'real', clock)
    if (restoreReceipt?.status === 'restored') {
      prepared.pluginSettings.update((draft) => { draft.fileFilteringEnabled = restoreReceipt.manifest.fileFilteringEnabled })
      resumeSavedSession(dataDir, restoreReceipt.manifest.owner, restoreReceipt.manifest.activeDayKey, restoreReceipt.manifest.activeSessionId)
    }
    store = openSessionStore(dataDir, owner, clock)
    const binaryAssets = createBinaryAssets(dataDir, store)
    if (activeCharacter.id !== 'default-character') {
      if (!store.history!().some((row) => row.type === 'onboarding/state')) store.append({ type: 'onboarding/state', view: { ...initialOnboarding(), characterName: activeCharacter.name }, cause: 'profile', requestId: 'character-profile:' + activeCharacter.id, commandHash: contentHash(activeCharacter.id) })
      for (const asset of Object.values(activeCharacter.images)) { try { binaryAssets.read(asset); if (!binaryAssets.owned(asset.sha256)) store.append({ type: 'asset/stored', asset }) } catch { /* Missing pictures use the renderer fallback; never replace relationship state. */ } }
      if (!store.history!().some((row) => row.type === 'character/definition' && row.definition.id === activeCharacter.id)) store.append({ type: 'character/definition', definition: definitionSchema.parse(activeCharacter) })
    }
    protocol.handle('lca-media', (request) => {
      try { const url = new URL(request.url); if (request.method !== 'GET' || url.host !== 'asset' || !/^\/[a-f0-9]{64}$/.test(url.pathname) || url.search || url.hash) return new Response(null, { status: 404 })
        const asset = binaryAssets.owned(url.pathname.slice(1)); if (!asset) return new Response(null, { status: 404 })
        const mime = { glb: 'model/gltf-binary', png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp', zip: 'application/zip' }[asset.format]
        return new Response(Uint8Array.from(binaryAssets.read(asset)), { headers: { 'Content-Type': mime, 'X-Content-Type-Options': 'nosniff', 'Access-Control-Allow-Origin': 'null' } })
      } catch { return new Response(null, { status: 404 }) }
    })
    if (restoreReceipt?.status === 'restored') {
      const timer = structuredClone(restoreReceipt.manifest.pomodoro)
      if (timer.status === 'running') timer.endsAtMs = clock.nowMs() + timer.remainingMs
      store.append({ type: 'pomodoro/state', view: timer, pauseReason: restoreReceipt.manifest.pomodoroPause, cause: 'restored' })
      store.append({ type: 'save/restored', archiveId: restoreReceipt.manifest.archiveId, restoreId: restoreReceipt.restoreId, exportedAtMs: restoreReceipt.manifest.savedAtMs, restoredAtMs: clock.nowMs() })
      // Pre-onboarding archives were already usable books; preserve that legacy entry path without inventing a completion time.
      store.append({ type: 'onboarding/state', view: restoreReceipt.manifest.onboarding ?? { ...initialOnboarding(), status: 'completed' }, cause: 'restored', requestId: 'restore-onboarding:' + restoreReceipt.restoreId, commandHash: restoreReceipt.manifest.archiveId })
    }
    if (prepared.scene && store.records().length === 1) store.append({ type: 'companion/mode', mode: prepared.scene.mode, requestId: 'development-scene', commandHash: 'development-scene' })
    controller = createAppController(clock, undefined, store, { booth: prepared.booth })
    const providers = prepared.developer ? new Map() : await readModelProviders(providersFile)
    const privateCredentials = [...(prepared.developer ? [] : await readPrivateCredentialValues(providersFile))]
    resourceBudget = createResourceBudget({ root: join(prepared.developer ? dataDir : dataRoot, 'runtime-resources'), clock, configurable: prepared.booth })
    resourceBudget.bootstrap(JSON.stringify([dataDir, owner.userId, owner.characterId]), store.history?.() ?? store.records())
    controller.attachResources(resourceBudget)
    const taskModels = createTaskModelPorts(providers, clock, store, undefined, resourceBudget)
    scheduler = createScheduler(clock, () => { console.error('Scheduler stopped: local operation failed.'); app.quit() })
    photos = createHistoryPhotos({ store, clock, assets: binaryAssets, changed: () => controller?.refresh('task'),
      canCapture: () => !!bookWindow && !bookWindow.isDestroyed() && !backup?.isBusy() && controller?.getSnapshot().onboarding?.status === 'completed',
      capture: (sessionId) => captureHistoryScene(bookWindow, sessionId, systemClock) })
    controller.attachPhotos(photos)
    scheduler.schedule('history.photos', clock.nowMs() + 5000, () => photos?.reconcile(), { everyMs: 5000 })
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
      includeContextEntries: (seqs) => heartFlow?.normalEntriesAllowed(seqs) ?? new Set(seqs),
      beforeRoll: async () => { if (photos && !photos.photo(store!.scope.sessionId)) { photos.capture('day-end', 'day-end:' + store!.scope.sessionId); await photos.idle() } },
      closingDay: () => { if (!sleep || sleep.set(true, 'day-end')) throw new Error('DAY_END_BUSY') },
      isBusy: () => !!harness?.isBusy() || !!heartFlow?.active() || !!lifeWork?.active() || !!minecraft?.active(), changed: () => controller?.refresh('connection'),
      rolled: () => { controller?.refresh('connection'); harness?.sessionChanged(); pomodoro?.reconcile(); campus?.stateChanged(); documents?.stateChanged() },
      failed: () => { console.error('Memory processing stopped: local storage unavailable.'); app.quit() } })
    controller.attachMemory(memory)
    campus = createCampusService({ clock, store, scheduler, vault, source: fakeMailbox?.source ?? createBlockedImapSource(), privacy: fakeMailbox?.privacy ?? taskModels.mail,
      canProcess: () => (!life || life.view().locationId === 'room') && !lifeWork?.active() && !minecraft?.active(),
      artifacts, openArtifact: previewArtifact, attachment: (record) => documents!.registerAttachment(record),
      development: fakeMailbox, changed: () => controller?.refresh('task'), emit: (id, text) => { harness?.postEvent('mail', text, id) },
      failed: () => { console.error('Campus processing stopped: local storage unavailable.'); app.quit() } })
    controller.attachCampus(campus)
    bridge = registerAppBridge(controller, async (ref, scope) => vault!.read(ref, scope))
    pomodoro = createPomodoro({ clock, store, scheduler, changed: () => { life?.reconcile(); controller?.refresh('timer') }, stateChanged: () => harness?.stateChanged(),
      emit: (id, text) => { harness?.postEvent('pomodoro', text, id) } })
    const plugins = createPluginRegistry({ root: join(dataDir, 'plugins'), settings: prepared.pluginSettings, privacyModel: prepared.developer ? createFakePrivacyModel() : taskModels.narrow })
    plugins.registerBuiltin('core', '时钟与任务计划', builtinTools())
    plugins.registerBuiltin('pomodoro', '番茄钟', pomodoroTools(pomodoro))
    plugins.registerBuiltin('mail', '邮箱与校园候选', mailTools(campus), { handlesPrivacy: true, permissions: ['network'] })
    plugins.registerBuiltin('documents', '附件与资料整理', documentTools(documents), { handlesPrivacy: true, permissions: ['filesystem'] })
    plugins.registerBuiltin('memory', '经历记忆与日会话', memoryTools(memory))
    recall = createHistoryRecall({ store, repository: memoryRepository, photos, changed: () => controller?.refresh('task'),
      canRecall: () => !harness?.isBusy() && !heartFlow?.active() && !store!.projection().lightsOut && (prepared.developer || providers.has('chat')) && !backup?.isBusy(), busy: () => !!harness?.isBusy(),
      send: (question, requestId, hash) => { if (!harness) throw new Error('RECALL_UNAVAILABLE'); harness.send(question, requestId, hash) } })
    controller.attachRecall(recall)
    plugins.registerBuiltin('history', '历史照片与引用回忆', [recall.tool()])
    const ownerRoom = contentHash(JSON.stringify([store.scope.userId, store.scope.characterId]))
    const roomLayout = resolveRoomRoot({
      stored: prepared.pluginSettings.read().roomLayout,
      resolved: resolveRoomLayout({ dataDir, sharedBase: app.getPath('documents'), ownerKey: ownerRoom, privateProfile: prepared.developer || prepared.booth || !!process.env.LCA_DATA_DIR }),
      persist: (layout) => prepared.pluginSettings.update((draft) => { draft.roomLayout = { pathVersion: 2, root: layout.root, ...(layout.folder ? { folder: layout.folder } : {}) } }),
    })
    const roomRoot = roomLayout.root
    const roomProjection = createRoomProjection(roomRoot, store, binaryAssets, clock, ownerRoom)
    scheduler.schedule('room.projection', clock.nowMs() + 30000, () => roomProjection.rebuild(), { everyMs: 60000 })
    const desk = createDesk(join(roomRoot, '书桌'))
    if (restoreReceipt?.status !== 'restored') migrateLegacyDesk({ dataDir, roomRoot, ownerKey: ownerRoom, rows: store.history!() })
    if (restoreReceipt?.status === 'restored') {
      const restoredFiles = new Map(appliedDeskChanges(store.history!()).map((row) => [row.path, row.after] as const))
      for (const [path, text] of restoredFiles) desk.write(path, text)
    }
    const shadow = createDeskShadow({ root: join(dataDir, 'desk-shadows', ownerRoom), deskRoot: join(roomRoot, '书桌'), store })
    heartFlow = createHeartFlow({ store, clock, desk, shadow, booth: prepared.booth, busy: () => harness?.isBusy() ?? false, changed: () => controller?.refresh('task'),
      modelSource: () => prepared.developer ? 'fake' : providers.has('chat') ? 'real' : 'none',
      requestDraft: (text, requestId, hash) => { if (!harness) throw new Error('MODEL_UNAVAILABLE'); harness.send(text, requestId, hash); const id = store!.projection().task?.id; if (!id) throw new Error('MODEL_UNAVAILABLE'); return id },
      cancelTask: (id) => { harness?.stop(id) },
      previewDraft: (view, text) => previewArtifact({ id: view.id, artifactId: view.id, displayName: view.outputPath, kind: 'markdown', status: 'ready', createdAtMs: view.createdAtMs, sourceRefs: [], source: view.source }, text, '用户工作草稿 · 未经审核 · 已产出不表示审查或测试通过。'),
      inspect: (view) => previewArtifact({ id: view.flowId, artifactId: view.flowId, displayName: '心流 · ' + view.section, kind: 'markdown', status: 'ready', createdAtMs: clock.nowMs(), sourceRefs: [], source: prepared.developer ? 'fake' : 'real' }, JSON.stringify(view, null, 2), '用户专用查阅 · 书桌范围 · 每次运行单独审批 · 费用未知时为 null。'),
      prepare: async (id, signal) => { const preparedContext = await memory!.prepareContext(id, signal); const world = life?.view(); if (!world) return preparedContext
        const facts = { role: 'user' as const, content: JSON.stringify({ source: 'autonomous', worldFacts: { locationId: world.locationId, outings: world.outings.slice(-3), items: world.items.slice(-3) }, actualWorks: world.work?.jobs.slice(-6).map(({ id, kind, source, materialId, status, completedSteps, totalSteps, completedAtMs }) => ({ id, kind, source, materialSource: world.work?.materials.find((material) => material.id === materialId)?.source ?? 'unknown', status, completedSteps, totalSteps, completedAtMs })), fictional: true, actualOfflineWork: false }) }
        const insertion = Math.max(0, preparedContext.messages.findLastIndex((message) => message.role === 'user')); const messages = [...preparedContext.messages.slice(0, insertion), facts, ...preparedContext.messages.slice(insertion)]
        return { messages, eligibleIndexes: [...preparedContext.eligibleIndexes.map((index) => index >= insertion ? index + 1 : index), insertion] } }, entered: () => { lifeWork?.foreground(); life?.foreground() }, emit: (id, summary) => { harness?.postEvent('autonomous', summary, id) }, run: (code, signal) => runIsolatedJavaScript(code, systemClock, signal) })
    controller.attachHeartFlow(heartFlow)
    delegates = createDelegates({ store, clock, model: prepared.developer ? createFakeDelegateModel() : taskModels.delegate,
      flowId: () => heartFlow?.active() ? heartFlow.view().activeId : null, read: (path) => heartFlow!.read(path), changed: () => controller?.refresh('task') })
    heartFlow.attachDelegates(delegates)
    const interactiveWorkAllowed = () => !!heartFlow?.active() && heartFlow.view().mode === 'execute' && !heartFlow.view().operations?.some((op) => op.status === 'running') && !store!.projection().lightsOut && !prepared.booth
    computer = createDeskComputer({ store, clock, assets: binaryAssets, allowed: interactiveWorkAllowed,
      flowId: () => heartFlow?.view().activeId ?? null, read: (path) => heartFlow!.read(path), open: openDeskPreview, changed: () => controller?.refresh('task') })
    heartFlow.attachComputer(computer)
    webFetch = createFlowFetch({ store, clock, port: prepared.developer ? { source: 'fake', read: async () => { const text = '<h1>PUBLIC_SYNTHETIC_WEB_WORK</h1><p>This is a synthetic work fixture, not a live website.</p>'; return { text, receivedBytes: Buffer.byteLength(text), truncated: false, contentType: 'text/html' } } } : createPublicWebPort(clock), allowed: interactiveWorkAllowed, flowId: () => heartFlow?.id() ?? null,
      changed: () => controller?.refresh('task'), safeText: (text) => privateCredentials.reduce((clean, key) => key ? clean.replaceAll(key, '[redacted]') : clean, text) })
    heartFlow.attachWebFetch(webFetch)
    scheduler.schedule('computer.guard', clock.nowMs() + 250, () => computer?.stateChanged(), { everyMs: 250 })
    lifeWork = createLifeWork({ store, clock, scheduler, desk, developer: prepared.developer, model: prepared.developer ? createFakeLifeWorkModel() : taskModels.lifeWork,
      available: () => {
        const projection = store!.projection(); const timer = projection.pomodoro
        return !projection.sleeping && !backup?.isBusy() && !harness?.isBusy() && !heartFlow?.active() && !minecraft?.active() && campus?.view().status !== 'scanning' && !documents?.view().jobs.some((job) => job.status === 'processing') && diary?.view().status !== 'writing' && !['extracting', 'compacting'].includes(memory?.view().status ?? '')
          && controller?.getSnapshot().onboarding?.status === 'completed' && life?.view().locationId === 'room'
          && (timer.phase === 'focus' && timer.status === 'running' || !['short-break', 'long-break'].includes(timer.phase) && (life?.view().userSchedule === 'work' || projection.mode !== 'rest'))
      }, changed: () => controller?.refresh('task'), projected: () => { life?.reconcile(); roomProjection.rebuild() },
      open: (path, text, source) => previewArtifact({ id: 'life-work', artifactId: 'life-work', displayName: path.split('/').at(-1)!, kind: 'markdown', status: 'ready', createdAtMs: clock.nowMs(), sourceRefs: [], source }, text, '合成材料作品 · 仅供用户查阅，不注入对话。') })
    controller.attachLifeWork(lifeWork)
    life = createLife({ store, clock, scheduler, work: lifeWork, restored: restoreReceipt?.status === 'restored', working: () => !!harness?.isBusy() || !!heartFlow?.active() || !!lifeWork?.active() || !!minecraft?.active(), changed: () => controller?.refresh('mode'), emit: (id, facts) => { harness?.postEvent('autonomous', facts, id) } })
    controller.attachLife(life)
    sleep = createSleep({ store, canSleep: () => !harness?.isBusy() && !heartFlow?.occupied() && !lifeWork?.active() && !minecraft?.active() && store!.projection().pomodoro.status !== 'running' && life?.view().locationId === 'room' && controller?.getSnapshot().onboarding?.status === 'completed',
      changed: () => { voice?.interrupt(); lifeWork?.foreground(); controller?.refresh('mode') } })
    controller.attachSleep(sleep)
    diary = createDiary({ clock, scheduler, store, assets: binaryAssets, model: prepared.developer ? { source: 'fake', write: async () => ({ entry: diaryPrompts.fake }) } : taskModels.diary, busy: () => !!harness?.isBusy() || !!heartFlow?.active() || !!lifeWork?.active() || !!minecraft?.active(), changed: () => controller?.refresh('task'), projected: () => roomProjection.rebuild() })
    controller.attachDiary(diary, { rebuild: () => { lifeWork?.rebuild(); roomProjection.rebuild() }, open: () => { void shell.openPath(roomProjection.root) } })
    optical = createOpticalMemory({ root: dataDir, store, clock, assets: binaryAssets, developer: prepared.developer, render: (text, signal) => renderOpticalPage(text, systemClock, signal),
      choose: async () => { const selected = await dialog.showOpenDialog({ title: '导入光学解码配置（地址与凭据仅在主进程）', properties: ['openFile'], filters: [{ name: '光学服务配置', extensions: ['json'] }] }); return selected.canceled ? null : selected.filePaths[0] ?? null },
      available: () => !harness?.isBusy() && !heartFlow?.active() && !lifeWork?.active() && !minecraft?.active() && !backup?.isBusy() && controller?.getSnapshot().onboarding?.status === 'completed',
      changed: () => controller?.refresh('task'), protectCredential: (value) => { if (value && !privateCredentials.includes(value)) privateCredentials.push(value) } })
    controller.attachOptical(optical)
    notifications = createNotifications({ clock, store, scheduler, synthetic: prepared.developer || prepared.booth, candidates: () => campus!.candidates(), approval: () => heartFlow?.view().pending?.id ?? computer?.view().pending?.id ?? webFetch?.view().pending?.id, changed: () => controller?.refresh('connection'),
      notify: ({ title, body }) => { if (prepared.developer || prepared.booth || !Notification.isSupported()) return; const notification = new Notification({ title, body, silent: true }); notification.on('click', () => { const view = controller!.getSnapshot(); controller!.dispatch({ protocolVersion: 1, requestId: randomUUID(), epoch: view.epoch, type: 'window.expand' }) }); notification.show() } })
    controller.attachNotifications(notifications)
    character = createCharacterService({ library: characterLibrary, active: activeCharacter, settings: prepared.pluginSettings, assets: binaryAssets, busy: () => !!harness?.isBusy() || !!heartFlow?.active() || !!backup?.isBusy(), changed: () => controller?.refresh('connection'),
      exportBuiltin: () => exportBuiltinCharacter(join(__dirname, '../renderer')),
      normalizePng: (bytes) => { const image = nativeImage.createFromBuffer(bytes); if (image.isEmpty()) throw new Error('CHARACTER_IMAGE_INVALID'); return image.toPNG() },
      chooseImport: async () => { const result = await dialog.showOpenDialog({ title: '导入静态角色包', properties: ['openFile'], filters: [{ name: '角色包', extensions: ['lca-character'] }] }); return result.canceled ? null : result.filePaths[0] ?? null },
      chooseExport: async () => { const result = await dialog.showSaveDialog({ title: '导出静态角色包（不含私人资料）', defaultPath: 'character.lca-character', filters: [{ name: '角色包', extensions: ['lca-character'] }] }); return result.canceled ? null : result.filePath ?? null } })
    controller.attachCharacter(character)
    plugins.registerBuiltin('notifications', '急件与提醒标准', notificationTools(notifications))
    plugins.registerBuiltin('coding', '书桌编码', [...deskTools(heartFlow), ...delegates.tools, ...computer.tools(), ...webFetch.tools])
    plugins.registerBuiltin('life-work', '自主阅读与写作', [])
    plugins.registerBuiltin('optical-memory', '可选光学记忆', [optical.tool()])
    plugins.registerBuiltin('mcp', '外部 MCP 工具连接', [])
    if (prepared.developer) plugins.registerBuiltin('developer', '开发调试 MCP', [])
    plugins.discover()
    const modelReady = prepared.developer || providers.has('chat')
    if (prepared.developer) mcpFixture = await startMcpFixture(clock)
    mcp = createMcpService({ clock, configPath: process.env.LCA_MCP_CONFIG ?? join(dataDir, 'connections/mcp.json'), source: prepared.developer ? 'fake' : 'real',
      privacyModel: prepared.developer ? createFakePrivacyModel() : taskModels.narrow, developmentConfig: mcpFixture?.config,
      chooseConfig: async () => { const selected = await dialog.showOpenDialog({ title: '导入 MCP 配置（配置仅由主进程读取）', properties: ['openFile'], filters: [{ name: 'MCP 配置', extensions: ['json'] }] }); return selected.canceled ? null : selected.filePaths[0] ?? null },
      confirmConnection: async (id, config) => {
        // Show the exact launch target only in a native, user-only dialog, never in renderer/debug projections.
        const detail = 'command' in config ? ['程序：' + config.command, '参数（JSON 数组）：' + JSON.stringify(config.args), '工作目录：' + (config.cwd ?? '应用默认目录'), '环境变量名：' + Object.keys(config.env).join(', ')].join('\n') : '服务地址：' + config.url
        const selected = await dialog.showMessageBox({ type: 'question', title: '核对 MCP 启动配置', message: '是否连接 ' + id + '？', detail, buttons: ['取消', '连接此配置'], defaultId: 0, cancelId: 0, noLink: true })
        return selected.response === 1
      },
      beforeDisconnect: async (id) => { if (minecraft?.view().serverId === id) await minecraft.stop() },
      canConfigure: () => !harness?.isBusy() && !minecraft?.active(), changed: () => { minecraft?.stateChanged(); controller?.refresh('connection') } })
    controller.attachMcp(mcp)
    const round = store.history!().findLast((row) => row.type === 'minecraft/round')
    minecraft = createMinecraft({ clock, scheduler, protocol: (id) => {
      const protocol = mcp?.protocol(id); if (!protocol) return
      return { ...protocol, identifierAllowed: (value) => protocol.identifierAllowed(value) && !privateCredentials.some((credential) => credential && value.includes(credential)),
        text: (value) => privateCredentials.reduce((text, credential) => credential ? text.replaceAll(credential, '[redacted]') : text, protocol.text(value)) }
    }, source: (id) => mcp?.view().servers.find((server) => server.id === id)?.source ?? 'none',
      interrupted: restoreReceipt?.status !== 'restored' && round?.type === 'minecraft/round' && !round.stopVerified ? round : undefined,
      blocked: () => { const projection = store!.projection(); return projection.lightsOut || projection.mode === 'quiet' || projection.pomodoro.phase === 'focus' && projection.pomodoro.status === 'running' || !!heartFlow?.active() || !!minecraft?.view().serverId && !mcp?.protocol(minecraft.view().serverId!) },
      available: () => (prepared.developer || prepared.booth) && !harness?.isBusy() && !lifeWork?.active() && !backup?.isBusy() && minecraftChat?.ready() !== false && life?.view().locationId === 'room',
      stopping: () => { void minecraftChat?.end() }, events: (messages) => minecraftChat?.events(messages),
      record: (receipt) => {
        store!.append({ type: 'minecraft/round', ...receipt })
        if (receipt.status === 'started') { memory?.foreground(); diary?.foreground(); lifeWork?.foreground(); optical?.foreground(); minecraftChat?.begin(receipt.roundId) }
        else if (receipt.stopVerified) {
          const view = minecraft!.view()
          harness?.postEvent('autonomous', JSON.stringify({ kind: 'minecraft-round-ended', source: view.source, actionsAttempted: view.actionsUsed, stopVerified: true, lastAction: view.lastAction ?? null, authority: 'attempt-count-and-observed-status-only' }), 'minecraft-ended:' + receipt.roundId)
        }
      },
      changed: () => controller?.refresh('task') })
    minecraftChat = createMinecraftChat({ root: join(dataDir, 'minecraft'), clock, mainStore: store, budget: resourceBudget, model: prepared.scripted?.model ?? createModelClient(providers, ['chat'], clock, fetch, { scope: 'game', resolve: (ref) => minecraftChat!.resolveImage(ref) }), game: () => minecraft!, enabled: () => modelReady, normalizePixels: normalizeGamePixels,
      // 游戏一轮每次调用都带人设并按字节计入展位预算：用短人设，不带整份正文
      persona: () => ({ name: controller!.getSnapshot().onboarding?.characterName ?? '桃子', persona: briefPersona(activeCharacter) }), credentials: privateCredentials, changed: () => controller?.refresh('message') })
    controller.attachMinecraft(minecraft, minecraftChat, mcpFixture ? (scenario) => mcpFixture!.game.select(scenario) : undefined)
    harness = createHarness({ store, clock, budget: resourceBudget, model: prepared.scripted?.model ?? createModelClient(providers, ['chat'], clock, fetch, { resolve: (ref) => computer!.resolve(ref) }), tools: [], getTools: () => heartFlow?.active() ? plugins.tools().filter((tool) => ['clock.read', 'plan.update'].includes(tool.templateId) || tool.templateId.startsWith('desk')) : [...plugins.tools().filter((tool) => !tool.templateId.startsWith('desk') && (tool.templateId !== 'memory.optical' || !!optical?.enabled())), ...(mcp?.tools() ?? [])], enabled: () => modelReady, changed: (reason) => controller?.refresh(reason), backgroundQuiet: () => !!heartFlow?.active() || !!minecraft?.active(),
      prepareContext: async (id, signal) => { const preparedContext = await heartFlow!.prepareContext(id, signal); if (!heartFlow!.active()) return recall!.prepare(id, preparedContext)
        const seen = new Set<string>(); const messages = preparedContext.messages.slice().reverse().map((message) => { if (!message.imageRefs) return message; const imageRefs = message.imageRefs.filter((ref) => { if (seen.has(ref) || seen.size >= 2) return false; seen.add(ref); return true }); return { ...message, imageRefs } }).reverse(); return { ...preparedContext, messages }
      }, foreground: () => { memory?.foreground(); diary?.foreground(); lifeWork?.foreground(); optical?.foreground() }, userWork: () => { sleep?.wake(); life?.foreground() },
      settled: () => { heartFlow?.settled(); voice?.observe() }, failed: () => { console.error('Execution stopped: local storage unavailable.'); app.quit() } })
    const voiceConfig = prepared.developer ? null : await readVoiceConfig(providersFile)
    voice = createVoice({ store, clock, budget: resourceBudget, port: prepared.developer ? createFakeVoice(clock) : voiceConfig ? createSpeechPort(voiceConfig) : null,
      blocked: () => { const p = store!.projection(); return p.sleeping || p.lightsOut || p.mode === 'quiet' || p.pomodoro.phase === 'focus' || !!heartFlow?.active() || !!minecraft?.active() || !!backup?.isBusy() || !!bookWindow && !bookWindow.isVisible() },
      changed: () => controller?.refresh('connection'), safeText: (text) => privateCredentials.reduce((clean, key) => key ? clean.replaceAll(key, '[redacted]') : clean, text) })
    controller.attachVoice(voice)
    scheduler.schedule('voice.guard', clock.nowMs() + 250, () => voice?.stateChanged(), { everyMs: 250 })
    controller.attachExecution(harness, modelReady)
    modelSettings = createModelSettings({ root: dataRoot, developer: prepared.developer, slots: [...providers.keys()], canConfigure: () => !harness?.isBusy() && !backup?.isBusy(),
      choose: async () => { const selected = await dialog.showOpenDialog({ title: '导入模型槽位配置（内容仅由主进程读取）', properties: ['openFile'], filters: [{ name: '模型配置', extensions: ['json'] }] }); return selected.canceled ? null : selected.filePaths[0] ?? null }, changed: () => controller?.refresh('connection') })
    controller.attachModelSettings(modelSettings)
    backup = createBackupService({ root: dataDir, store, clock, source: prepared.developer ? 'fake' : 'real', fileFilteringEnabled: () => prepared.pluginSettings.read().fileFilteringEnabled, credentials: privateCredentials, onboarding: () => controller!.getSnapshot().onboarding!,
      canStart: () => !harness!.isBusy() && !heartFlow?.active() && !minecraft?.active() && campus!.view().status !== 'scanning' && !documents!.view().jobs.some((job) => job.status === 'processing'),
      freeze: async () => { scheduler!.pauseBackground(true); voice?.interrupt(); memory!.foreground(); diary?.foreground(); lifeWork?.foreground(); optical?.foreground(); await Promise.all([memory!.idle(), diary?.idle(), photos?.idle(), lifeWork?.idle(), optical?.idle()]); if (harness!.isBusy() || campus!.view().status === 'scanning' || documents!.view().jobs.some((job) => job.status === 'processing')) { scheduler!.pauseBackground(store!.projection().lightsOut); throw new Error('BACKUP_BUSY') }; return () => { scheduler!.pauseBackground(store!.projection().lightsOut); pomodoro?.reconcile() } },
      chooseExport: async (name) => { const selected = await dialog.showSaveDialog({ title: '导出私人存档', defaultPath: name, filters: [{ name: '私人存档', extensions: ['lca-save'] }] }); return selected.canceled ? null : selected.filePath ?? null },
      chooseImport: async () => { const selected = await dialog.showOpenDialog({ title: '选择私人存档', properties: ['openFile'], filters: [{ name: '私人存档', extensions: ['lca-save'] }] }); return selected.canceled ? null : selected.filePaths[0] ?? null },
      restart: () => { systemClock.after(100, () => { app.relaunch(); app.quit() }) }, changed: () => controller?.refresh('restore') })
    controller.attachBackup(backup)
    quill = createQuillService({ clock, store, scheduler, artifacts, memory: memoryRepository, isBusy: () => !!harness?.isBusy() || !!minecraft?.active(), emit: (source, text, id) => harness?.postEvent(source, text, id), changed: () => controller?.refresh('task') })
    controller.attachQuill(quill)
    const rodinConfig = prepared.developer ? null : await readRodinConfig(providersFile)
    const rodinApi = prepared.developer ? { submit: async () => ({ uuid: randomUUID(), subscription_key: 'synthetic-private-handle' }), poll: async () => 'ready' as const, download: async () => syntheticGlb() } : rodinConfig ? createRodinApi(rodinConfig, clock) : null
    const rodinPort = rodinApi ? await createRodinMcp(rodinApi, binaryAssets, dataDir, clock) : null
    gifts = createGiftService({ clock, store, scheduler, memory: memoryRepository, port: rodinPort, source: prepared.developer ? 'fake' : 'real', changed: () => controller?.refresh('task'),
      open: (ref) => { const asset = binaryAssets.owned(ref.slice(6)); if (!asset) throw new Error('ASSET_UNAVAILABLE'); void shell.openPath(join(dataDir, assetPath(asset))) } })
    controller.attachGifts(gifts)
    plugins.registerBuiltin('gifts', '礼物与生成', [...quillTools(quill), ...giftTools(gifts)])
    controller.attachDiagnostics(() => buildDiagnostics({ clock, store: store!, scheduler: scheduler!, memory: memoryRepository!, fileFilteringEnabled: prepared.pluginSettings.read().fileFilteringEnabled, mailStatus: campus!.view().status,
      pendingFiles: documents!.view().jobs.filter((job) => ['staged', 'queued', 'processing'].includes(job.status)).length }))
    controller.attachPomodoro(pomodoro, () => plugins.views().some((item) => item.id === 'pomodoro' && item.status === 'enabled'))
    plugins.mountService('pomodoro', (enabled) => { if (enabled) pomodoro?.reconcile(); else pomodoro?.pause() })
    plugins.mountService('mail', (enabled) => campus?.setEnabled(enabled))
    plugins.mountService('documents', (enabled) => documents?.setEnabled(enabled))
    plugins.mountService('memory', (enabled) => memory?.setEnabled(enabled))
    plugins.mountService('history', (enabled) => { recall?.setEnabled(enabled); photos?.setEnabled(enabled) })
    plugins.mountService('mcp', (enabled) => mcp?.setEnabled(enabled))
    plugins.mountService('gifts', (enabled) => gifts?.setEnabled(enabled))
    plugins.mountService('coding', (enabled) => heartFlow?.setEnabled(enabled))
    plugins.mountService('life-work', (enabled) => lifeWork?.setEnabled(enabled))
    plugins.mountService('optical-memory', (enabled) => optical?.setPluginEnabled(enabled))
    plugins.mountService('notifications', (enabled) => notifications?.setEnabled(enabled))
    if (prepared.scene?.preset === 'pomodoro-demo' && store.records().length <= 2) pomodoro.propose({ label: '开发演示', plannedCount: 2, focusDurationMs: 60_000, shortBreakDurationMs: 20_000, longBreakDurationMs: 20_000, longBreakEvery: 4, timing: 'demo' }, 'user')
    harness.stateChanged()
    scheduler.schedule('ui.snapshot', clock.nowMs() + 1000, () => { minecraft?.stateChanged(); controller?.refresh('timer') }, { everyMs: 1000, background: false })
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
app.on('window-all-closed', () => { if (process.platform !== 'darwin' && !process.argv.some((arg) => arg.startsWith('--lca-probe='))) app.quit() })
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
    heartFlow?.close()
    life?.close()
    notifications?.close()
    const closeCampus = campus?.close()
    const closeDocuments = documents?.close()
    const closeMemory = memory?.close()
    scheduler?.dispose()
    const closeGame = (async () => { await minecraft?.close(); await minecraftChat?.end(); await mcp?.close() })()
    // Keep the development clock alive until every service has finished its cancellation/release RPCs.
    void Promise.all([harness.dispose(), closeCampus, closeDocuments, closeMemory, closeGame, gifts?.close(), backup?.close(), modelSettings?.close(), diary?.close(), character?.close(), photos?.close(), lifeWork?.close(), delegates?.close(), optical?.close(), voice?.close()]).then(() => runtime?.close()).then(() => mcpFixture?.close()).catch(() => { console.error('Shutdown interrupted; durable data preserved.') }).finally(() => { controller?.dispose(); bridge?.dispose(); memoryRepository?.close(); documentVault?.close(); vault?.close(); store?.close(); resourceBudget?.close(); storageClosed = true; app.quit() })
  } else if (!storageClosed) { scheduler?.dispose(); controller?.dispose(); bridge?.dispose(); store?.close(); resourceBudget?.close(); storageClosed = true }
})
