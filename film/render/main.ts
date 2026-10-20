import config from '../cuts.json'
import type { Assets, Cut, Layout } from './cut'
import { DESIGN, Engine } from './engine'
import { closing } from './closing'
import { opening } from './opening'

/**
 * 合成页：film/render.mjs 用无头 Chrome 打开它，逐帧画、读像素、发回去编码。
 * 直接在浏览器里打开（pnpm film:preview）是预览：?cut=opening&from=12 从第 12 秒附近开始实时播放。
 */

type CutName = keyof typeof config.cuts
const params = new URLSearchParams(location.search)
const name = (params.get('cut') ?? 'opening') as CutName
const factor = Number(params.get('scale') ?? 1)
const canvas = document.getElementById('film') as HTMLCanvasElement
canvas.width = Math.round(DESIGN.width * factor)
canvas.height = Math.round(DESIGN.height * factor)
const status = document.getElementById('status')!

const url = (path: string) => '/__film/file/' + path.split('/').map(encodeURIComponent).join('/')
const engine = new Engine(canvas)
const layout = await (await fetch(url('film/out/plates/layout.json'))).json() as Layout
const assets: Assets = { url, layout, art: config.cuts[name].art as Record<string, string> }
const builders: Record<CutName, (engine: Engine, assets: Assets) => Promise<Cut>> = {
  opening,
  closing,
}
const cut = await builders[name](engine, assets)
const fps = config.fps
const frames = Math.round(cut.duration * fps)
let next = 0

/** 按顺序画到第 index 帧（笔触是累积的，不能跳着画） */
function renderTo(index: number) {
  if (index < next) throw new Error('只能往后画；要回看请刷新页面')
  while (next <= index) { cut.frame(next / fps); next++ }
}

const renderer = (engine.gl.getExtension('WEBGL_debug_renderer_info') && engine.gl.getParameter(0x9246)) as string | null

declare global {
  interface Window {
    film: {
      frames: number; fps: number; renderer: string | null
      capture(): Promise<void>
      stills(times: number[], quality?: number): Promise<string[]>
    }
  }
}

window.film = {
  frames, fps, renderer,
  /** 全部帧依次画出、读像素、POST 给本机的编码进程 */
  async capture() {
    for (let i = 0; i < frames; i++) {
      renderTo(i)
      const response = await fetch('/__film/frame', { method: 'POST', body: engine.read() })
      if (!response.ok) throw new Error(`第 ${i} 帧没收下：${response.status}`)
    }
  },
  /** 画到这几个时刻，各存一张 JPEG（看效果用） */
  async stills(times, quality = 0.9) {
    const out: string[] = []
    for (const t of [...times].sort((a, b) => a - b)) {
      renderTo(Math.min(frames - 1, Math.round(t * fps)))
      out.push(canvas.toDataURL('image/jpeg', quality))
    }
    return out
  },
}
document.body.dataset.ready = 'true'

// 预览：实时播放（帧率跟不上就慢放，不丢帧）
if (params.has('play')) {
  renderTo(Math.round(Number(params.get('from') ?? 0) * fps))
  const tick = () => {
    if (next >= frames) return
    renderTo(next)
    status.textContent = `${name} ${(next / fps).toFixed(2)} s / ${cut.duration} s · ${renderer ?? ''}`
    requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)
}
