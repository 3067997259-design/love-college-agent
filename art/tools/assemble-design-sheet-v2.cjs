// Recipe for art/retouch/2026-10-28-design-sheet-v2/design-sheet-v2-candidate-2.png (local, not in git).
// The full-body block is the Gemini face-fix turnaround (faces redrawn to match the expressions), upscaled 2x at sigma 0.5.
// Run: pnpm exec electron art/tools/assemble-design-sheet-v2.cjs <blockDir> node_modules/lxgw-wenkai-screen-web/lxgwwenkaiscreen/result.css <out.png> [fullBodyBlock.png]
// Assemble design sheet v2 from the four NovelAI-upscaled blocks, with our own text and measured palette.
// Usage: electron assemble-v2.cjs <blockDir> <fontCss> <out.png>
const { app, BrowserWindow } = require('electron')
const { writeFileSync } = require('node:fs')
const { join } = require('node:path')
const { pathToFileURL } = require('node:url')
const args = process.argv.slice(process.argv.findIndex((a) => a.endsWith('.cjs')) + 1)
const [dir, fontCss, out, aName = 'block-a-turnaround-facefix-x2.png'] = args
const url = (name) => pathToFileURL(join(dir, name)).href

const spec = {
  fontCss: pathToFileURL(fontCss).href,
  A: url(aName), B: url('block-b-details-x2.png'), C: url('block-c-expressions-x2.png'), D: url('block-d-side-face-study-x2.png'),
}

const page = `(async () => {
  const S = ${JSON.stringify(spec)}
  const link = document.createElement('link'); link.rel = 'stylesheet'; link.href = S.fontCss; document.head.appendChild(link)
  await new Promise((done) => { link.onload = done; link.onerror = done })
  const load = (src) => new Promise((done, fail) => { const i = new Image(); i.onload = () => done(i); i.onerror = () => fail(new Error('load ' + src)); i.src = src })
  const [A, B, C, D] = await Promise.all([load(S.A), load(S.B), load(S.C), load(S.D)])
  const FONT = '"LXGW WenKai Screen"', INK = '#3b2f2a', MUTED = '#8a7a72', LINE = '#e6dcd2'
  const texts = []
  const M = 100, W = 4115
  // Layout (px): header, row 1 = turnaround + details, row 2 = expressions + side faces + palette.
  const titleY = 150, sub1Y = 225, sub2Y = 280, ruleY = 320
  const secY1 = 400, row1Y = 430
  const A_SRC_W = A.naturalWidth, A_SRC_H = A.naturalHeight, A_H = 1400, A_W = Math.round(A_SRC_W * A_H / A_SRC_H)
  const bScale = 1400 / 1380, B_X = M + A_W + 90, B_SRC_X = 60, B_W = Math.round(1300 * bScale)
  const labA = row1Y + A_H + 60
  const secY2 = labA + 110, row2Y = secY2 + 30
  const C_ROW_H = 608, labCa = row2Y + C_ROW_H + 52, rowCb = labCa + 40, labCb = rowCb + C_ROW_H + 52
  const D_X = M + 2000 + 90, D_W = W - M - D_X, dScale = D_W / 2048, D_H = Math.round(1144 * dScale)
  const labD = row2Y + D_H + 52
  const palSecY = labD + 100, palY = palSecY + 30, SW = 150, SG = (D_W - 9 * SW) / 8
  const H = Math.max(labCb, palY + SW + 110) + 80

  const c = document.getElementById('c'); c.width = W; c.height = H
  const g = c.getContext('2d'); g.fillStyle = '#fefefe'; g.fillRect(0, 0, W, H)
  g.imageSmoothingQuality = 'high'  // blocks are scaled down into the layout
  const text = (s, x, y, size, color = INK, align = 'left', weight = '') => { texts.push([s, size, weight]); return () => { g.font = (weight ? weight + ' ' : '') + size + 'px ' + FONT; g.fillStyle = color; g.textAlign = align; g.fillText(s, x, y) } }
  const draws = []
  const T = (...a) => draws.push(text(...a))

  // Header
  T('桃子 · 角色设定图 v2', M, titleY, 96, INK, 'left', 'bold')
  T('2026-10-28 · Gemini 出图（全身像的脸已按表情差分重画），NovelAI 放大（声明模糊 0.5），文字与色值由我们排版 · 之后所有出图以此为身份基准', M, sub1Y, 38, MUTED)
  T('丝带系在她自己的左侧：正面看在画面右侧，背面看在画面左侧；身体朝画面左边时露出，朝右时在远侧', M, sub2Y, 38, MUTED)

  // Row 1: turnaround
  T('全身三视图（居家服）与出门服', M, secY1, 44, MUTED)
  g.drawImage(A, 0, 0, A_SRC_W, A_SRC_H, M, row1Y, A_W, A_H)
  ;[[245, '正面'], [753, '侧面 · 朝左'], [1231, '背面'], [1802, '出门服']].forEach(([x, s]) => T(s, M + x * A_W / 2048, labA, 46, INK, 'center'))

  // Row 1: details, each box tagged in place
  T('细节', B_X, secY1, 44, MUTED)
  g.drawImage(B, B_SRC_X, 0, 1300, 1380, B_X, row1Y, B_W, 1400)
  // A leader line left over from Gemini's callout layout, between the hair-tips and eyes boxes.
  g.fillStyle = '#fefefe'; g.fillRect(B_X + 635, row1Y + 330, 75, 195)
  const tags = [[0, 44, '丝带结 · 系在她左侧'], [710, 44, '发梢 · 齐下巴，向内收'], [0, 540, '眼睛 · 偏灰的淡琥珀'], [0, 920, '开衫 · 门襟纽扣，罗纹袖口'], [634, 920, '室内拖鞋 / 出门乐福鞋']]
  const tagDraws = tags.map(([bx, by, s]) => () => {
    g.font = '34px ' + FONT; const w = g.measureText(s).width + 32, x = B_X + bx * bScale + 14, y = row1Y + by * bScale + 14
    g.fillStyle = 'rgba(255,255,255,0.88)'; g.beginPath(); g.roundRect(x, y, w, 52, 10); g.fill()
    g.fillStyle = INK; g.textAlign = 'left'; g.fillText(s, x + 16, y + 37)
  })
  tags.forEach(([, , s]) => texts.push([s, 34, '']))

  // Row 2: expressions as two rows of four
  T('表情', M, secY2, 44, MUTED)
  g.drawImage(C, 0, 0, 2000, C_ROW_H, M, row2Y, 2000, C_ROW_H)
  g.drawImage(C, 2000, 0, 1920, C_ROW_H, M + 40, rowCb, 1920, C_ROW_H)
  ;[[244, '专注'], [730, '浅笑'], [1220, '犯困'], [1710, '开心']].forEach(([x, s]) => T(s, M + x, labCa, 44, INK, 'center'))
  ;[[200, '平静'], [690, '温柔地笑'], [1180, '思考'], [1670, '担心']].forEach(([x, s]) => T(s, M + 40 + x, labCb, 44, INK, 'center'))

  // Row 2: side faces
  T('侧脸', D_X, secY2, 44, MUTED)
  g.drawImage(D, 0, 0, 2048, 1144, D_X, row2Y, D_W, D_H)
  ;[[185, '正侧面'], [520, '四分之三侧面'], [845, '低头的四分之三侧面']].forEach(([x, s]) => T(s, D_X + x * 2 * dScale, labD, 40, INK, 'center'))

  // Palette (measured from adopted art; skirt from the design sheet)
  T('配色（从已采用画面实测）', D_X, palSecY, 44, MUTED)
  const pal = [['#FBD0C5', '发色亮部'], ['#F1D0C6', '发色中间调'], ['#E8C2D1', '发梢阴影'], ['#2E3350', '丝带'], ['#9C8C83', '眼睛'], ['#FEECE5', '肤色'], ['#FDF5E2', '开衫'], ['#E1D4E6', '长裙'], ['#DCD0E6', '薰衣草阴影']]
  pal.forEach(([hex, name], k) => {
    const x = D_X + k * (SW + SG)
    draws.push(() => { g.fillStyle = hex; g.fillRect(x, palY, SW, SW); g.strokeStyle = LINE; g.lineWidth = 2; g.strokeRect(x + 1, palY + 1, SW - 2, SW - 2) })
    T(name, x + SW / 2, palY + SW + 44, 30, INK, 'center')
    T(hex, x + SW / 2, palY + SW + 84, 28, MUTED, 'center')
  })

  // Rule under the header
  draws.unshift(() => { g.fillStyle = LINE; g.fillRect(M, ruleY, W - 2 * M, 3) })

  // Make sure every glyph we draw is loaded before drawing text.
  await Promise.all(texts.map(([s, size, weight]) => document.fonts.load((weight ? weight + ' ' : '') + size + 'px ' + FONT, s)))
  draws.forEach((d) => d()); tagDraws.forEach((d) => d())
  return { w: W, h: H, fontOk: document.fonts.check('40px ' + FONT, '桃子'), png: c.toDataURL('image/png') }
})()`

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, webPreferences: { webSecurity: false } })
  try {
    await win.loadURL('data:text/html,<canvas id=c></canvas>')
    const r = await win.webContents.executeJavaScript(page)
    writeFileSync(out, Buffer.from(r.png.split(',')[1], 'base64')); console.log(JSON.stringify({ out, size: `${r.w}x${r.h}`, fontOk: r.fontOk }))
  } catch (error) { console.error(error.message); process.exitCode = 1 } finally { win.destroy(); app.quit() }
})
