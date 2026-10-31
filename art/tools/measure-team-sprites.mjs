// Measure the team-room sprites so the room can size every helper by her head, not by the size of her picture.
// Head = the hair box (her bob outline); foot = centre of the lowest opaque rows; bottom = lowest opaque row.
// Writes src/renderer/src/assets/character/taozi/team/sprite-metrics.json for the sprites listed in manifest.activeSprites.
// Run: node art/tools/measure-team-sprites.mjs [--check]   (--check fails if the file is stale instead of writing it)
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { inflateSync } from 'node:zlib'

const dir = resolve(import.meta.dirname, '../../src/renderer/src/assets/character/taozi/team')
const output = join(dir, 'sprite-metrics.json')

function decodePng(buffer) {
  if (buffer.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG')
  let pos = 8, width = 0, height = 0, depth = 0, color = 0, interlace = 0
  const idat = []
  while (pos < buffer.length) {
    const length = buffer.readUInt32BE(pos), type = buffer.toString('ascii', pos + 4, pos + 8), data = buffer.subarray(pos + 8, pos + 8 + length)
    if (type === 'IHDR') { width = data.readUInt32BE(0); height = data.readUInt32BE(4); depth = data[8]; color = data[9]; interlace = data[12] }
    else if (type === 'IDAT') idat.push(data)
    else if (type === 'IEND') break
    pos += 12 + length
  }
  if (depth !== 8 || interlace !== 0 || ![2, 6].includes(color)) throw new Error(`unsupported PNG (depth ${depth}, colour ${color}, interlace ${interlace})`)
  const channels = color === 6 ? 4 : 3, stride = width * channels, raw = inflateSync(Buffer.concat(idat)), rgba = Buffer.alloc(width * height * 4)
  let previous = Buffer.alloc(stride)
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)], line = Buffer.from(raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)))
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? line[i - channels] : 0, b = previous[i], c = i >= channels ? previous[i - channels] : 0
      let value = line[i]
      if (filter === 1) value += a
      else if (filter === 2) value += b
      else if (filter === 3) value += (a + b) >> 1
      else if (filter === 4) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); value += pa <= pb && pa <= pc ? a : pb <= pc ? b : c }
      line[i] = value & 255
    }
    for (let x = 0; x < width; x++) {
      const s = x * channels, d = (y * width + x) * 4
      rgba[d] = line[s]; rgba[d + 1] = line[s + 1]; rgba[d + 2] = line[s + 2]; rgba[d + 3] = channels === 4 ? line[s + 3] : 255
    }
    previous = line
  }
  return { width, height, rgba }
}

// Her lit hair is a warm peach: clearly redder than green and blue. Skin and the cardigan fail the red-green test,
// the skirt and the lavender hair shadow fail red-blue, the navy ribbon is too dark.
const isHair = (r, g, b) => r > 190 && r - g > 45 && r - b > 45 && g > 95 && g < 215

function measure(file) {
  const bytes = readFileSync(join(dir, file)), { width, height, rgba } = decodePng(bytes)
  const opaque = (x, y) => rgba[(y * width + x) * 4 + 3] >= 128
  const hairAt = (x, y) => { const k = (y * width + x) * 4; return rgba[k + 3] >= 128 && isHair(rgba[k], rgba[k + 1], rgba[k + 2]) }
  let top = height, bottom = -1
  const hairRows = new Uint32Array(height)
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    if (!opaque(x, y)) continue
    if (y < top) top = y
    if (y > bottom) bottom = y
    if (hairAt(x, y)) hairRows[y]++
  }
  if (bottom < 0) throw new Error(`${file}: no opaque pixels`)
  // The head is the first run of hair rows from the top; laptops and blush lower down are pink too, so stop at the first gap.
  const minimum = Math.max(3, Math.round(width * .02)), allowedGap = Math.round(height * .015)
  let start = -1, end = -1, gap = 0
  for (let y = 0; y < height; y++) {
    if (hairRows[y] >= minimum) { if (start < 0) start = y; end = y; gap = 0 }
    else if (start >= 0 && ++gap > allowedGap) break
  }
  if (start < 0 || start > top + height * .15) throw new Error(`${file}: no hair found near the top; check the colours or measure by hand`)
  let left = width, right = -1
  for (let y = start; y <= end; y++) for (let x = 0; x < width; x++) if (hairAt(x, y)) { if (x < left) left = x; if (x > right) right = x }
  // Feet: centre of everything opaque in the lowest 6% of the figure.
  let sum = 0, count = 0
  for (let y = Math.max(top, bottom - Math.round((bottom - top) * .06)); y <= bottom; y++) for (let x = 0; x < width; x++) if (opaque(x, y)) { sum += x; count++ }
  return {
    file, sha256: createHash('sha256').update(bytes).digest('hex'), width, height,
    head: { top: start, height: end - start + 1, left, width: right - left + 1 },
    footX: Math.round(sum / count), bottom,
  }
}

const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'))
const sprites = {}
for (const file of manifest.activeSprites) sprites[file.replace(/^mini-v2-|\.png$/g, '')] = measure(file)
const text = `${JSON.stringify({
  _说明: '由 art/tools/measure-team-sprites.mjs 生成，不要手改。head 是发型外框（像素），用来按头部大小定尺寸和点击范围；footX 是脚底中心，bottom 是最低的不透明行。尺寸规则见 src/renderer/src/book/team/teamScene.ts。',
  sprites,
}, null, 2)}\n`
if (process.argv.includes('--check')) {
  let current = ''
  try { current = readFileSync(output, 'utf8') } catch { /* missing counts as stale */ }
  if (current.replace(/\r\n/g, '\n') !== text) { console.error('sprite-metrics.json is stale; run node art/tools/measure-team-sprites.mjs'); process.exit(1) }
  console.log('sprite-metrics.json is current')
} else {
  writeFileSync(output, text)
  for (const [name, m] of Object.entries(sprites)) console.log(name.padEnd(16), `${m.width}x${m.height}`, 'head', `${m.head.height}px (${(m.head.height / m.height).toFixed(3)})`, 'footX', (m.footX / m.width).toFixed(3))
}
