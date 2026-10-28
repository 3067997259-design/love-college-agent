// Cut a 3x3 chibi sprite sheet on a white background into nine transparent PNGs.
// The background is flood-filled from each cell's border, so white inside the figure (collar, socks, paper) survives
// as long as the outline is closed; edge pixels fade with their lightness so no white halo is left.
// Run: pnpm exec electron art/tools/cut-chibi-sprites.cjs <sheet> <outDir> <name1,...,name9>
const { app, BrowserWindow } = require('electron')
const { writeFileSync, mkdirSync } = require('node:fs')
const { join } = require('node:path')
const { pathToFileURL } = require('node:url')
const args = process.argv.slice(process.argv.findIndex((a) => a.endsWith('.cjs')) + 1)
const [sheet, outDir, namesArg] = args
const names = namesArg.split(',')
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, webPreferences: { webSecurity: false } })
  try {
    await win.loadURL('data:text/html,<canvas id=c></canvas>')
    const result = await win.webContents.executeJavaScript(`(async () => {
      const img = await new Promise((done, fail) => { const i = new Image(); i.onload = () => done(i); i.onerror = () => fail(new Error('decode')); i.src = ${JSON.stringify(pathToFileURL(sheet).href)} })
      const W = img.naturalWidth, H = img.naturalHeight, cw = W / 3, ch = H / 3, out = []
      for (let r = 0; r < 3; r++) for (let q = 0; q < 3; q++) {
        const x0 = Math.round(q * cw), y0 = Math.round(r * ch), w = Math.round((q + 1) * cw) - x0, h = Math.round((r + 1) * ch) - y0
        const c = new OffscreenCanvas(w, h), g = c.getContext('2d'); g.drawImage(img, x0, y0, w, h, 0, 0, w, h)
        const im = g.getImageData(0, 0, w, h), d = im.data, light = (k) => Math.min(d[k], d[k + 1], d[k + 2])
        // Background = near-white pixels reachable from the cell border.
        const bg = new Uint8Array(w * h), stack = []
        const push = (x, y) => { if (x < 0 || y < 0 || x >= w || y >= h) return; const p = y * w + x; if (bg[p] || light(p * 4) < 236) return; bg[p] = 1; stack.push(p) }
        for (let x = 0; x < w; x++) { push(x, 0); push(x, h - 1) } for (let y = 0; y < h; y++) { push(0, y); push(w - 1, y) }
        while (stack.length) { const p = stack.pop(), x = p % w, y = (p - x) / w; push(x + 1, y); push(x - 1, y); push(x, y + 1); push(x, y - 1) }
        let minX = w, minY = h, maxX = 0, maxY = 0
        for (let p = 0; p < w * h; p++) {
          const k = p * 4
          if (bg[p]) { d[k + 3] = 0; continue }
          const x = p % w, y = (p - x) / w
          // Pixels touching the background: light ones are anti-aliasing against white, fade them out.
          const edge = (x > 0 && bg[p - 1]) || (x < w - 1 && bg[p + 1]) || (y > 0 && bg[p - w]) || (y < h - 1 && bg[p + w])
          if (edge) { const l = light(k); if (l > 200) d[k + 3] = Math.round(255 * (255 - l) / 55) }
          if (d[k + 3] > 24) { if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y }
        }
        g.putImageData(im, 0, 0)
        const pad = 4, bx = Math.max(0, minX - pad), by = Math.max(0, minY - pad), bw = Math.min(w, maxX + pad + 1) - bx, bh = Math.min(h, maxY + pad + 1) - by
        const o = new OffscreenCanvas(bw, bh); o.getContext('2d').drawImage(c, bx, by, bw, bh, 0, 0, bw, bh)
        const blob = await o.convertToBlob({ type: 'image/png' }), buf = new Uint8Array(await blob.arrayBuffer())
        let bin = ''; for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000))
        out.push({ w: bw, h: bh, png: btoa(bin) })
      }
      return out
    })()`)
    mkdirSync(outDir, { recursive: true })
    const meta = result.map((s, i) => { writeFileSync(join(outDir, `${names[i]}.png`), Buffer.from(s.png, 'base64')); return { name: names[i], width: s.w, height: s.h } })
    console.log(JSON.stringify(meta))
  } catch (error) { console.error(error.message); process.exitCode = 1 } finally { win.destroy(); app.quit() }
})
