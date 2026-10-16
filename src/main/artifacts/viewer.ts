import { BrowserWindow } from 'electron'
import type { DeliveryView } from '../../shared'

const escape = (value: string) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;')
/** User-only preview of already verified bytes. No bridge, Node, links or file path API. */
export function previewArtifact(view: DeliveryView, content: string, description = '仅本地文件，未写入外部日历。'): void {
  const window = new BrowserWindow({ width: 900, height: 700, title: view.displayName, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } })
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event) => event.preventDefault())
  const html = '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'"><title>' + escape(view.displayName) + '</title><style>body{margin:24px;font-family:system-ui;color:#29251e;background:#faf7ed}pre{white-space:pre-wrap;overflow-wrap:anywhere}p{color:#765f39}</style><h1>' + escape(view.displayName) + '</h1><p>' + (view.source === 'fake' ? '合成数据 · ' : '') + escape(description) + '</p><pre>' + escape(content) + '</pre></html>'
  void window.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html)).catch(() => { window.close() })
}
