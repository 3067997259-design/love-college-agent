import type { BrowserWindow } from 'electron'
import type { Clock } from '../clock'
const activeCaptures = new WeakSet<object>()

/** Main selects a fixed scene root. No renderer-provided rectangles, pixels, paths or selectors. */
export async function captureHistoryScene(window: BrowserWindow | undefined, sessionId: string, clock: Clock) {
  if (!window || window.isDestroyed()) throw new Error('PHOTO_UNAVAILABLE')
  const contents = window.webContents
  if (activeCaptures.has(contents)) throw new Error('PHOTO_BUSY')
  activeCaptures.add(contents)
  const throttled = contents.getBackgroundThrottling(); contents.setBackgroundThrottling(false)
  const deadline = clock.nowMs() + 5000
  const waitFrame = () => new Promise<void>((resolve) => { clock.after(50, resolve) })
  const operation = async () => {
    try {
      while (!await contents.executeJavaScript(`(() => { const scene = document.querySelector('[data-photo-scene]'); if (!scene || scene.dataset.sessionId !== ${JSON.stringify(sessionId)}) return false;
        const canvas = scene.querySelector('canvas'); const images = [...scene.querySelectorAll('img')]; return canvas ? canvas.dataset.photoReady === 'true' : images.length > 0 && images.every(image => image.complete && image.naturalWidth > 0); })()`)) {
        if (clock.nowMs() >= deadline) throw new Error('PHOTO_NOT_READY'); await waitFrame()
      }
      const rect = await contents.executeJavaScript(`(async () => {
        const scene = document.querySelector('[data-photo-scene]');
        if (!scene || scene.dataset.sessionId !== ${JSON.stringify(sessionId)}) return null;
        const style = document.createElement('style'); style.id = 'lca-photo-isolation';
        style.textContent = 'body *{visibility:hidden!important}[data-photo-scene],[data-photo-scene] *{visibility:visible!important}[data-photo-omit],[data-photo-omit] *{visibility:hidden!important}';
        document.head.appendChild(style);
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const r = scene.getBoundingClientRect(); return {x:Math.ceil(r.x),y:Math.ceil(r.y),width:Math.floor(r.width)-2,height:Math.floor(r.height)-2};
      })()`)
      const [width, height] = window.getContentSize()
      if (!rect || !Object.values(rect).every((value) => Number.isInteger(value) && Number(value) >= 0) || rect.width < 32 || rect.height < 32 || rect.x + rect.width > width || rect.y + rect.height > height) throw new Error('PHOTO_UNAVAILABLE')
      const image = await contents.capturePage(rect, { stayHidden: true, stayAwake: true })
      if (image.isEmpty()) throw new Error('PHOTO_UNAVAILABLE')
      const size = image.getSize(); const bounded = Math.max(size.width, size.height) > 2048 ? image.resize({ width: Math.round(size.width * 2048 / Math.max(size.width, size.height)), height: Math.round(size.height * 2048 / Math.max(size.width, size.height)) }) : image
      return { png: bounded.toPNG(), ...bounded.getSize() }
    } finally { if (!contents.isDestroyed()) { await contents.executeJavaScript("document.getElementById('lca-photo-isolation')?.remove()").catch(() => {}); contents.setBackgroundThrottling(throttled) }; activeCaptures.delete(contents) }
  }
  let cancel: (() => void) | undefined
  try { return await Promise.race([operation(), new Promise<never>((_, reject) => { cancel = clock.after(5000, () => reject(new Error('PHOTO_TIMEOUT'))) })]) }
  finally { cancel?.(); if (!contents.isDestroyed()) void contents.executeJavaScript("document.getElementById('lca-photo-isolation')?.remove()").catch(() => {}) }
}
