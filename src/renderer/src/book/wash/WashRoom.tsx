import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Character, sceneSrc } from '../Character'
import type { CharacterArt } from '../characterArt'
import { QuillArt } from '../quill/QuillArt'
import { HER_DRAW_MS, INTRO_ORDER, introDuration, introFrame, penAt, ROOM_DRAW_MS, scribble, stampsBetween, type IntroStep, type Stroke } from './intro'
import { WashRenderer, type Frame, type Layer } from './renderer'
import { dryness, noiseAmplitude, transitionKind, washProgress, washRadius } from './wash-math'

/**
 * 左页房间的画：颜色聚在她周围、往外褪成铅笔（铅笔是你的，颜色是她的）。
 * - 换姿势：先是新姿势的铅笔，颜色从她身上晕开（--dur-wash，1.4 s）；同一姿势换表情或光照只交叉淡化。
 * - 存档恢复：应用重启后第一次看到这次恢复，颜色从一点慢慢长回来（约 6 s，和视频第 18 镜同一个意思）。
 * - 新手流程（intro）：铅笔先画空房间再勾出她，彩铅上简单的颜色，再晕成真实颜色，最后铺满房间（intro.ts）。
 * 计时只用 performance.now() 和 requestAnimationFrame，平时画一次就停。没有 WebGL2 时退回原来的 CSS 版。
 */

const ORIGIN = [0.6, 0.55] as const      // 她胸口附近：颜色从她身上长开
const RESTORE_MS = 6000                   // 整屋晕染约 6 s 到 98%
const POSE_MS = 1400                      // 和 --dur-wash 一致
const CROSSFADE_MS = 320
// 换姿势：旧颜色先在 0.2 s 里褪到新姿势的铅笔上，新颜色稍后才开始长，两张脸不叠在一起
const PREVIOUS_FADE_MS = 200
const WASH_DELAY_MS = 150
const NOISE = 0.045                       // 前沿噪点强度（纹理坐标）
const RMAX = 0.82                         // 从起点到最远的颜色边缘再留一点

interface Transition { kind: 'wash' | 'crossfade'; durationMs: number; startedAt: number; seed: number; previous?: Layer }
interface Intro { step: IntroStep; enteredAt: number; empty?: Layer; room: Stroke; her: Stroke; roomT: number; herT: number; seed: number }

// 自动排线：先整间屋子，再她那一块（她坐在画面右半）
const ROOM_STROKE = scribble({ x0: 0.04, y0: 0.06, x1: 0.96, y1: 0.94 }, 9, ROOM_DRAW_MS, 0.075, 3)
const HER_STROKE = scribble({ x0: 0.42, y0: 0.13, x1: 0.94, y1: 0.93 }, 6, HER_DRAW_MS, 0.08, 7)
// 她坐着，上下比左右长：颜色按竖长的椭圆从她身上晕开，手和本子也在里面
const HER_SHAPE = [1, 0.72] as const

export function WashRoom({ art, restoreId, intro = null }: { art: CharacterArt; restoreId: string | null; intro?: IntroStep | null }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const penRef = useRef<HTMLDivElement>(null)
  const [fallback, setFallback] = useState(false)
  // 恢复时笔尖点在她身上：这一次晕染的编号，动画放完就收起
  const [quillTouch, setQuillTouch] = useState<string | null>(null)
  const engine = useRef<{
    renderer: WashRenderer
    current?: Layer
    key?: string
    transition?: Transition
    pendingRestore?: string
    intro?: Intro
    frame: number
  } | null>(null)

  // 建 WebGL；拿不到就用 CSS 版
  useLayoutEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const renderer = WashRenderer.create(canvas)
    if (!renderer) { setFallback(true); return }
    const state = { renderer, frame: 0 }
    engine.current = state
    const onLost = (event: Event) => { event.preventDefault(); cancelAnimationFrame(state.frame); setFallback(true) }
    canvas.addEventListener('webglcontextlost', onLost)
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
      cancelAnimationFrame(state.frame)
      renderer.dispose()
      engine.current = null
    }
  }, [])

  /** 画当前这一帧；过渡没完就排下一帧 */
  function paint() {
    const state = engine.current
    if (!state?.current || state.renderer.lost) return
    cancelAnimationFrame(state.frame)
    if (state.intro) { paintIntro(state.intro); return }
    const t = state.transition
    const frame: Frame = { current: state.current, previousAlpha: 0 }
    if (t) {
      const elapsed = performance.now() - t.startedAt
      const progress = washProgress(elapsed, t.durationMs)
      if (t.kind === 'crossfade') {
        frame.previous = t.previous
        frame.previousAlpha = 1 - progress
      } else {
        const delay = t.previous ? Math.min(WASH_DELAY_MS, t.durationMs / 4) : 0
        const radius = washRadius(elapsed - delay, t.durationMs - delay, RMAX)
        frame.previous = t.previous
        frame.previousAlpha = 1 - washProgress(elapsed, Math.min(PREVIOUS_FADE_MS, t.durationMs))
        frame.wash = { origin: ORIGIN, radius, noiseAmp: noiseAmplitude(radius, NOISE), dry: dryness(progress), seed: t.seed }
      }
      if (progress >= 1) state.transition = undefined // 到点强制填满，湿边已干
    }
    state.renderer.keep(state.current, t?.previous)
    state.renderer.draw(frame)
    if (state.transition) state.frame = requestAnimationFrame(paint)
  }

  /** 新手流程的一帧：补印这段时间走过的笔刷，再按时间线合成 */
  function paintIntro(intro: Intro) {
    const state = engine.current
    if (!state?.current || !intro.empty) return
    const elapsed = performance.now() - intro.enteredAt
    const f = introFrame(intro.step, elapsed)
    if (f.roomT > intro.roomT) { state.renderer.stamp(stampsBetween(intro.room, intro.roomT, f.roomT), 'room'); intro.roomT = f.roomT }
    if (f.herT > intro.herT) { state.renderer.stamp(stampsBetween(intro.her, intro.herT, f.herT), 'her'); intro.herT = f.herT }
    state.renderer.keep(state.current, intro.empty)
    state.renderer.draw({
      current: state.current, previousAlpha: 0, intro: { empty: intro.empty },
      wash: { origin: ORIGIN, radius: f.coverRadius, realRadius: f.realRadius, noiseAmp: noiseAmplitude(f.coverRadius, NOISE), dry: f.dry, seed: intro.seed, shape: HER_SHAPE },
    })
    // 铅笔跟着笔尖走；画完就收起
    const pen = penRef.current
    if (pen) {
      const drawing = intro.step === 'drawing' && (f.roomT < ROOM_DRAW_MS || f.herT < HER_DRAW_MS)
      const at = f.roomT < ROOM_DRAW_MS ? penAt(intro.room, f.roomT) : penAt(intro.her, f.herT)
      pen.style.left = `${at.x * 100}%`
      pen.style.top = `${at.y * 100}%`
      pen.dataset.down = String(drawing && at.down)
      pen.dataset.visible = String(drawing)
    }
    if (elapsed < introDuration(intro.step)) state.frame = requestAnimationFrame(paint)
  }

  function start(kind: Transition['kind'], durationMs: number, previous?: Layer) {
    const state = engine.current
    if (!state) return
    const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches
    state.transition = { kind, durationMs: reduced ? 1 : durationMs, startedAt: performance.now(), seed: Math.random() * 50, previous }
  }

  // 换图：载入并提取铅笔层后，按姿势是否变化选过渡
  useEffect(() => {
    const state = engine.current
    const src = sceneSrc(art.key)
    if (!state || !src) return
    let cancelled = false
    state.renderer.keep(state.current)
    state.renderer.layer(src).then((layer) => {
      if (cancelled || engine.current !== state) return
      const kind = transitionKind(state.key ?? null, art.key)
      const previous = state.current
      state.current = layer
      state.key = art.key
      if (state.pendingRestore) { setQuillTouch(state.pendingRestore); state.pendingRestore = undefined; start('wash', RESTORE_MS) }
      else if (kind === 'wash') start('wash', POSE_MS, previous)
      else if (kind === 'crossfade') start('crossfade', CROSSFADE_MS, previous)
      paint()
    }, () => { if (!cancelled) setFallback(true) })
    return () => { cancelled = true }
  }, [art.key, fallback])

  // 新手流程：每进一步，从这一步的开头算时间；跳过的步骤直接算画完
  useEffect(() => {
    const state = engine.current
    if (!state) return
    if (!intro) { state.intro = undefined; paint(); return }
    const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches
    const now = performance.now()
    const previous = state.intro
    const next: Intro = previous ?? { step: intro, enteredAt: now, room: ROOM_STROKE, her: HER_STROKE, roomT: 0, herT: 0, seed: Math.random() * 50 }
    const index = INTRO_ORDER.indexOf(intro)
    if (!previous || INTRO_ORDER.indexOf(previous.step) > index) {
      // 第一次进入或往回退：从白纸重新画
      state.renderer.resetReveal(0, 0)
      next.roomT = 0
      next.herT = 0
    }
    if (index > INTRO_ORDER.indexOf('drawing')) { state.renderer.resetReveal(1, 1); next.roomT = ROOM_DRAW_MS; next.herT = HER_DRAW_MS }
    next.step = intro
    next.enteredAt = reduced ? now - 60_000 : now
    state.intro = next
    if (!next.empty) {
      const src = sceneSrc('empty')
      // 开发模式下 StrictMode 会先拆掉第一个渲染器，它没载完的图会失败：只有当前这个渲染器失败才退回 CSS 版
      if (src) state.renderer.layer(src).then((layer) => { if (engine.current === state && state.intro === next) { next.empty = layer; paint() } }, () => { if (engine.current === state) setFallback(true) })
    }
    paint()
  }, [intro, fallback])

  // 存档恢复：同一次恢复只播一次（应用重启后收据还在，直到用户收起）
  useEffect(() => {
    const state = engine.current
    if (!state || !restoreId || playedRestore() === restoreId) return
    rememberRestore(restoreId)
    if (state.current) { setQuillTouch(restoreId); start('wash', RESTORE_MS); paint() }
    else state.pendingRestore = restoreId
  }, [restoreId, fallback])

  // 退回 CSS 版：原来的径向遮罩把整景淡进纸里，没有铅笔层
  if (fallback) return <div className="room-color"><Character art={art} /></div>
  return (
    <>
      <canvas ref={canvasRef} className="room-wash" data-art={art.key} aria-hidden />
      {/* 新手流程里画房间的那支铅笔：铅笔是你 */}
      {intro && <div ref={penRef} className="intro-pencil" data-visible="false" aria-hidden><PencilArt /></div>}
      {/* 颜色从羽毛笔的笔尖晕开（体验设计 §2、视频第 18 镜） */}
      {quillTouch && (
        <div key={quillTouch} className="wash-quill" style={{ left: `${ORIGIN[0] * 100}%`, top: `${ORIGIN[1] * 100}%` }}
          onAnimationEnd={() => setQuillTouch(null)}>
          <QuillArt />
        </div>
      )}
    </>
  )
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
