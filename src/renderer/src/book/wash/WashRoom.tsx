import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Character, sceneSrc } from '../Character'
import type { CharacterArt } from '../characterArt'
import { QuillArt } from '../quill/QuillArt'
import { FURNITURE } from './furniture'
import { ARRIVE_MS, furnitureJob, INTRO_ORDER, introJobs, poseJob, restoreJob, USER_PENCIL, type IntroStep } from './intro'
import { Painter, type Job, type PainterFrame } from './painter'
import { WashRenderer, type Frame, type HerMask, type Layer } from './renderer'
import { coverageOf, regionOf, segment, stampsBetween } from './strokes'
import { easeInOut, ghostAlpha, LEAVE_COLOR_MS, LEAVE_TOTAL_MS, transitionKind, washProgress, type ArtRef } from './wash-math'

/**
 * 左页房间的画：颜色聚在她周围、往外褪成铅笔（铅笔是你的，颜色是她的）。
 * - 换姿势：房间不动，旧颜色在 0.2 s 里褪到新姿势的铅笔上，再把她一笔一笔重画；同一姿势换表情、拉灯只交叉淡化。
 * - 光线变了（天黑、睡着、醒来）：整张图慢慢淡过去。夜图和白天的空房间处处不同，不能按剪影重画。
 * - 她出门：颜色先跟她走，她的铅笔影子留一会儿再散；她回来：先出线稿，再比平常慢一点地一笔笔上色。
 * - 存档恢复：应用重启后第一次看到这次恢复，羽毛笔把整个房间重新画一遍（视频第 18 镜的意思）。
 * - 新手流程（intro）：铅笔画空房间再勾出她，羽毛笔先上彩铅的简单颜色、再上真实颜色；点家具就画那一件，最后画满整间。
 * 所有上色都是笔触，不再从一点往外扩（2026-10-16 用户意见）。计时只用 performance.now() 和 requestAnimationFrame，
 * 平时画一次就停。没有 WebGL2 时退回原来的 CSS 版。
 */

type Point = { x: number; y: number }
/**
 * 新手流程里你手里的彩铅（左页把指针交给它，坐标是房间图的纹理坐标）。涂的颜色当场印上，
 * 返回这件家具涂过的比例；没有 WebGL 的 CSS 版没有它，左页就退回“点一下她来画”。
 */
export interface RoomBrush {
  /** 指针在家具上方、没按下：彩铅跟着指针；null 是移开了 */
  hover(at: Point | null): void
  begin(id: string, at: Point): number
  to(at: Point): number
  /** 松开：这一下拖了多远、这件涂了多少 */
  end(): { id: string; moved: number; coverage: number } | null
}

const CROSSFADE_MS = 320
/** 羽毛笔平时斜 30°；顺着笔走的方向，笔杆往后倒一点（最多 10°） */
const QUILL_TILT = 30
const QUILL_LEAN = 10
const PREVIOUS_FADE_MS = 200
/** 光线变化：和房间调色层（book.css .room-light）同一个时长 */
const LIGHT_FADE_MS = 1400

interface Engine {
  renderer: WashRenderer
  frame: number
  mode: 'static' | 'crossfade' | 'paint' | 'intro'
  painter: Painter
  current?: Layer
  art?: ArtRef
  empty?: Layer
  previous?: { layer: Layer; startedAt: number; durationMs: number; eased?: boolean }
  /** 她刚出门：上一张姿势的线稿和剪影 */
  ghost?: { pencil: WebGLTexture; mask: WebGLTexture; startedAt: number }
  keepOutside?: HerMask
  introStep?: IntroStep
  introTarget?: IntroStep
  queuedFurniture: Set<string>
  pendingRestore?: string
  /** 你的彩铅：在哪、按没按着；正在涂哪一件 */
  userPen?: Point & { down: boolean }
  brushing?: { id: string; points: readonly (readonly [number, number])[]; last: Point; moved: number; area: ReturnType<typeof coverageOf> }
  areas: Map<string, ReturnType<typeof coverageOf>>
  quillTrail?: { x: number; t: number; lean: number }
}

export function WashRoom({ art, restoreId, intro = null, paintFurniture = [], lightSwitch = false, brushRef }: {
  art: CharacterArt
  restoreId: string | null
  intro?: IntroStep | null
  /** 新手流程里交给她上色的家具，按先后；新出现的 id 就排上一件 */
  paintFurniture?: readonly string[]
  /** 这次光线变化是拉灯（一下子），不是天色（慢慢变） */
  lightSwitch?: boolean
  /** 新手流程里你手里的彩铅 */
  brushRef?: { current: RoomBrush | null }
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
    const e: Engine = { renderer, frame: 0, mode: 'static', painter: new Painter(), queuedFurniture: new Set(), areas: new Map() }
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
      const t = washProgress(now - e.previous.startedAt, e.previous.durationMs)
      const alpha = 1 - (e.previous.eased ? easeInOut(t) : t)
      if (alpha > 0) { frame.previous = e.previous.layer; frame.previousAlpha = alpha; again = true } else e.previous = undefined
    }
    if (e.ghost) {
      const elapsed = now - e.ghost.startedAt
      if (elapsed < LEAVE_TOTAL_MS) { frame.ghost = { pencil: e.ghost.pencil, mask: e.ghost.mask, alpha: ghostAlpha(elapsed) }; again = true } else e.ghost = undefined
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
    if (e.mode === 'crossfade' && !frame.previous && !frame.ghost) e.mode = 'static'
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

  /** 笔尖跟着画：铅笔是排线时的你，或者新手流程里拿彩铅涂家具的你；羽毛笔是她 */
  function moveCursor(cursor: PainterFrame['cursor']) {
    const e = engine.current
    const yours = cursor?.kind === 'pencil' ? cursor : e?.userPen ? { kind: 'pencil' as const, ...e.userPen } : null
    const hers = cursor?.kind === 'quill' ? cursor : null
    for (const [pen, ref] of [[yours, pencilRef], [hers, quillRef]] as const) {
      const el = ref.current
      if (!el) continue
      el.dataset.visible = String(!!pen)
      if (!pen) continue
      el.style.left = `${pen.x * 100}%`
      el.style.top = `${pen.y * 100}%`
      el.dataset.down = String(pen.down)
    }
    if (pencilRef.current) pencilRef.current.dataset.tool = cursor?.kind !== 'pencil' && e?.userPen ? 'color' : 'graphite'
    if (quillRef.current && e) {
      if (!hers) { e.quillTrail = undefined; return }
      // 往右走时笔杆往左倒，往左走时往右倒；按着才倒，抬笔时慢慢回正
      const now = performance.now()
      const trail = e.quillTrail
      const speed = trail && now > trail.t ? (hers.x - trail.x) / (now - trail.t) : 0
      const target = hers.down ? Math.max(-QUILL_LEAN, Math.min(QUILL_LEAN, speed * 5000)) : 0
      const lean = (trail?.lean ?? 0) * 0.82 + target * 0.18
      e.quillTrail = { x: hers.x, t: now, lean }
      quillRef.current.style.setProperty('--tilt', `${(QUILL_TILT - lean).toFixed(2)}deg`)
    }
  }

  /** 你的彩铅涂到这里：颜色当场印上，湿边跟着你 */
  function colorTo(e: Engine, at: Point): number {
    const brushing = e.brushing!
    const data = stampsBetween(segment(brushing.last, at), 0, 1, USER_PENCIL)
    e.renderer.stamp(data, 'paint', 'add', USER_PENCIL.ragged, e.renderer.polygonMask(brushing.id, brushing.points))
    brushing.moved += Math.hypot(at.x - brushing.last.x, at.y - brushing.last.y)
    const ratio = brushing.area.sweep(brushing.last, at, USER_PENCIL.radius)
    brushing.last = at
    e.userPen = { ...at, down: true }
    e.painter.wet(performance.now())
    paint()
    return ratio
  }

  const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches

  function startRestore(e: Engine) {
    e.pendingRestore = undefined
    e.previous = undefined
    e.ghost = undefined
    e.keepOutside = undefined
    e.painter.clear()
    if (reduced()) { e.mode = 'static'; return }
    e.renderer.resetReveal(1, 1, 0, 1)
    e.painter.enqueue(restoreJob())
    e.mode = 'paint'
  }

  /** 交叉淡化；eased 的两头慢，用在光线变化上 */
  function startFade(e: Engine, previous: Layer, durationMs: number, eased = false) {
    e.previous = { layer: previous, startedAt: performance.now(), durationMs, eased }
    if (e.mode === 'static') e.mode = 'crossfade'
  }

  function startPose(e: Engine, previous: Layer, durationMs?: number) {
    const her = e.empty && e.current ? e.renderer.herMask(e.current, e.empty) : null
    if (!her?.region || reduced()) {
      // 素材不全：只交叉淡化
      startFade(e, previous, CROSSFADE_MS)
      return
    }
    e.renderer.resetReveal(1, 1, 0, 1)
    e.keepOutside = her
    e.ghost = undefined
    e.previous = { layer: previous, startedAt: performance.now(), durationMs: PREVIOUS_FADE_MS }
    e.painter.clear()
    e.painter.enqueue(poseJob(her.region, durationMs))
    e.mode = 'paint'
  }

  /** 她出门：她的颜色淡走，剪影里留下她的铅笔线，再慢慢散掉 */
  function startLeave(e: Engine, previous: Layer) {
    const her = e.empty ? e.renderer.herMask(previous, e.empty) : null
    if (!her?.region || reduced()) { startFade(e, previous, reduced() ? CROSSFADE_MS : LIGHT_FADE_MS, true); return }
    const now = performance.now()
    e.previous = { layer: previous, startedAt: now, durationMs: LEAVE_COLOR_MS, eased: true }
    e.ghost = { pencil: previous.pencil, mask: her.texture, startedAt: now }
    if (e.mode === 'static') e.mode = 'crossfade'
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
      const kind = transitionKind(e.art ?? null, art, lightSwitch)
      const previous = e.current
      e.current = layer
      e.art = { key: art.key, lighting: art.lighting }
      if (e.mode === 'intro') syncIntro(e)
      else if (e.pendingRestore) startRestore(e)
      else if (previous) {
        if (kind === 'crossfade') startFade(e, previous, CROSSFADE_MS)
        else if (kind === 'fade') startFade(e, previous, reduced() ? CROSSFADE_MS : LIGHT_FADE_MS, true)
        else if (kind === 'leave') startLeave(e, previous)
        else if (kind === 'arrive') startPose(e, previous, ARRIVE_MS)
        else if (kind === 'wash') startPose(e, previous)
      }
      paint()
    }, () => { if (!cancelled && engine.current === e) setFallback(true) })
    return () => { cancelled = true }
  }, [art.key, fallback])

  // 新手流程：每进一步，排上这一步的活；离开新手流程就回到平常的画法
  useEffect(() => {
    const e = engine.current
    if (!e) return
    if (!intro) {
      if (e.mode === 'intro') { e.mode = 'static'; e.introStep = undefined; e.introTarget = undefined; e.painter.clear(); e.userPen = undefined; e.brushing = undefined; paint() }
      return
    }
    if (e.mode !== 'intro') {
      e.mode = 'intro'
      e.painter.clear()
      e.previous = undefined
      e.ghost = undefined
      e.keepOutside = undefined
      e.renderer.resetReveal(0, 0, 0, 0)
      e.introStep = undefined
      e.queuedFurniture.clear()
      e.areas.clear()
    }
    e.introTarget = intro
    syncIntro(e)
    paint()
  }, [intro, fallback])

  // 你手里的彩铅：只在 WebGL 版里有
  useLayoutEffect(() => {
    if (!brushRef) return
    brushRef.current = fallback ? null : {
      hover: (at) => {
        const e = engine.current
        if (!e || e.brushing) return
        e.userPen = at ? { ...at, down: false } : undefined
        paint()
      },
      begin: (id, at) => {
        const e = engine.current
        const item = FURNITURE.find((f) => f.id === id)
        if (!e || e.mode !== 'intro' || !item || e.queuedFurniture.has(id)) return 0
        let area = e.areas.get(id)
        if (!area) { area = coverageOf(item.points); e.areas.set(id, area) }
        e.brushing = { id, points: item.points, last: at, moved: 0, area }
        return colorTo(e, at)
      },
      to: (at) => { const e = engine.current; return e?.brushing ? colorTo(e, at) : 0 },
      end: () => {
        const e = engine.current
        const brushing = e?.brushing
        if (!e || !brushing) return null
        e.brushing = undefined
        e.userPen = { ...brushing.last, down: false }
        paint()
        return { id: brushing.id, moved: brushing.moved, coverage: brushing.area.ratio() }
      },
    }
    return () => { brushRef.current = null }
  }, [brushRef, fallback])

  // 新手流程里交给她的家具：她去给它上色
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
        <path className="pencil-tip" d="M12 90 L 18 81 L 21 84 Z" fill="#55585f" />
        <path d="M86 14 L 96 24 L 99 21 L 89 11 Z" fill="#e9c0b6" />
      </g>
    </svg>
  )
}
