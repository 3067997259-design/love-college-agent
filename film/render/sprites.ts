/**
 * 片子里的小东西：你手里的铅笔、她的羽毛笔（造型和应用里同一份 SVG：WashRoom.tsx 的 PencilArt、quill/QuillArt.tsx）、
 * 风里的花瓣和树叶。都画成画布，交给 Engine.sprite 变成纹理。
 */

/** 铅笔：viewBox 100×100，笔尖在 (11, 90.5) */
export const PENCIL_TIP = [11 / 100, 90.5 / 100] as const
const PENCIL_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
<g stroke="#4a4d55" stroke-width="1.6" stroke-linejoin="round">
<path d="M30 70 L 86 14 L 96 24 L 40 80 Z" fill="#cfd5df"/>
<path d="M36 76 L 90 22" fill="none" opacity="0.5"/>
<path d="M30 70 L 40 80 L 12 90 Z" fill="#ead2ad"/>
<path d="M12 90 L 18 81 L 21 84 Z" fill="#55585f"/>
<path d="M86 14 L 96 24 L 99 21 L 89 11 Z" fill="#e9c0b6"/>
</g></svg>`

/** 羽毛笔：viewBox 48×240，笔尖在 (24, 236) */
export const QUILL_TIP = [24 / 48, 236 / 240] as const
const QUILL_SVG = (inked: boolean) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 240">
<defs>
<linearGradient id="vane" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fffbf6"/><stop offset="0.7" stop-color="#fdf1ea"/><stop offset="1" stop-color="#f8d5c8"/></linearGradient>
<linearGradient id="nib" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#9c7c3c"/><stop offset="0.45" stop-color="#e3c785"/><stop offset="1" stop-color="#a8873f"/></linearGradient>
</defs>
<g fill="none" stroke="#4d3f45" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round">
<path fill="url(#vane)" d="M24 6 C 34 22, 42 60, 40 98 C 38 122, 32 140, 26 152 L 22 150 C 18 138, 13 118, 12 96 C 10 62, 16 26, 24 6 Z"/>
<path stroke-width="0.8" opacity="0.65" d="M25 40 Q 33 36, 38 30 M25 62 Q 34 58, 40 52 M25 84 Q 34 80, 40 75 M25 106 Q 33 103, 38 98 M25 126 Q 31 124, 34 120 M23 50 Q 16 46, 13 41 M23 74 Q 15 70, 12 64 M23 98 Q 16 95, 13 90 M23 120 Q 18 118, 15 114"/>
<path stroke-width="1" d="M40 70 L 33 74 L 40 77" fill="#fdf6f0"/>
<path d="M24 10 L 24 162"/>
<path fill="url(#nib)" d="M20.5 163 L 27.5 163 L 26.5 196 L 24 234 L 21.5 196 Z"/>
<path stroke-width="0.9" d="M24 199 L 24 230"/>
<circle cx="24" cy="196" r="1.3" fill="#4d3f45" stroke="none"/>
</g>
<g fill="#2e3350" stroke="#1d2036" stroke-width="0.8" stroke-linejoin="round">
<rect x="20" y="150" width="8" height="14" rx="2"/>
<path d="M21 156 C 13 149, 11 162, 20.5 159 Z"/>
<path d="M27 156 C 35 149, 37 162, 27.5 159 Z"/>
<path d="M22.5 160 L 18.5 172 L 21 171 L 23.5 161 Z M25.5 160 L 29.5 172 L 27 171 L 24.5 161 Z"/>
</g>
${inked ? '<circle cx="24" cy="235" r="2.8" fill="#e9a28f" stroke="#76382e" stroke-width="0.8"/>' : ''}
</svg>`

/** 笔尖那滴墨的颜色：片子里第一个出现的颜色（QuillArt 的 .quill-ink） */
export const INK = [0xe9 / 255, 0xa2 / 255, 0x8f / 255] as const

async function svgCanvas(svg: string, width: number, height: number): Promise<HTMLCanvasElement> {
  const image = new Image()
  image.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg)
  await image.decode()
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  canvas.getContext('2d')!.drawImage(image, 0, 0, width, height)
  return canvas
}

export const pencilCanvas = () => svgCanvas(PENCIL_SVG, 512, 512)
export const quillCanvas = (inked = true) => svgCanvas(QUILL_SVG(inked), 240, 1200)

/** 花瓣：桃色，一头带小缺口，边缘深一点 */
export function petalCanvas(): HTMLCanvasElement {
  const canvas = document.createElement('canvas')
  canvas.width = 96
  canvas.height = 96
  const ctx = canvas.getContext('2d')!
  ctx.translate(48, 48)
  const path = new Path2D('M0 -38 C 22 -30, 30 4, 12 30 Q 6 38, 0 32 Q -6 38, -12 30 C -30 4, -22 -30, 0 -38 Z')
  const fill = ctx.createLinearGradient(0, -38, 0, 36)
  fill.addColorStop(0, '#fde6df')
  fill.addColorStop(1, '#f2b5a8')
  ctx.fillStyle = fill
  ctx.fill(path)
  ctx.strokeStyle = 'rgba(190, 120, 108, 0.55)'
  ctx.lineWidth = 2
  ctx.stroke(path)
  return canvas
}

/** 树叶：两头尖，中间一道叶脉 */
export function leafCanvas(): HTMLCanvasElement {
  const canvas = document.createElement('canvas')
  canvas.width = 96
  canvas.height = 96
  const ctx = canvas.getContext('2d')!
  ctx.translate(48, 48)
  ctx.rotate(-0.5)
  const path = new Path2D('M-40 0 C -20 -20, 20 -20, 40 0 C 20 20, -20 20, -40 0 Z')
  const fill = ctx.createLinearGradient(-40, -16, 40, 16)
  fill.addColorStop(0, '#c9dca4')
  fill.addColorStop(1, '#95b87a')
  ctx.fillStyle = fill
  ctx.fill(path)
  ctx.strokeStyle = 'rgba(80, 110, 70, 0.5)'
  ctx.lineWidth = 2
  ctx.stroke(path)
  ctx.beginPath()
  ctx.moveTo(-36, 0)
  ctx.lineTo(36, 0)
  ctx.stroke()
  return canvas
}
