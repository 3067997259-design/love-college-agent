import { app, BrowserWindow } from 'electron'
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

const dataDir = resolve(process.env.LCA_DATA_DIR ?? join(process.cwd(), '.local-data'))
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
    store = openSessionStore(dataDir, { userId: 'local-user', characterId: 'default-character' }, systemClock)
    controller = createAppController(systemClock, undefined, store)
    bridge = registerAppBridge(controller)
    const providers = await readModelProviders(process.env.LCA_PROVIDERS_FILE ?? join(app.getAppPath(), 'secrets/providers.json'))
    harness = createHarness({ store, clock: systemClock, model: createModelClient(providers, ['chat'], systemClock), tools: builtinTools(), changed: (reason) => controller?.refresh(reason),
      failed: () => { console.error('Execution stopped: local storage unavailable.'); app.quit() } })
    controller.attachExecution(harness, providers.has('chat'))
  } catch {
    console.error('Application storage unavailable; existing data preserved.')
    app.exit(1)
    return
  }
  controller.start()
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
    void harness.dispose().finally(() => { controller?.dispose(); bridge?.dispose(); store?.close(); storageClosed = true; app.quit() })
  } else if (!storageClosed) { controller?.dispose(); bridge?.dispose(); store?.close(); storageClosed = true }
})
