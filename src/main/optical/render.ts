import { BrowserWindow, session } from 'electron'
import { randomUUID } from 'node:crypto'
import type { Clock } from '../clock'
const escape = (value: string) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')
/** A separate print page, not a scene screenshot. No app preload, remote fonts, links, forms or network. */
export async function renderOpticalPage(text: string, clock: Clock, signal: AbortSignal): Promise<Buffer> {
  signal.throwIfAborted()
  const isolated = session.fromPartition('optical-' + randomUUID())
  isolated.setPermissionRequestHandler((_contents, _permission, answer) => answer(false)); isolated.setPermissionCheckHandler(() => false)
  isolated.webRequest.onBeforeRequest((request, answer) => answer({ cancel: !request.url.startsWith('data:text/html,') }))
  const window = new BrowserWindow({ width: 1280, height: 1280, useContentSize: true, show: false, webPreferences: { session: isolated, sandbox: true, contextIsolation: true, nodeIntegration: false, devTools: false, backgroundThrottling: false, zoomFactor: 1 } })
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' })); window.webContents.on('will-navigate', (event) => event.preventDefault()); window.webContents.on('will-frame-navigate', (event) => event.preventDefault())
  let stop = () => {}; let remove = () => {}
  try {
    const cancelled = new Promise<never>((_resolve, reject) => {
      const abort = () => { if (!window.isDestroyed()) window.destroy(); reject(new Error('OPTICAL_RENDER_STOPPED')) }
      signal.addEventListener('abort', abort, { once: true }); remove = () => signal.removeEventListener('abort', abort); stop = clock.after(5000, abort); if (signal.aborted) abort()
    })
    const render = async () => {
      const html = '<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'; form-action \'none\'; base-uri \'none\'"><style>html,body{margin:0;width:1280px;height:1280px;background:white;color:black;overflow:hidden}pre{box-sizing:border-box;margin:0;padding:60px;width:1280px;height:1280px;font:26px/44px "Microsoft YaHei",sans-serif;white-space:pre}</style><pre>' + escape(text) + '</pre>'
      await window.loadURL('data:text/html,' + encodeURIComponent(html))
      await window.webContents.executeJavaScript('document.fonts.ready.then(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))')
      const overflow: boolean = await window.webContents.executeJavaScript('document.querySelector("pre").scrollHeight > 1280 || document.querySelector("pre").scrollWidth > 1280')
      if (overflow) throw new Error('OPTICAL_RENDER_OVERFLOW')
      const image = await window.webContents.capturePage({ x: 0, y: 0, width: 1280, height: 1280 }, { stayHidden: true })
      if (image.isEmpty()) throw new Error('OPTICAL_RENDER_EMPTY')
      return image.resize({ width: 1280, height: 1280 }).toPNG()
    }
    const png = await Promise.race([render(), cancelled]); signal.throwIfAborted(); return png
  } finally { stop(); remove(); if (!window.isDestroyed()) window.destroy(); void isolated.clearStorageData().catch(() => {}) }
}
