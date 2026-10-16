import type { WindowsView } from '../../shared'

export type MiniFallbackReason = NonNullable<WindowsView['miniFallbackReason']>
/** The four outer corners of Claude's mini route are intentionally transparent. Only detect opaque black. */
export function hasBlackMiniCorners(bitmap: Uint8Array, width: number, height: number) {
  if (width < 4 || height < 4 || bitmap.length !== width * height * 4) return false
  const corners = [[1, 1], [width - 2, 1], [1, height - 2], [width - 2, height - 2]]
  return corners.every(([x, y]) => { const offset = (y * width + x) * 4; return bitmap[offset + 3] >= 250 && bitmap[offset] < 24 && bitmap[offset + 1] < 24 && bitmap[offset + 2] < 24 })
}
/** Native window region: opaque fallback needs rounded corners even without DWM rounded-frame support. */
export function roundedMiniShape(width: number, height: number) {
  const radius = Math.min(18, Math.floor(Math.min(width, height) / 2)); const rects: { x: number; y: number; width: number; height: number }[] = []
  for (let y = 0; y < radius; y++) {
    const dy = radius - y - 0.5; const inset = Math.ceil(radius - Math.sqrt(radius * radius - dy * dy))
    rects.push({ x: inset, y, width: width - inset * 2, height: 1 }, { x: inset, y: height - y - 1, width: width - inset * 2, height: 1 })
  }
  if (height > radius * 2) rects.push({ x: 0, y: radius, width, height: height - radius * 2 })
  return rects
}
