import type { Camera } from './engine'

/** 时间轴上的小工具：都是纯函数，只看传进来的时刻 */

export const clamp = (x: number, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, x))
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t
export const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2)
export const easeOut = (t: number) => 1 - (1 - t) ** 3
export const easeIn = (t: number) => t * t * t
export const smooth = (t: number) => t * t * (3 - 2 * t)
/** start→end 之间的进度 0–1 */
export const span = (t: number, start: number, end: number) => clamp((t - start) / (end - start))

/** 一组关键帧 [时刻, 值]：段内按 ease 插值，两头保持 */
export function track(keys: readonly (readonly [number, number])[], t: number, ease = easeInOut): number {
  if (t <= keys[0][0]) return keys[0][1]
  for (let i = 1; i < keys.length; i++) {
    if (t <= keys[i][0]) return lerp(keys[i - 1][1], keys[i][1], ease(span(t, keys[i - 1][0], keys[i][0])))
  }
  return keys[keys.length - 1][1]
}

/** 镜头关键帧：位置线性、放大按对数插值（推拉的速度看起来均匀） */
export function cameraAt(keys: readonly (readonly [number, Camera])[], t: number, ease = easeInOut): Camera {
  if (t <= keys[0][0]) return keys[0][1]
  for (let i = 1; i < keys.length; i++) {
    if (t <= keys[i][0]) {
      const a = keys[i - 1][1]
      const b = keys[i][1]
      const f = ease(span(t, keys[i - 1][0], keys[i][0]))
      return { x: lerp(a.x, b.x, f), y: lerp(a.y, b.y, f), zoom: Math.exp(lerp(Math.log(a.zoom), Math.log(b.zoom), f)), roll: lerp(a.roll ?? 0, b.roll ?? 0, f) }
    }
  }
  return keys[keys.length - 1][1]
}

/** 到点执行一次的事件：帧按顺序推进，同样的帧序列永远触发同样的事件 */
export class Events {
  private readonly list: { at: number; run: () => void; done: boolean }[] = []
  at(at: number, run: () => void) { this.list.push({ at, run, done: false }); this.list.sort((a, b) => a.at - b.at); return this }
  advance(t: number) { for (const event of this.list) if (!event.done && t >= event.at) { event.done = true; event.run() } }
}

/** 可复现的随机数（和应用 strokes.ts 的 mulberry32 一样） */
export function random(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
