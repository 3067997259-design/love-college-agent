import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Character, sceneSrc } from '../Character'
import type { CharacterArt } from '../characterArt'
import { QuillArt } from '../quill/QuillArt'
import { FURNITURE } from './furniture'
import { furnitureJob, INTRO_ORDER, introJobs, poseJob, restoreJob, type IntroStep } from './intro'
import { Painter, type Job, type PainterFrame } from './painter'
import { WashRenderer, type Frame, type HerMask, type Layer } from './renderer'
import { regionOf } from './strokes'
import { transitionKind, washProgress } from './wash-math'

/**
 * 左页房间的画：颜色聚在她周围、往外褪成铅笔（铅笔是你的，颜色是她的）。
 * - 换姿势：房间不动，旧颜色在 0.2 s 里褪到新姿势的铅笔上，再把她一笔一笔重画；同一姿势换表情或光照只交叉淡化。
 * - 存档恢复：应用重启后第一次看到这次恢复，羽毛笔把整个房间重新画一遍（视频第 18 镜的意思）。
 * - 新手流程（intro）：铅笔画空房间再勾出她，羽毛笔先上彩铅的简单颜色、再上真实颜色；点家具就画那一件，最后画满整间。
 * 所有上色都是笔触，不再从一点往外扩（2026-10-16 用户意见）。计时只用 performance.now() 和 requestAnimationFrame，
 * 平时画一次就停。没有 WebGL2 时退回原来的 CSS 版。
 */

const CROSSFADE_MS = 320
const PREVIOUS_FADE_MS = 200

interface Engine {
  renderer: WashRenderer
  frame: number
  mode: 'static' | 'crossfade' | 'paint' | 'intro'
  painter: Painter
  current?: Layer
  key?: string
  empty?: Layer
  previous?: { layer: Layer; startedAt: number; durationMs: number }
  keepOutside?: HerMask
  introStep?: IntroStep
  introTarget?: IntroStep
  queuedFurniture: Set<string>
  pendingRestore?: string
}

export function WashRoom({ art, restoreId, intro = null, paintFurniture = [] }: {
  art: CharacterArt
  restoreId: string | null
  intro?: IntroStep | null
  /** 新手流程里点过的家具，按点的先后；新出现的 id 就排上一件 */
  paintFurniture?: readonly string[]
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const pencilRef = useRef<HTMLDivElement>(null)
  const quillRef = useRef<HTMLDivElement>(null)
  const [fallback, setFallback] = useState(false)
  const engine = useRef<Engine | null>(null)

  // 建 WebGL；拿不到就用 CSS 版。空房间图先载着：换姿势要用它算她的剪影
  useLayoutEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const renderer = WashRenderer.create(canvas)
    if (!renderer) { setFallback(true); return }
    const e: Engine = { renderer, frame: 0, mode: 'static', painter: new Painter(), queuedFurniture: new Set() }
    engine.current = e
    const onLost = (event: Event) => { event.preventDefault(); cancelAnimationFrame(e.frame); setFallback(true) }
    canvas.addEventListener('webglcontextlost', onLost)
    const emptySrc = sceneSrc('empty')
    if (emptySrc) renderer.layer(emptySrc).then((layer) => { if (engine.current === e) { e.empty = layer; syncIntro(e); paint() } }, () => {})
    const fit = () => {
      // 书整体缩放过，按屏幕上的实际像素定画布大小，不超过原图
      const box = canvas.getBoundingClientRect()
      const scale = Math.min(window.devicePixelRatio || 1, 2)
      const size = Math.max(1, Math.min(1254, Math.round(Math.max(box.width, box.height) * scale)))
      renderer.resize(size, size)
      paint()
    }
    const observer = new ResizeObserver(fit)
    observer.observe(canvas)
    window.addEventListener('resize', fit)
    fit()
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', fit)
      canvas.removeEventListener('webglcontextlost', onLost)
      cancelAnimationFrame(e.frame)
      renderer.dispose()
      engine.current = null
    }
  }, [])

  /** 画当前这一帧；还在画、还没干、旧图还在淡出，就排下一帧 */
  function paint() {
    const e = engine.current
    if (!e?.current || e.renderer.lost) return
    cancelAnimationFrame(e.frame)
    const now = performance.now()
    // 新手流程要等空房间的线稿：没载好之前保持白纸
    if (e.mode === 'intro' && !e.empty) return
    const frame: Frame = { current: e.current, previousAlpha: 0 }
    let again = false
    if (e.previous) {
      const alpha = 1 - washProgress(now - e.previous.startedAt, e.previous.durationMs)
      if (alpha > 0) { frame.previous = e.previous.layer; frame.previousAlpha = alpha; again = true } else e.previous = undefined
    }
    let cursor: PainterFrame['cursor'] = null
    if (e.mode === 'paint' || e.mode === 'intro') {
      const out = e.painter.step(now)
      for (const { job, data } of out.stamps) e.renderer.stamp(data, job.channel, job.blend, job.style.ragged, maskFor(e, job))
      for (const { job, level } of out.fills) e.renderer.fill(job.channel, level, maskFor(e, job))
      cursor = out.cursor
      frame.paint = { dry: out.dry, keepOutside: e.mode === 'paint' ? e.keepOutside?.texture : undefined }
      if (e.mode === 'intro') frame.intro = { empty: e.empty! }
      if (out.busy || out.dry < 1) again = true
      else if (e.mode === 'paint') { e.mode = 'static'; e.keepOutside = undefined; frame.paint = undefined }
    }
    if (e.mode === 'crossfade' && !frame.previous) e.mode = 'static'
    moveCursor(cursor)
    e.renderer.keep(e.current, e.empty, frame.previous)
    e.renderer.draw(frame)
    if (canvasRef.current) canvasRef.current.dataset.photoReady = String(!again && e.mode === 'static')
    if (again) e.frame = requestAnimationFrame(paint)
  }

  function maskFor(e: Engine, job: Job): WebGLTexture | null {
    if (job.mask.kind === 'polygon') return e.renderer.polygonMask(job.mask.id, job.mask.points)
    if (job.mask.kind === 'her' && e.current && e.empty) return e.renderer.herMask(e.current, e.empty).texture
    return null
  }

  function moveCursor(cursor: PainterFrame['cursor']) {
    for (const [kind, ref] of [['pencil', pencilRef], ['quill', quillRef]] as const) {
      const el = ref.current
      if (!el) continue
      const on = cursor?.kind === kind
      el.dataset.visible = String(on)
      if (on) {
        el.style.left = `${cursor.x * 100}%`
        el.style.top = `${cursor.y * 100}%`
        el.dataset.down = String(cursor.down)
      }
    }
  }

  const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches

  function startRestore(e: Engine) {
    e.pendingRestore = undefined
    e.previous = undefined
    e.keepOutside = undefined
    e.painter.clear()
    if (reduced()) { e.mode = 'static'; return }
    e.renderer.resetReveal(1, 1, 0, 1)
    e.painter.enqueue(restoreJob())
    e.mode = 'paint'
  }

  function startPose(e: Engine, previous: Layer) {
    const her = e.empty && e.current ? e.renderer.herMask(e.current, e.empty) : null
    if (!her?.region || reduced()) {
      // 她出门了或素材不全：只交叉淡化
      e.previous = { layer: previous, startedAt: performance.now(), durationMs: CROSSFADE_MS }
      e.mode = 'crossfade'
      return
    }
    e.renderer.resetReveal(1, 1, 0, 1)
    e.keepOutside = her
    e.previous = { layer: previous, startedAt: performance.now(), durationMs: PREVIOUS_FADE_MS }
    e.painter.clear()
    e.painter.enqueue(poseJob(her.region))
    e.mode = 'paint'
  }

  /** 新手流程走到目标步骤：把中间各步的活按顺序排上（要等这张图和空房间图都载好，才能算她的剪影） */
  function syncIntro(e: Engine) {
    if (e.mode !== 'intro' || !e.introTarget || !e.current || !e.empty) return
    const from = e.introStep ? INTRO_ORDER.indexOf(e.introStep) + 1 : 0
    const to = INTRO_ORDER.indexOf(e.introTarget)
    const her = e.renderer.herMask(e.current, e.empty).region
    for (let i = from; i <= to; i++) for (const job of introJobs(INTRO_ORDER[i], her)) e.painter.enqueue(reduced() ? instant(job) : job)
    e.introStep = e.introTarget
  }

  // 换图：载入并提取铅笔层后，按姿势是否变化选过渡
  useEffect(() => {
    const e = engine.current
    const src = sceneSrc(art.key)
    if (!e || !src) return
    if (canvasRef.current) canvasRef.current.dataset.photoReady = 'false'
    let cancelled = false
    e.renderer.keep(e.current)
    e.renderer.layer(src).then((layer) => {
      if (cancelled || engine.current !== e) return
      const kind = transitionKind(e.key ?? null, art.key)
      const previous = e.current
      e.current = layer
      e.key = art.key
      if (e.mode === 'intro') syncIntro(e)
      else if (e.pendingRestore) startRestore(e)
      else if (previous && kind === 'crossfade') { e.previous = { layer: previous, startedAt: performance.now(), durationMs: CROSSFADE_MS }; if (e.mode === 'static') e.mode = 'crossfade' }
      else if (previous && kind === 'wash') startPose(e, previous)
      paint()
    }, () => { if (!cancelled && engine.current === e) setFallback(true) })
    return () => { cancelled = true }
  }, [art.key, fallback])

  // 新手流程：每进一步，排上这一步的活；离开新手流程就回到平常的画法
  useEffect(() => {
    const e = engine.current
    if (!e) return
    if (!intro) {
      if (e.mode === 'intro') { e.mode = 'static'; e.introStep = undefined; e.introTarget = undefined; e.painter.clear(); paint() }
      return
    }
    if (e.mode !== 'intro') {
      e.mode = 'intro'
      e.painter.clear()
      e.previous = undefined
      e.keepOutside = undefined
      e.renderer.resetReveal(0, 0, 0, 0)
      e.introStep = undefined
      e.queuedFurniture.clear()
    }
    e.introTarget = intro
    syncIntro(e)
    paint()
  }, [intro, fallback])

  // 新手流程里点了一件家具：她去给它上色
  useEffect(() => {
    const e = engine.current
    if (!e || e.mode !== 'intro') return
    for (const id of paintFurniture) {
      if (e.queuedFurniture.has(id)) continue
      const item = FURNITURE.find((f) => f.id === id)
      if (!item) continue
      e.queuedFurniture.add(id)
      const job = furnitureJob(item, regionOf(item.points))
      e.painter.enqueue(reduced() ? instant(job) : job)
    }
    paint()
  }, [paintFurniture, fallback])

  // 存档恢复：同一次恢复只播一次（应用重启后收据还在，直到用户收起）
  useEffect(() => {
    const e = engine.current
    if (!e || !restoreId || playedRestore() === restoreId) return
    rememberRestore(restoreId)
    if (e.current && e.mode !== 'intro') { startRestore(e); paint() } else e.pendingRestore = restoreId
  }, [restoreId, fallback])

  // 退回 CSS 版：原来的径向遮罩把整景淡进纸里，没有铅笔层
  if (fallback) return <div className="room-color"><Character art={art} /></div>
  return (
    <>
      <canvas ref={canvasRef} className="room-wash" data-art={art.key} aria-hidden />
      {/* 画线稿的是你手里的铅笔；上色的是她的羽毛笔 */}
      <div ref={pencilRef} className="intro-pencil" data-visible="false" aria-hidden><PencilArt /></div>
      <div ref={quillRef} className="paint-quill" data-visible="false" aria-hidden><QuillArt /></div>
    </>
  )
}

/** 减少动态效果：活照排，但立刻画完 */
function instant(job: Job): Job {
  return { ...job, stroke: { ...job.stroke, durationMs: 1, points: job.stroke.points.map((p) => ({ ...p, t: Math.min(p.t, 1) })) }, fillMs: job.fillMs ? 1 : 0 }
}

const PLAYED_KEY = 'lca:restore-wash'
function playedRestore(): string | null {
  try { return localStorage.getItem(PLAYED_KEY) } catch { return null }
}
function rememberRestore(id: string) {
  try { localStorage.setItem(PLAYED_KEY, id) } catch { /* 存不下就下次再播一遍，不影响恢复本身 */ }
}

/** 你手里的铅笔：浅灰蓝的笔杆、削好的木头和石墨笔尖；笔尖在左下角 (2, 98) */
function PencilArt() {
  return (
    <svg viewBox="0 0 100 100" aria-hidden>
      <g stroke="#4a4d55" strokeWidth="1.6" strokeLinejoin="round">
        <path d="M30 70 L 86 14 L 96 24 L 40 80 Z" fill="#cfd5df" />
        <path d="M36 76 L 90 22" fill="none" opacity="0.5" />
        <path d="M30 70 L 40 80 L 12 90 Z" fill="#ead2ad" />
        <path d="M12 90 L 18 81 L 21 84 Z" fill="#55585f" />
        <path d="M86 14 L 96 24 L 99 21 L 89 11 Z" fill="#e9c0b6" />
      </g>
    </svg>
  )
}
