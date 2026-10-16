import { app, BrowserWindow } from 'electron'
import { join, resolve } from 'node:path'
import { mkdirSync } from 'node:fs'
import { systemClock } from './clock'
import { createAppController } from './bridge/controller'
import { registerAppBridge } from './bridge/ipc'
import { probeSqlite } from './validation/sqlite'

const dataDir = resolve(process.env.LCA_DATA_DIR ?? join(process.cwd(), '.local-data'))
mkdirSync(dataDir, { recursive: true })
mkdirSync(join(dataDir, 'chromium'), { recursive: true })
app.setPath('userData', dataDir)
app.setPath('sessionData', join(dataDir, 'chromium'))
const controller = createAppController(systemClock)
const bridge = registerAppBridge(controller)

function createWindow(): void {
  const window = new BrowserWindow({
    width: 1200, height: 800, show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      sandbox: true, contextIsolation: true, nodeIntegration: false,
    },
  })
  bridge.attach(window)
  window.once('ready-to-show', () => window.show())
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event) => event.preventDefault())
  if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL) {
    void window.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void window.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

void app.whenReady().then(() => {
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
  controller.start()
  createWindow()
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow() })
})
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
app.on('before-quit', () => { controller.dispose(); bridge.dispose() })
