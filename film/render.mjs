// 短片渲染：起合成页（film/render，Vite），用本机 Chrome 无头逐帧画、读像素，交给 ffmpeg 编码并配上《花筏》的片段。
// 不下载浏览器（channel: 'chrome'），不读任何密钥，不调用 NovelAI；所有画面只由帧号决定，同样的输入出同样的片子。
//
// 用法（在仓库根目录）：
//   node film/render.mjs plates                         从应用书页截下书和计划卡（film/out/plates/）
//   node film/render.mjs stills <段> <秒,秒,...> [--scale 0.5]   画到这些时刻各存一张（film/out/stills/）
//   node film/render.mjs video <段> [--scale 0.5] [--draft]      出片（film/out/<段>[-draft].mp4）
//   node film/render.mjs preview                         浏览器里实时预览（?cut=opening&play&from=12）
// 环境变量：LCA_FFMPEG（ffmpeg 路径，默认 PATH 里的）、LCA_SONG（歌曲路径，默认 <仓库>/music/）。
import { createReadStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { dirname, extname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { performance } from 'node:perf_hooks'
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
import { chromium } from 'playwright'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const out = join(root, 'film', 'out')
const config = JSON.parse(readFileSync(join(root, 'film', 'cuts.json'), 'utf8'))
const [command, ...args] = process.argv.slice(2)
const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined }
const factor = Number(flag('--scale') ?? 1)
const port = Number(process.env.LCA_FILM_PORT ?? 5480)
// 有独显／核显时用 GPU（D3D11）；拿不到会退回软件渲染，只是慢
const launch = () => chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=d3d11', '--ignore-gpu-blocklist', '--enable-gpu'] })

const TYPES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.json': 'application/json', '.svg': 'image/svg+xml' }

/** 合成页的服务：/__film/file/ 只读仓库里的文件，/__film/frame 收一帧像素 */
async function filmServer(sink) {
  const plugin = {
    name: 'lca-film',
    configureServer(server) {
      server.middlewares.use('/__film/file/', (req, res) => {
        const path = resolve(root, decodeURIComponent((req.url ?? '').split('?')[0].replace(/^\/+/, '')))
        if (!path.startsWith(root + sep) || !existsSync(path) || !statSync(path).isFile()) { res.statusCode = 404; res.end(); return }
        res.setHeader('content-type', TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream')
        res.setHeader('cache-control', 'no-store')
        createReadStream(path).pipe(res)
      })
      server.middlewares.use('/__film/frame', (req, res) => {
        if (req.method !== 'POST' || !sink) { res.statusCode = 405; res.end(); return }
        const chunks = []
        req.on('data', (chunk) => chunks.push(chunk))
        req.on('end', () => {
          sink(Buffer.concat(chunks)).then(() => res.end('ok'), (error) => { res.statusCode = 500; res.end(String(error)) })
        })
      })
    },
  }
  const server = await createServer({
    root: join(root, 'film', 'render'),
    configFile: false,
    logLevel: 'error',
    plugins: [plugin],
    resolve: { alias: { '@wash': join(root, 'src/renderer/src/book/wash') } },
    server: { host: '127.0.0.1', port, strictPort: true, fs: { allow: [root] } },
  })
  await server.listen()
  return { server, base: `http://127.0.0.1:${port}/` }
}

async function openCut(browser, base, cut) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } })
  const errors = []
  page.on('pageerror', (error) => errors.push(String(error)))
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()) })
  await page.goto(`${base}?cut=${cut}&scale=${factor}`)
  await page.waitForFunction(() => document.body.dataset.ready === 'true' || document.body.dataset.failed, null, { timeout: 120_000 }).catch(() => {})
  if (!(await page.evaluate(() => document.body.dataset.ready === 'true'))) throw new Error('合成页没起来：\n' + errors.join('\n'))
  const info = await page.evaluate(() => ({ frames: window.film.frames, fps: window.film.fps, renderer: window.film.renderer }))
  console.log(`${cut}：${info.frames} 帧，${info.fps} fps，${Math.round(1920 * factor)}×${Math.round(1080 * factor)}，${info.renderer ?? '渲染器未知'}`)
  return { page, info, errors }
}

function song() {
  const path = process.env.LCA_SONG ?? join(root, config.song)
  if (!existsSync(path)) throw new Error(`找不到歌曲：${path}（用 LCA_SONG 指定）`)
  return path
}

/** 配乐：从歌里剪出各段，淡入淡出，放到片子里的时刻，混在一起，补齐到片长 */
function audioGraph(segments, duration) {
  const parts = [`[1:a]asplit=${segments.length}${segments.map((_, i) => `[i${i}]`).join('')}`]
  segments.forEach((segment, i) => {
    const length = segment.to - segment.from
    const fadeIn = segment.fadeIn ?? 0.05
    const fadeOut = segment.fadeOut ?? 0.05
    parts.push(`[i${i}]atrim=start=${segment.from}:end=${segment.to},asetpts=PTS-STARTPTS,afade=t=in:st=0:d=${fadeIn},afade=t=out:st=${(length - fadeOut).toFixed(3)}:d=${fadeOut},adelay=delays=${Math.round(segment.at * 1000)}:all=1[s${i}]`)
  })
  const inputs = segments.map((_, i) => `[s${i}]`).join('')
  const mix = segments.length > 1 ? `${inputs}amix=inputs=${segments.length}:normalize=0:dropout_transition=0,` : inputs
  parts.push(`${mix}apad=whole_dur=${duration},atrim=0:${duration}[aout]`)
  return parts.join(';')
}

async function video(cut) {
  const draft = args.includes('--draft')
  const width = Math.round(1920 * factor)
  const height = Math.round(1080 * factor)
  mkdirSync(out, { recursive: true })
  const file = join(out, `${cut}${draft ? '-draft' : ''}.mp4`)
  let ffmpeg
  let written = 0
  let frames = 0
  const started = performance.now()
  const sink = (buffer) => new Promise((done, fail) => {
    if (buffer.length !== width * height * 4) { fail(new Error(`帧大小不对：${buffer.length}`)); return }
    written++
    if (written % 30 === 0 || written === frames) process.stdout.write(`\r${written}/${frames} 帧  ${((performance.now() - started) / 1000).toFixed(0)} s`)
    if (ffmpeg.stdin.write(buffer)) done(); else ffmpeg.stdin.once('drain', done)
  })
  const { server, base } = await filmServer(sink)
  const browser = await launch()
  try {
    const { page, info } = await openCut(browser, base, cut)
    frames = info.frames
    const duration = (info.frames / info.fps).toFixed(3)
    const encode = draft ? ['-preset', 'veryfast', '-crf', '23'] : ['-preset', 'slow', '-crf', '15', '-tune', 'animation', '-profile:v', 'high']
    ffmpeg = spawn(process.env.LCA_FFMPEG ?? 'ffmpeg', [
      '-y', '-loglevel', 'error',
      '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${width}x${height}`, '-r', String(info.fps), '-i', '-',
      '-i', song(),
      '-filter_complex', `[0:v]vflip,format=yuv420p[vout];${audioGraph(config.cuts[cut].audio, duration)}`,
      '-map', '[vout]', '-map', '[aout]', '-c:v', 'libx264', ...encode, '-c:a', 'aac', '-b:a', '256k', '-movflags', '+faststart', '-t', duration, file,
    ], { stdio: ['pipe', 'inherit', 'inherit'] })
    const finished = new Promise((done, fail) => ffmpeg.on('exit', (code) => (code === 0 ? done() : fail(new Error(`ffmpeg 退出码 ${code}`)))))
    await page.evaluate(() => window.film.capture())
    ffmpeg.stdin.end()
    await finished
    const seconds = (performance.now() - started) / 1000
    const sha256 = createHash('sha256').update(readFileSync(file)).digest('hex')
    writeFileSync(file.replace(/\.mp4$/, '.json'), JSON.stringify({ cut, frames, fps: info.fps, width, height, renderer: info.renderer, seconds: Math.round(seconds), sha256, audio: config.cuts[cut].audio, art: config.cuts[cut].art }, null, 1) + '\n')
    console.log(`\n${file}  ${seconds.toFixed(0)} s  ${sha256.slice(0, 12)}`)
  } finally {
    await browser.close()
    await server.close()
  }
}

async function stills(cut, times) {
  const { server, base } = await filmServer(null)
  const browser = await launch()
  try {
    const { page } = await openCut(browser, base, cut)
    const urls = await page.evaluate((list) => window.film.stills(list), times)
    const dir = join(out, 'stills')
    mkdirSync(dir, { recursive: true })
    ;[...times].sort((a, b) => a - b).forEach((t, i) => {
      const file = join(dir, `${cut}-${t.toFixed(2).padStart(6, '0')}.jpg`)
      writeFileSync(file, Buffer.from(urls[i].split(',')[1], 'base64'))
      console.log(file)
    })
  } finally {
    await browser.close()
    await server.close()
  }
}

/** 从应用的书页（假数据场景 plan-proposed，1920×1080，两倍像素）截下：整本书（房间和卡片挖空）、空白的书、计划卡，以及它们的位置 */
async function plates() {
  const dir = join(out, 'plates')
  mkdirSync(dir, { recursive: true })
  const server = await createServer({
    root: join(root, 'src/renderer'),
    configFile: false,
    logLevel: 'error',
    plugins: [react()],
    resolve: { alias: { '@renderer': join(root, 'src/renderer/src'), 'three/examples/jsm/libs/meshopt_decoder.module.js': join(root, 'src/renderer/src/tools/meshopt-disabled.ts') } },
    server: { host: '127.0.0.1', port: port + 1, strictPort: true },
  })
  await server.listen()
  const browser = await launch()
  try {
    const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 2 })
    await page.goto(`http://127.0.0.1:${port + 1}/?scenario=plan-proposed`)
    await page.locator('.stage').waitFor()
    await page.evaluate(() => document.fonts.ready)
    await page.waitForTimeout(3500)
    await page.addStyleTag({ content: '.dev-switcher { display: none !important; }' })
    const PAD = 28
    const layout = await page.evaluate((pad) => {
      const box = (selector, grow = 0) => {
        const element = document.querySelector(selector)
        if (!element) throw new Error('找不到 ' + selector)
        const r = element.getBoundingClientRect()
        return { x: r.x - grow, y: r.y - grow, width: r.width + grow * 2, height: r.height + grow * 2 }
      }
      const gutter = box('.gutter')
      return { room: box('.page-left .room[data-photo-scene]'), card: box('.page-right .card', pad), gutter: gutter.x + gutter.width / 2, pageLeft: box('.page-left'), pageRight: box('.page-right') }
    }, PAD)
    writeFileSync(join(dir, 'layout.json'), JSON.stringify(layout, null, 1) + '\n')
    // 卡片单独截（带阴影、透明底）
    const only = await page.addStyleTag({ content: 'html, body, .stage { background: transparent !important; } body * { visibility: hidden !important; } .page-right .card, .page-right .card * { visibility: visible !important; }' })
    await page.screenshot({ path: join(dir, 'card.png'), omitBackground: true, clip: layout.card })
    await only.evaluate((element) => element.remove())
    // 开场片最后一帧的书：房间（片子自己画）、她的话、门牌、拉绳和卡片挖空
    const hide = await page.addStyleTag({ content: '.page-left .room, .page-left .speech, .door, .pull-cord, .page-right .card { visibility: hidden !important; }' })
    await page.screenshot({ path: join(dir, 'spread-opening.png') })
    await hide.evaluate((element) => element.remove())
    // 收尾片用的空白的书：两页都只剩纸
    await page.addStyleTag({ content: '.page-left > *, .page-right > *, .door, .pull-cord, .bookmarks, .quill-dock, .ribbon-key { visibility: hidden !important; }' })
    await page.screenshot({ path: join(dir, 'spread-empty.png') })
    console.log(join(dir, 'layout.json'))
    console.log(JSON.stringify(layout))
  } finally {
    await browser.close()
    await server.close()
  }
}

if (command === 'plates') await plates()
else if (command === 'stills' && args[0] && args[1]) await stills(args[0], args[1].split(',').map(Number))
else if (command === 'video' && args[0]) await video(args[0])
else if (command === 'preview') {
  const { base } = await filmServer(null)
  console.log(`${base}?cut=opening&play  （&from=秒 从那里开始；&scale=0.5 半尺寸）`)
} else {
  console.error('用法：node film/render.mjs plates | stills <段> <秒,秒,...> [--scale 0.5] | video <段> [--scale 0.5] [--draft] | preview')
  process.exitCode = 1
}
