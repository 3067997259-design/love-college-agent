// Recipe for art/retouch/2026-10-28-nai-upscale/room-r3-sky-from-r2-v2.png: r2's sky into r3's mint window glass, by colour, no redraw.
// Run: pnpm exec electron art/tools/window-sky-fill.cjs <r3.png> <r2.jpg> <out.png> 520,80,990,428 '#C9E7D8' 18 570,100,920,88
// Replace the mint-filled window glass of r3 with r2's sky, inside one rectangle, by colour only.
// Usage: electron skyfix.cjs <r3.png> <r2.jpg> <out.png> x0,y0,x1,y1 glassHex tolerance
const { app, BrowserWindow } = require('electron')
const { writeFileSync } = require('node:fs')
const { pathToFileURL } = require('node:url')
const args = process.argv.slice(process.argv.findIndex((a) => a.endsWith('.cjs')) + 1)
const [r3, r2, out, box, glassHex, tol, topLine] = args
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, webPreferences: { webSecurity: false } })
  try {
    await win.loadURL('data:text/html,<canvas id=c></canvas>')
    const result = await win.webContents.executeJavaScript(`(async () => {
      const load = (src) => new Promise((done, fail) => { const i = new Image(); i.onload = () => done(i); i.onerror = () => fail(new Error('load')); i.src = src })
      const [A, B] = await Promise.all([load(${JSON.stringify(pathToFileURL(r3).href)}), load(${JSON.stringify(pathToFileURL(r2).href)})])
      const w = A.naturalWidth, h = A.naturalHeight
      const c = document.getElementById('c'); c.width = w; c.height = h; const g = c.getContext('2d'); g.drawImage(A, 0, 0)
      const src = new OffscreenCanvas(w, h); const gs = src.getContext('2d'); gs.imageSmoothingQuality = 'high'; gs.drawImage(B, 0, 0, w, h)
      const img = g.getImageData(0, 0, w, h), sky = gs.getImageData(0, 0, w, h).data, d = img.data
      const [x0, y0, x1, y1] = ${JSON.stringify(box)}.split(',').map(Number), T = ${+tol}
      const [xa, ya, xb, yb] = ${JSON.stringify(topLine || '')}.split(',').map(Number)
      const top = (x) => Number.isFinite(xa) ? ya + (yb - ya) * (x - xa) / (xb - xa) : -Infinity
      const hex = ${JSON.stringify(glassHex)}; const G = [1, 3, 5].map((k) => parseInt(hex.slice(k, k + 2), 16))
      let replaced = 0, fallback = 0
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
        if (y < top(x)) continue
        const i = (y * w + x) * 4, dist = Math.hypot(d[i] - G[0], d[i + 1] - G[1], d[i + 2] - G[2])
        if (dist >= T) continue
        let r = sky[i], gg = sky[i + 1], b = sky[i + 2]
        // r2 sky is blue or near-white; anything warmer (her hair in r2) falls back to a plain sky blue.
        if (!(b >= r - 4 || (r > 225 && gg > 225 && b > 225))) { r = 196; gg = 226; b = 244; fallback++ }
        const a = Math.min(1, (T - dist) / (T * 0.5))  // soft edge: near-glass pixels blend
        d[i] = d[i] * (1 - a) + r * a; d[i + 1] = d[i + 1] * (1 - a) + gg * a; d[i + 2] = d[i + 2] * (1 - a) + b * a; replaced++
      }
      g.putImageData(img, 0, 0)
      return { replaced, fallback, png: c.toDataURL('image/png') }
    })()`)
    writeFileSync(out, Buffer.from(result.png.split(',')[1], 'base64')); console.log(JSON.stringify({ replaced: result.replaced, fallback: result.fallback }))
  } catch (error) { console.error(error.message); process.exitCode = 1 } finally { win.destroy(); app.quit() }
})
