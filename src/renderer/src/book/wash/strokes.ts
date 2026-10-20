/**
 * 笔画：铅笔的排线路径、颜色的笔触路径、手描录下来的路径，以及沿路径要印的笔刷。
 * 纯函数，不碰 DOM 和 WebGL，单测直接引用。坐标都是房间图的纹理坐标（0–1，y 向下）。
 */

export interface PathPoint { x: number; y: number; t: number; down: boolean; p?: number }
export interface Stroke { points: readonly PathPoint[]; durationMs: number }
/** 笔刷：半径、每个印章的强度、沿笔画方向的长宽比、毛边程度；pressure 为真时半径跟着手描的压力变 */
export interface StampStyle { radius: number; strength: number; aspect: number; ragged: number; pressure?: boolean }
/** 一个印章占的浮点数：x, y, 半径, 强度, 方向, 长宽比 */
export const STAMP_FLOATS = 6

/** 抬笔移动按下笔速度的 3 倍（练习记录） */
const PEN_UP_SPEED = 3

/** 一笔里的快慢：起笔和收笔慢一些，中间快；不会停住（两头仍有 0.4 的速度），也不改总时长 */
export const strokeEase = (f: number) => 0.4 * f + 0.6 * f * f * (3 - 2 * f)

/** 按长度分时间：抬笔快三倍；每一笔按下的那段起落有快慢，像手在画（2026-10-20 用户：笔的动画再自然一点） */
function timed(raw: readonly { x: number; y: number; down: boolean; p?: number }[], durationMs: number): Stroke {
  let total = 0
  const weights = raw.map((point, i) => {
    if (i === 0) return 0
    const d = Math.hypot(point.x - raw[i - 1].x, point.y - raw[i - 1].y)
    const w = point.down ? d : d / PEN_UP_SPEED
    total += w
    return w
  })
  let acc = 0
  const points = raw.map((point, i) => { acc += weights[i]; return { ...point, t: total > 0 ? acc / total * durationMs : 0 } })
  // 连续按着的一段（从落笔前那一点到最后一个按着的点）里重新分配时间
  for (let start = 0; start < points.length - 1; start++) {
    if (!points[start + 1].down) continue
    let end = start + 1
    while (end + 1 < points.length && points[end + 1].down) end++
    const t0 = points[start].t, t1 = points[end].t
    if (t1 > t0) for (let i = start + 1; i < end; i++) points[i].t = t0 + (t1 - t0) * strokeEase((points[i].t - t0) / (t1 - t0))
    start = end - 1
  }
  return { points, durationMs }
}

/** 铅笔的来回排线：一行一行地画，带起伏和斜度，行间抬笔（没有手描路径时的自动做法） */
export function scribble(bounds: { x0: number; y0: number; x1: number; y1: number }, rows: number, durationMs: number, seed = 1): Stroke {
  const rand = mulberry32(seed)
  const raw: { x: number; y: number; down: boolean }[] = []
  const height = bounds.y1 - bounds.y0
  for (let row = 0; row < rows; row++) {
    const y = bounds.y0 + (row + 0.5) * height / rows
    const leftToRight = row % 2 === 0
    const slope = (rand() - 0.5) * 0.06
    const phase = rand() * Math.PI * 2
    for (let i = 0; i <= 24; i++) {
      const f = i / 24
      const x = leftToRight ? bounds.x0 + f * (bounds.x1 - bounds.x0) : bounds.x1 - f * (bounds.x1 - bounds.x0)
      raw.push({ x, y: y + Math.sin(phase + f * 9) * 0.012 + (rand() - 0.5) * 0.006 + slope * (f - 0.5), down: i > 0 })
    }
  }
  return timed(raw, durationMs)
}

/** 一块区域：中心、长轴方向、沿长轴和横向的半长 */
export interface Region { cx: number; cy: number; angle: number; halfLength: number; halfWidth: number }

/** 多边形的主方向（顶点的主成分）和两个方向上的半长：笔触顺着长的那一边走 */
export function regionOf(points: readonly (readonly [number, number])[]): Region {
  const n = points.length
  const cx = points.reduce((s, p) => s + p[0], 0) / n
  const cy = points.reduce((s, p) => s + p[1], 0) / n
  let xx = 0, yy = 0, xy = 0
  for (const [x, y] of points) { xx += (x - cx) ** 2; yy += (y - cy) ** 2; xy += (x - cx) * (y - cy) }
  const angle = 0.5 * Math.atan2(2 * xy, xx - yy)
  const ux = Math.cos(angle), uy = Math.sin(angle)
  let along = 0, across = 0
  for (const [x, y] of points) {
    along = Math.max(along, Math.abs((x - cx) * ux + (y - cy) * uy))
    across = Math.max(across, Math.abs(-(x - cx) * uy + (y - cy) * ux))
  }
  return { cx, cy, angle, halfLength: Math.max(along, 0.004), halfWidth: Math.max(across, 0.004) }
}

/**
 * 颜色的笔触：顺着区域的长轴来回刷，每笔略带弧度、两头多刷出去一点（遮罩会把出界的部分挡掉），笔与笔之间抬笔。
 * order='outward' 时从中间那一笔开始往两边铺（新手流程里颜色从她身上开始）。返回路径和合适的笔刷半径。
 */
export function brushStrokes(region: Region, count: number, durationMs: number, seed = 1, order: 'sweep' | 'outward' = 'sweep'): { stroke: Stroke; radius: number } {
  const rand = mulberry32(seed)
  const { cx, cy, angle, halfLength, halfWidth } = region
  const ux = Math.cos(angle), uy = Math.sin(angle)
  const vx = -uy, vy = ux
  const radius = Math.max(0.012, 1.3 * halfWidth / count)
  const lanes = Array.from({ length: count }, (_, i) => i)
  if (order === 'outward') lanes.sort((a, b) => Math.abs(a - (count - 1) / 2) - Math.abs(b - (count - 1) / 2) || a - b)
  const raw: { x: number; y: number; down: boolean }[] = []
  lanes.forEach((lane, k) => {
    const offset = -halfWidth + (lane + 0.5) * 2 * halfWidth / count + (rand() - 0.5) * radius * 0.5
    const forward = k % 2 === 0
    const bow = (rand() - 0.5) * halfWidth * 0.35
    const reach = halfLength + radius * (0.6 + rand() * 0.6)
    const steps = 16
    for (let i = 0; i <= steps; i++) {
      const f = i / steps
      const s = (forward ? -1 : 1) * reach * (1 - 2 * f)
      const o = offset + bow * Math.sin(f * Math.PI) + (rand() - 0.5) * radius * 0.15
      raw.push({ x: cx + ux * s + vx * o, y: cy + uy * s + vy * o, down: i > 0 })
    }
  })
  return { stroke: timed(raw, durationMs), radius }
}

/** 手描录下来的路径：抬笔的空档压到 120 ms 以内，再整体缩放到目标时长 */
export function tracedStroke(raw: readonly PathPoint[], durationMs: number): Stroke {
  if (raw.length < 2) return { points: raw.map((p) => ({ ...p, t: 0 })), durationMs }
  const points: PathPoint[] = []
  let shift = 0
  for (let i = 0; i < raw.length; i++) {
    const p = raw[i]
    if (i > 0 && !p.down) {
      const gap = p.t - raw[i - 1].t
      if (gap > 120) shift += gap - 120
    }
    points.push({ ...p, t: p.t - raw[0].t - shift })
  }
  const span = points[points.length - 1].t || 1
  return { points: points.map((p) => ({ ...p, t: p.t / span * durationMs })), durationMs }
}

/** 时间 t 时笔尖在哪、是否按着；超出时长停在终点并抬笔 */
export function penAt(stroke: Stroke, t: number): { x: number; y: number; down: boolean } {
  const pts = stroke.points
  if (pts.length === 0) return { x: 0.5, y: 0.5, down: false }
  if (t <= 0) return { x: pts[0].x, y: pts[0].y, down: false }
  if (t >= stroke.durationMs) { const last = pts[pts.length - 1]; return { x: last.x, y: last.y, down: false } }
  let i = 1
  while (i < pts.length && pts[i].t < t) i++
  if (i >= pts.length) { const last = pts[pts.length - 1]; return { x: last.x, y: last.y, down: false } }
  const a = pts[i - 1]
  const b = pts[i]
  const f = b.t > a.t ? (t - a.t) / (b.t - a.t) : 1
  return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f, down: b.down }
}

/** 两个时刻之间要印的笔刷：只取按笔的段，间距为半径的 0.3（练习记录）；方向顺着这一段 */
export function stampsBetween(stroke: Stroke, from: number, to: number, style: StampStyle): number[] {
  const out: number[] = []
  if (to <= from) return out
  const pts = stroke.points
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1]
    const b = pts[i]
    if (!b.down || b.t <= from || a.t >= to) continue
    const t0 = Math.max(a.t, from)
    const t1 = Math.min(b.t, to)
    const span = b.t - a.t
    const len = Math.hypot(b.x - a.x, b.y - a.y)
    const angle = Math.atan2(b.y - a.y, b.x - a.x)
    const pa = a.p ?? 0.5, pb = b.p ?? 0.5
    const step = style.radius * 0.3
    const n = Math.max(1, Math.ceil(len * (t1 - t0) / Math.max(span, 1e-6) / step))
    for (let k = 1; k <= n; k++) {
      const t = t0 + (t1 - t0) * k / n
      const f = span > 0 ? (t - a.t) / span : 1
      const radius = style.pressure ? style.radius * (0.55 + 0.9 * (pa + (pb - pa) * f)) : style.radius
      out.push(a.x + (b.x - a.x) * f, a.y + (b.y - a.y) * f, radius, style.strength, angle, style.aspect)
    }
  }
  return out
}

/** 你自己涂的一小段：从上一个指针位置到这一个，按下着 */
export function segment(a: { x: number; y: number }, b: { x: number; y: number }): Stroke {
  return { durationMs: 1, points: [{ x: a.x, y: a.y, t: 0, down: false }, { x: b.x, y: b.y, t: 1, down: true }] }
}

/**
 * 一件家具涂了多少：在它的形状里均匀撒一些采样点，笔刷扫过的点算涂过。
 * 只用来判断“涂了一大半，她可以接过去”，不追求和着色器逐像素一致。
 */
export function coverageOf(polygon: readonly (readonly [number, number])[], columns = 18) {
  const xs = polygon.map((p) => p[0]), ys = polygon.map((p) => p[1])
  const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys)
  const step = Math.max(x1 - x0, y1 - y0) / columns
  const samples: number[] = []
  for (let y = y0 + step / 2; y < y1; y += step) for (let x = x0 + step / 2; x < x1; x += step) if (insidePolygon(x, y, polygon)) samples.push(x, y)
  const covered = new Uint8Array(samples.length / 2)
  let count = 0
  return {
    /** 扫过一段；返回目前涂过的比例 */
    sweep(a: { x: number; y: number }, b: { x: number; y: number }, radius: number): number {
      const dx = b.x - a.x, dy = b.y - a.y, len2 = dx * dx + dy * dy
      for (let i = 0; i < covered.length; i++) {
        if (covered[i]) continue
        const px = samples[2 * i], py = samples[2 * i + 1]
        const f = len2 > 0 ? Math.max(0, Math.min(1, ((px - a.x) * dx + (py - a.y) * dy) / len2)) : 0
        if (Math.hypot(px - (a.x + dx * f), py - (a.y + dy * f)) <= radius) { covered[i] = 1; count++ }
      }
      return this.ratio()
    },
    ratio: () => covered.length ? count / covered.length : 1,
  }
}

/** 点在多边形里（偶奇规则） */
export function insidePolygon(x: number, y: number, polygon: readonly (readonly [number, number])[]): boolean {
  let inside = false
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i]
    const [xj, yj] = polygon[j]
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside
  }
  return inside
}

export function mulberry32(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
