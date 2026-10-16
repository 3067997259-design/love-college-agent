import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Character, sceneSrc } from '../Character'
import type { CharacterArt } from '../characterArt'
import { WashRenderer, type Frame, type Layer } from './renderer'
import { dryness, noiseAmplitude, transitionKind, washProgress, washRadius } from './wash-math'

/**
 * 左页房间的画：颜色聚在她周围、往外褪成铅笔（铅笔是你的，颜色是她的）。
 * - 换姿势：先是新姿势的铅笔，颜色从她身上晕开（--dur-wash，1.4 s）；同一姿势换表情或光照只交叉淡化。
 * - 存档恢复：应用重启后第一次看到这次恢复，颜色从一点慢慢长回来（约 6 s，和视频第 18 镜同一个意思）。
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

export function WashRoom({ art, restoreId }: { art: CharacterArt; restoreId: string | null }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [fallback, setFallback] = useState(false)
  const engine = useRef<{
    renderer: WashRenderer
    current?: Layer
    key?: string
    transition?: Transition
    pendingRestore?: string
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
      if (state.pendingRestore) { state.pendingRestore = undefined; start('wash', RESTORE_MS) }
      else if (kind === 'wash') start('wash', POSE_MS, previous)
      else if (kind === 'crossfade') start('crossfade', CROSSFADE_MS, previous)
      paint()
    }, () => { if (!cancelled) setFallback(true) })
    return () => { cancelled = true }
  }, [art.key, fallback])

  // 存档恢复：同一次恢复只播一次（应用重启后收据还在，直到用户收起）
  useEffect(() => {
    const state = engine.current
    if (!state || !restoreId || playedRestore() === restoreId) return
    rememberRestore(restoreId)
    if (state.current) { start('wash', RESTORE_MS); paint() }
    else state.pendingRestore = restoreId
  }, [restoreId, fallback])

  // 退回 CSS 版：原来的径向遮罩把整景淡进纸里，没有铅笔层
  if (fallback) return <div className="room-color"><Character art={art} /></div>
  return <canvas ref={canvasRef} className="room-wash" data-art={art.key} aria-hidden />
}

const PLAYED_KEY = 'lca:restore-wash'
function playedRestore(): string | null {
  try { return localStorage.getItem(PLAYED_KEY) } catch { return null }
}
function rememberRestore(id: string) {
  try { localStorage.setItem(PLAYED_KEY, id) } catch { /* 存不下就下次再播一遍，不影响恢复本身 */ }
}
