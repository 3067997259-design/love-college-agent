import { app, BrowserWindow, powerMonitor } from 'electron'
import { join, resolve } from 'node:path'
import { mkdirSync } from 'node:fs'
import { systemClock } from './clock'
import { createAppController } from './bridge/controller'
import { registerAppBridge } from './bridge/ipc'
import { probeSqlite } from './validation/sqlite'
import { probeImap } from './mail/probe'
import { openSessionStore, type SessionStore } from './store/session'
import { probeJournal } from './validation/journal'
import { probeModel } from './validation/model'
import { readModelProviders } from './config/providers'
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

const dataRoot = resolve(process.env.LCA_DATA_DIR ?? (app.isPackaged ? app.getPath('userData') : join(process.cwd(), '.local-data')))
const prepared = prepareRuntime(dataRoot, systemClock, process.env.LCA_BOOTH === '1')
const { clock } = prepared
const dataDir = prepared.profile.path
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

function createWindow(): void {
  const window = new BrowserWindow({
    width: 1200, height: 800, show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      sandbox: true, contextIsolation: true, nodeIntegration: false,
    },
  })
  bridge!.attach(window)
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
  if (process.argv.includes('--lca-probe=harness')) {
    const report = await probeHarness(dataDir, process.env.LCA_PROVIDERS_FILE ?? join(app.getAppPath(), 'secrets/providers.json'), systemClock)
    console.log('LCA_PROBE:' + JSON.stringify(report))
    app.exit(report.ok ? 0 : 1)
    return
  }
  if (process.argv.includes('--lca-probe=model')) {
    const report = await probeModel(process.env.LCA_PROVIDERS_FILE ?? join(app.getAppPath(), 'secrets/providers.json'), systemClock)
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
    const report = await probeImap(process.env.LCA_PROVIDERS_FILE ?? join(app.getAppPath(), 'secrets/providers.json'))
    console.log('LCA_PROBE:' + JSON.stringify(report))
    app.exit(report.ok ? 0 : 1)
    return
  }
  try {
    store = openSessionStore(dataDir, { userId: 'local-user', characterId: 'default-character' }, clock)
    if (prepared.scene && store.records().length === 1) store.append({ type: 'companion/mode', mode: prepared.scene.mode, requestId: 'development-scene', commandHash: 'development-scene' })
    controller = createAppController(clock, undefined, store)
    bridge = registerAppBridge(controller)
    scheduler = createScheduler(clock, () => { console.error('Scheduler stopped: local operation failed.'); app.quit() })
    pomodoro = createPomodoro({ clock, store, scheduler, changed: () => controller?.refresh('timer'), stateChanged: () => harness?.stateChanged(),
      emit: (id, text) => { harness?.postEvent('pomodoro', text, id) } })
    const plugins = createPluginRegistry({ root: join(dataDir, 'plugins'), settings: prepared.pluginSettings, privacyModel: prepared.developer ? createFakePrivacyModel() : null })
    plugins.registerBuiltin('core', '时钟与任务计划', builtinTools())
    plugins.registerBuiltin('pomodoro', '番茄钟', pomodoroTools(pomodoro))
    if (prepared.developer) plugins.registerBuiltin('developer', '开发调试 MCP', [])
    plugins.discover()
    const providers = prepared.developer ? new Map() : await readModelProviders(process.env.LCA_PROVIDERS_FILE ?? join(app.getAppPath(), 'secrets/providers.json'))
    const modelReady = prepared.developer || providers.has('chat')
    harness = createHarness({ store, clock, model: prepared.scripted?.model ?? createModelClient(providers, ['chat'], clock), tools: [], getTools: plugins.tools, enabled: () => modelReady, changed: (reason) => controller?.refresh(reason),
      failed: () => { console.error('Execution stopped: local storage unavailable.'); app.quit() } })
    controller.attachExecution(harness, modelReady)
    controller.attachPomodoro(pomodoro, () => plugins.views().some((item) => item.id === 'pomodoro' && item.status === 'enabled'))
    plugins.mountService('pomodoro', (enabled) => { if (enabled) pomodoro?.reconcile(); else pomodoro?.pause() })
    if (prepared.scene?.preset === 'pomodoro-demo' && store.records().length <= 2) pomodoro.propose({ label: '开发演示', plannedCount: 2, focusDurationMs: 60_000, shortBreakDurationMs: 20_000, longBreakDurationMs: 20_000, longBreakEvery: 4, timing: 'demo' }, 'user')
    harness.stateChanged()
    scheduler.schedule('ui.snapshot', clock.nowMs() + 1000, () => controller?.refresh('timer'), { everyMs: 1000, background: false })
    runtime = await attachRuntime({ prepared, controller, plugins, harness, scheduler, store,
      mcpPort: Number(process.env.LCA_MCP_PORT ?? 5175), cdpPort,
      restart: () => { systemClock.after(100, () => { app.relaunch(); app.quit() }) } })
    powerMonitor.on('resume', () => { pomodoro?.reconcile(); scheduler?.reconcile() })
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
    scheduler?.dispose()
    void Promise.all([harness.dispose(), runtime?.close()]).finally(() => { controller?.dispose(); bridge?.dispose(); store?.close(); storageClosed = true; app.quit() })
  } else if (!storageClosed) { scheduler?.dispose(); controller?.dispose(); bridge?.dispose(); store?.close(); storageClosed = true }
})
