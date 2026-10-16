import { app, BrowserWindow, session } from 'electron'
import { randomUUID } from 'node:crypto'
import type { Clock } from '../clock'

/** Disposable OS-sandboxed Chromium renderer. No preload, IPC registration, Node, network or filesystem broker. */
export async function runIsolatedJavaScript(code: string, clock: Clock, signal: AbortSignal): Promise<string> {
  if (app.commandLine.hasSwitch('no-sandbox') || code.length > 10_000 || signal.aborted) throw new Error('EXECUTOR_UNAVAILABLE')
  const isolated = session.fromPartition('flow-' + randomUUID())
  isolated.setPermissionRequestHandler((_contents, _permission, respond) => respond(false))
  isolated.setPermissionCheckHandler(() => false)
  isolated.on('will-download', (event) => event.preventDefault())
  isolated.webRequest.onBeforeRequest((details, respond) => respond({ cancel: !details.url.startsWith('data:text/html,') }))
  const window = new BrowserWindow({ show: false, webPreferences: { session: isolated, sandbox: true, contextIsolation: true, nodeIntegration: false, nodeIntegrationInWorker: false, webviewTag: false, webSecurity: true, devTools: false, backgroundThrottling: false } })
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event) => event.preventDefault())
  window.webContents.on('will-frame-navigate', (event) => event.preventDefault())
  let remove = () => {}; let cancel = () => {}
  try {
    await window.loadURL('data:text/html,' + encodeURIComponent('<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'none\'; connect-src \'none\'; frame-src \'none\'; worker-src blob:; form-action \'none\'; base-uri \'none\'">'))
    const stopped = new Promise<never>((_resolve, reject) => { const stop = () => { if (!window.isDestroyed()) { window.webContents.forcefullyCrashRenderer(); window.destroy() }; reject(new Error('EXECUTION_STOPPED')) }; signal.addEventListener('abort', stop, { once: true }); remove = () => signal.removeEventListener('abort', stop); cancel = clock.after(5000, stop); if (signal.aborted) stop() })
    // Untrusted code only runs in a worker: no DOM, frames, window, or Window-only WebRTC APIs.
    const script = 'const send = postMessage.bind(globalThis); const serialize = JSON.stringify.bind(JSON); const cut = Function.call.bind(String.prototype.slice); (async () => { const result = await (async () => {\n' + code + '\n})(); send(cut(serialize(result) ?? "null", 0, 16000)); })().catch(() => { throw new Error("EXECUTION_FAILED") })'
    const launch = 'new Promise((resolve, reject) => { const url = URL.createObjectURL(new Blob([' + JSON.stringify(script) + '], {type:"text/javascript"})); const worker = new Worker(url); worker.onmessage = (event) => { worker.terminate(); URL.revokeObjectURL(url); if (typeof event.data !== "string" || event.data.length > 16000) reject(new Error("EXECUTION_FAILED")); else resolve(event.data) }; worker.onerror = () => { worker.terminate(); URL.revokeObjectURL(url); reject(new Error("EXECUTION_FAILED")) } })'
    const output: unknown = await Promise.race([window.webContents.executeJavaScript(launch), stopped])
    if (typeof output !== 'string' || output.length > 16_000) throw new Error('EXECUTOR_INVALID')
    return output
  } finally { remove(); cancel(); if (!window.isDestroyed()) window.destroy(); await isolated.clearStorageData() }
}
