export interface Bounds { x: number; y: number; width: number; height: number }
export function clampMiniBounds(bounds: Bounds, area: Bounds): Bounds {
  const width = Math.min(bounds.width, area.width); const height = Math.min(bounds.height, area.height)
  return { x: Math.round(Math.min(area.x + area.width - width, Math.max(area.x, bounds.x))), y: Math.round(Math.min(area.y + area.height - height, Math.max(area.y, bounds.y))), width, height }
}
