/**
 * 新手流程左页的时间线（体验设计 §7.1）：铅笔先画空房间，再勾出她；彩铅给她上简单的颜色；
 * 排线晕染成真实的颜色；最后颜色从她身上铺满整个房间。纯函数，不碰 DOM 和 WebGL，单测直接引用。
 *
 * 揭开铅笔层用笔刷沿路径印上去。自动路径是来回的排线（练习记录里的“涂抹”做法，全自动）；
 * 用户以后可以在调试模式里手描一条，替换这里的自动路径。
 */
import { washProgress, washRadius } from './wash-math'

export type IntroStep = 'paper' | 'drawing' | 'flat' | 'real' | 'room' | 'done'
export const INTRO_ORDER: readonly IntroStep[] = ['paper', 'drawing', 'flat', 'real', 'room', 'done']

export interface PathPoint { x: number; y: number; t: number; down: boolean }
export interface Stroke { points: readonly PathPoint[]; durationMs: number; radius: number }

export const ROOM_DRAW_MS = 6500
export const HER_DRAW_MS = 2800
export const FLAT_MS = 1600
export const REAL_MS = 2200
export const ROOM_COLOR_MS = 6000
/** 她周围那一圈：先在这里上色，最后才铺到整个房间（纹理坐标半径） */
export const HER_RADIUS = 0.3
export const ROOM_RADIUS = 0.82

/** 抬笔移动按下笔速度的 3 倍（练习记录） */
const PEN_UP_SPEED = 3

/**
 * 来回排线：在矩形里一行一行地画，每行带一点起伏和斜度，行与行之间抬笔。
 * 时间按长度分配：下笔匀速，抬笔快三倍。seed 决定起伏，同一个 seed 结果相同。
 */
export function scribble(bounds: { x0: number; y0: number; x1: number; y1: number }, rows: number, durationMs: number, radius: number, seed = 1): Stroke {
  const raw: { x: number; y: number; down: boolean }[] = []
  const rand = mulberry32(seed)
  const height = bounds.y1 - bounds.y0
  for (let row = 0; row < rows; row++) {
    const y = bounds.y0 + (row + 0.5) * height / rows
    const leftToRight = row % 2 === 0
    const slope = (rand() - 0.5) * 0.06
    const phase = rand() * Math.PI * 2
    const steps = 24
    for (let i = 0; i <= steps; i++) {
      const f = i / steps
      const x = leftToRight ? bounds.x0 + f * (bounds.x1 - bounds.x0) : bounds.x1 - f * (bounds.x1 - bounds.x0)
      const wobble = Math.sin(phase + f * 9) * 0.012 + (rand() - 0.5) * 0.006
      raw.push({ x, y: y + wobble + slope * (f - 0.5), down: i > 0 })
    }
  }
  // 按长度分时间
  let weighted = 0
  const lengths = raw.map((p, i) => {
    if (i === 0) return 0
    const d = Math.hypot(p.x - raw[i - 1].x, p.y - raw[i - 1].y)
    const w = p.down ? d : d / PEN_UP_SPEED
    weighted += w
    return w
  })
  let acc = 0
  const points = raw.map((p, i) => { acc += lengths[i]; return { ...p, t: weighted > 0 ? acc / weighted * durationMs : 0 } })
  return { points, durationMs, radius }
}

/** 时间 t 时笔尖在哪、是否按着；超出时长停在终点并抬笔 */
export function penAt(stroke: Stroke, t: number): { x: number; y: number; down: boolean } {
  const pts = stroke.points
  if (t <= 0) return { x: pts[0].x, y: pts[0].y, down: false }
  if (t >= stroke.durationMs) { const last = pts[pts.length - 1]; return { x: last.x, y: last.y, down: false } }
  let i = 1
  while (i < pts.length && pts[i].t < t) i++
  const a = pts[i - 1]
  const b = pts[i]
  const f = b.t > a.t ? (t - a.t) / (b.t - a.t) : 1
  return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f, down: b.down }
}

/**
 * 两个时刻之间要印的笔刷：只取按笔的段，间距为半径的 0.3（练习记录）。返回 [x, y, 半径, 强度] 的平铺数组。
 */
export function stampsBetween(stroke: Stroke, from: number, to: number): number[] {
  const out: number[] = []
  if (to <= from) return out
  const spacing = stroke.radius * 0.3
  const pts = stroke.points
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1]
    const b = pts[i]
    if (!b.down || b.t <= from || a.t >= to) continue
    const t0 = Math.max(a.t, from)
    const t1 = Math.min(b.t, to)
    const len = Math.hypot(b.x - a.x, b.y - a.y)
    const span = b.t - a.t
    const n = Math.max(1, Math.ceil(len * (t1 - t0) / Math.max(span, 1e-6) / spacing))
    for (let k = 1; k <= n; k++) {
      const t = t0 + (t1 - t0) * k / n
      const f = span > 0 ? (t - a.t) / span : 1
      out.push(a.x + (b.x - a.x) * f, a.y + (b.y - a.y) * f, stroke.radius, 1)
    }
  }
  return out
}

export interface IntroFrame {
  /** 房间铅笔已经画了多久（毫秒，按房间那条路径的时间） */
  roomT: number
  /** 她的线稿画了多久 */
  herT: number
  /** 颜色覆盖到的半径 */
  coverRadius: number
  /** 真实颜色覆盖到的半径（之内是真实颜色，之外是彩铅的简单颜色） */
  realRadius: number
  /** 晕染前沿的湿边干到什么程度 */
  dry: number
}

/** 某一步开始后 elapsed 毫秒时左页的状态；之前的步骤都算做完 */
export function introFrame(step: IntroStep, elapsed: number): IntroFrame {
  const index = INTRO_ORDER.indexOf(step)
  const at = (s: IntroStep) => INTRO_ORDER.indexOf(s)
  const frame: IntroFrame = { roomT: 0, herT: 0, coverRadius: 0, realRadius: 0, dry: 1 }
  if (index > at('drawing')) { frame.roomT = ROOM_DRAW_MS; frame.herT = HER_DRAW_MS }
  else if (index === at('drawing')) { frame.roomT = Math.min(elapsed, ROOM_DRAW_MS); frame.herT = Math.max(0, Math.min(elapsed - ROOM_DRAW_MS, HER_DRAW_MS)) }
  if (index > at('flat')) frame.coverRadius = HER_RADIUS
  else if (index === at('flat')) { frame.coverRadius = washRadius(elapsed, FLAT_MS, HER_RADIUS); frame.dry = washProgress(elapsed, FLAT_MS) }
  if (index > at('real')) frame.realRadius = HER_RADIUS
  else if (index === at('real')) { frame.realRadius = washRadius(elapsed, REAL_MS, HER_RADIUS); frame.dry = washProgress(elapsed, REAL_MS) }
  if (index === at('room')) {
    const r = HER_RADIUS + washRadius(elapsed, ROOM_COLOR_MS, ROOM_RADIUS - HER_RADIUS)
    frame.coverRadius = r
    frame.realRadius = r
    frame.dry = washProgress(elapsed, ROOM_COLOR_MS)
  } else if (index > at('room')) { frame.coverRadius = ROOM_RADIUS; frame.realRadius = ROOM_RADIUS }
  return frame
}

/** 这一步的动画总时长：到点后左页不再变化 */
export function introDuration(step: IntroStep): number {
  return ({ paper: 0, drawing: ROOM_DRAW_MS + HER_DRAW_MS, flat: FLAT_MS, real: REAL_MS, room: ROOM_COLOR_MS, done: 0 })[step]
}

function mulberry32(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
