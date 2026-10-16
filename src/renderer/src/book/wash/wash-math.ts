/**
 * 晕染的时间曲线（体验设计 §7.1 赛前练习记下的做法，赛中重写）。只用起点和开始时间算，不做流体模拟：
 * 半径 r = rmax·(1 − e^(−k·t))，先快后慢，像墨被纸吸住；到点前最后两成时间里湿边慢慢干掉。
 * 纯函数，不碰 DOM 和 WebGL，单测直接引用。
 */

/** 时长 T 内走到 98%：1 − e^(−kT) = 0.98 */
const K98 = Math.log(50)

export function washRadius(elapsedMs: number, durationMs: number, rmax: number): number {
  if (durationMs <= 0) return rmax
  const t = Math.max(0, elapsedMs)
  return rmax * (1 - Math.exp(-K98 * t / durationMs))
}

/** 进度 0–1；超过时长就是 1（之后强制填满） */
export function washProgress(elapsedMs: number, durationMs: number): number {
  if (durationMs <= 0) return 1
  return Math.min(1, Math.max(0, elapsedMs / durationMs))
}

/** 湿边在进度 0.8–1 之间干掉，否则最远处会一直留着一圈深边 */
export function dryness(progress: number): number {
  return smoothstep(0.8, 1, progress)
}

/** 噪点强度随半径收小：刚起步时噪点比半径还大，会冒出零碎的斑点 */
export function noiseAmplitude(radius: number, amplitude: number, ramp = 0.12): number {
  return amplitude * Math.min(1, Math.max(0, radius / ramp))
}

/** 同一姿势只换表情或光照时交叉淡化，换姿势才重新晕染 */
export function transitionKind(previousKey: string | null, nextKey: string): 'none' | 'crossfade' | 'wash' {
  if (previousKey === null || previousKey === nextKey) return 'none'
  return poseOf(previousKey) === poseOf(nextKey) ? 'crossfade' : 'wash'
}

export const poseOf = (key: string) => key.split('_')[0]

export function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)))
  return t * t * (3 - 2 * t)
}
