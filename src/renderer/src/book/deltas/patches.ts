/**
 * 差分贴片（2026-10-17 晚采用）：眨眼、抬头、说话嘴型都是同一张 approved 底图上的局部变体。
 * 交付时已按多边形只改面部，所以运行时只把变体的“变化矩形”裁成透明/不透明整块贴回原位，
 * 不整帧切换、不走晕染转场，边缘不会露缝。位置与来源见 assets/character/taozi/deltas/manifest.json。
 */
export type DeltaVariant = 'blink' | 'look-up' | 'mouth-half' | 'mouth-open'

export interface DeltaPatch {
  id: string
  src: string
  /** 相对 600×600 房间的百分比，直接给 <img style> 用 */
  left: number
  top: number
  width: number
  height: number
}

interface PatchEntry {
  id: string
  baseKey: string
  variant: DeltaVariant
  rect: [number, number, number, number]
  canvas: [number, number]
}

const files = import.meta.glob('../../assets/character/taozi/deltas/*.png', { eager: true, query: '?url', import: 'default' }) as Record<string, string>
import manifest from '../../assets/character/taozi/deltas/manifest.json'

const entries = (manifest as unknown as { patches: PatchEntry[] }).patches
const cache = new Map<string, DeltaPatch | null>()

export function deltaPatch(baseKey: string, variant: DeltaVariant): DeltaPatch | undefined {
  const cacheKey = `${baseKey}|${variant}`
  if (cache.has(cacheKey)) return cache.get(cacheKey) ?? undefined
  const entry = entries.find((item) => item.baseKey === baseKey && item.variant === variant)
  const src = entry ? files[`../../assets/character/taozi/deltas/${entry.id}.png`] : undefined
  if (!entry || !src) {
    cache.set(cacheKey, null)
    return undefined
  }
  const [x, y, w, h] = entry.rect
  const [cw, ch] = entry.canvas
  const patch: DeltaPatch = {
    id: entry.id, src,
    left: (x / cw) * 100, top: (y / ch) * 100, width: (w / cw) * 100, height: (h / ch) * 100,
  }
  cache.set(cacheKey, patch)
  return patch
}
