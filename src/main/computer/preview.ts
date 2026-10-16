import { app, BrowserWindow, session } from 'electron'
import { randomUUID, createHash } from 'node:crypto'
import type { DeskComputerAction } from '../../shared'
export interface ComputerPort {
  capture(): Promise<{ png: Buffer; fingerprint: string }>
  fingerprint(): Promise<string>
  act(action: DeskComputerAction): Promise<void>
  close(): void
}
/** Static HTML only: no page script, network, Node, bridge, subframe, navigation, download or permission. */
export async function openDeskPreview(html: string, onClosed: () => void, signal: AbortSignal): Promise<ComputerPort> {
  if (app.commandLine.hasSwitch('no-sandbox')) throw new Error('PREVIEW_UNAVAILABLE')
  const partition = session.fromPartition('desk-preview-' + randomUUID()); partition.setPermissionCheckHandler(() => false); partition.setPermissionRequestHandler((_wc, _permission, done) => done(false))
  partition.on('will-download', (event) => event.preventDefault())
  const policy = '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'none\'; style-src \'unsafe-inline\'; img-src data:; connect-src \'none\'; frame-src \'none\'; worker-src \'none\'; object-src \'none\'; form-action \'none\'; base-uri \'none\'">'
  const url = 'data:text/html;charset=utf-8,' + encodeURIComponent(policy + html)
  partition.webRequest.onBeforeRequest((request, done) => done({ cancel: !(request.url === url && request.resourceType === 'mainFrame') && !request.url.startsWith('data:image/') }))
  const window = new BrowserWindow({ title: '书桌静态预览 · 脚本与网络关闭', width: 800, height: 600, useContentSize: true, show: false, resizable: false, webPreferences: { session: partition, sandbox: true, contextIsolation: true, nodeIntegration: false, nodeIntegrationInWorker: false, webviewTag: false, webSecurity: true, devTools: false, backgroundThrottling: false } })
  window.setMenu(null); window.webContents.setWindowOpenHandler(() => ({ action: 'deny' })); window.webContents.on('will-navigate', (event) => event.preventDefault()); window.webContents.on('will-frame-navigate', (event) => event.preventDefault())
  window.once('closed', () => { onClosed(); void partition.clearStorageData().catch(() => {}) })
  const aborted = () => { if (!window.isDestroyed()) window.destroy() }; signal.addEventListener('abort', aborted, { once: true }); window.once('closed', () => signal.removeEventListener('abort', aborted)); if (signal.aborted) aborted()
  const check = () => { if (window.isDestroyed() || window.webContents.isDestroyed() || window.webContents.getURL() !== url) throw new Error('PREVIEW_UNAVAILABLE') }
  // DOM attributes alone omit nested scrolling, text caret/selection and native
  // control state. Keep these in the same observation that owns the screenshot.
  const fingerprint = async () => { check(); const value: unknown = await window.webContents.executeJavaScript(`(() => {
    const elements = [...document.querySelectorAll('*')]; const nodes = [];
    const walker = document.createTreeWalker(document, NodeFilter.SHOW_ALL);
    while (walker.nextNode()) nodes.push(walker.currentNode);
    const selection = getSelection();
    return JSON.stringify({ html: document.documentElement.outerHTML,
      fields: [...document.querySelectorAll('input,textarea,select')].map(e => [e.tagName,e.value,e.checked,e.selectionStart,e.selectionEnd,e.selectionDirection,e.selectedIndex]),
      focus: elements.indexOf(document.activeElement),
      elements: elements.map(e => { const r = e.getBoundingClientRect(); return [e.scrollLeft,e.scrollTop,r.x,r.y,r.width,r.height] }),
      selection: selection ? [nodes.indexOf(selection.anchorNode),selection.anchorOffset,nodes.indexOf(selection.focusNode),selection.focusOffset] : null,
      scroll: [scrollX,scrollY], size: [innerWidth,innerHeight] });
  })()`); if (typeof value !== 'string' || value.length > 200000) throw new Error('PREVIEW_UNAVAILABLE'); return createHash('sha256').update(value).digest('hex') }
  try { await window.loadURL(url); await window.webContents.insertCSS('*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}', { cssOrigin: 'user' }); await window.webContents.executeJavaScript('for(const e of document.querySelectorAll("input[type=file]"))e.disabled=true'); window.webContents.setZoomFactor(1); window.show() }
  catch { if (!window.isDestroyed()) window.destroy(); throw new Error('PREVIEW_UNAVAILABLE') }
  return {
    fingerprint,
    capture: async () => { check(); await window.webContents.executeJavaScript('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))'); check(); const state = await fingerprint(); const image = await window.webContents.capturePage(); check(); if (await fingerprint() !== state) throw new Error('PREVIEW_CHANGED'); const png = image.resize({ width: 800, height: 600, quality: 'good' }).toPNG(); if (png.length > 131072 || png.length < 33) throw new Error('PREVIEW_UNAVAILABLE'); return { png, fingerprint: state } },
    act: async (action) => { check(); window.focus(); if (action.type === 'click') { window.webContents.sendInputEvent({ type: 'mouseMove', x: action.x, y: action.y }); window.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, x: action.x, y: action.y }); window.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, x: action.x, y: action.y }) }
      else if (action.type === 'type') await window.webContents.insertText(action.text)
      else { const keyCode = { TAB: 'Tab', ENTER: 'Enter', ESCAPE: 'Escape', BACKSPACE: 'Backspace' }[action.key]; window.webContents.sendInputEvent({ type: 'keyDown', keyCode }); window.webContents.sendInputEvent({ type: 'keyUp', keyCode }) } },
    close: () => { if (!window.isDestroyed()) window.destroy() },
  }
}
