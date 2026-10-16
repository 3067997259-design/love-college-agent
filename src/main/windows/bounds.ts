export interface Bounds { x: number; y: number; width: number; height: number }
export const MINI_SIZE = { width: 280, height: 350 } as const
export function defaultMiniBounds(area: Bounds): Bounds {
  return clampMiniBounds({ x: area.x + area.width - MINI_SIZE.width - 24, y: area.y + area.height - MINI_SIZE.height - 24, ...MINI_SIZE }, area)
}
/** A removed display or an off-screen saved rectangle returns to the primary display's default corner. */
export function restoreMiniBounds(saved: { x: number; y: number; displayId?: number } | undefined, displays: readonly { id: number; workArea: Bounds }[], primaryArea: Bounds): Bounds {
  if (saved) {
    const fits = (area: Bounds) => saved.x >= area.x && saved.y >= area.y && saved.x + MINI_SIZE.width <= area.x + area.width && saved.y + MINI_SIZE.height <= area.y + area.height
    const display = displays.find((display) => (saved.displayId === undefined || saved.displayId === display.id) && fits(display.workArea))
    if (display) return { x: saved.x, y: saved.y, ...MINI_SIZE }
  }
  return defaultMiniBounds(primaryArea)
}
export function clampMiniBounds(bounds: Bounds, area: Bounds): Bounds {
  const width = Math.min(bounds.width, area.width); const height = Math.min(bounds.height, area.height)
  return { x: Math.round(Math.min(area.x + area.width - width, Math.max(area.x, bounds.x))), y: Math.round(Math.min(area.y + area.height - height, Math.max(area.y, bounds.y))), width, height }
}
/** Accumulate sub-DIP remainders, so repeated 1 physical-pixel moves neither vanish nor accelerate at high DPI. */
export function moveMiniByPixels(current: Bounds, dx: number, dy: number, area: Bounds, scaleFactor: number, remainder = { x: 0, y: 0 }) {
  const scale = Number.isFinite(scaleFactor) && scaleFactor > 0 ? scaleFactor : 1
  const width = Math.min(current.width, area.width); const height = Math.min(current.height, area.height)
  const x = Math.min(area.x + area.width - width, Math.max(area.x, current.x + dx / scale + remainder.x))
  const y = Math.min(area.y + area.height - height, Math.max(area.y, current.y + dy / scale + remainder.y))
  const bounds = clampMiniBounds({ ...current, x, y }, area)
  return { bounds, remainder: { x: x - bounds.x, y: y - bounds.y } }
}
