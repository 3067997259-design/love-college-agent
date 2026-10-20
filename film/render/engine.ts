import { COMPOSITE, DIFF, EXTRACT, OPEN, STAMP_FRAGMENT, STAMP_VERTEX, VERTEX } from '@wash/shaders'
import { regionOf, STAMP_FLOATS, type Region } from '@wash/strokes'
import { Painter, type Channel, type Job } from '@wash/painter'
import { FILM, PAPER, PLACE_FRAGMENT, PLACE_VERTEX } from './shaders'

/**
 * 短片的离线合成：一块 WebGL2 画布，按设计尺寸 1920×1080 摆层，逐帧读出像素。
 * 房间几镜用应用左页同一套着色器和笔触（renderer.ts、painter.ts 的做法照搬，参数一致），
 * 关键帧用 FILM 着色器。所有动画只看传进来的时刻，不读系统时间：同样的帧号永远出同样的画。
 */

export const DESIGN = { width: 1920, height: 1080 } as const

/** 一张图在 GPU 上：原彩色和提取出的铅笔层（第 0 行是图的顶边） */
export interface Img { src: string; color: WebGLTexture; pencil: WebGLTexture; width: number; height: number }
/** 可以画进去的纹理；合成进来的几遍上下颠倒（flip） */
export interface Target { texture: WebGLTexture; framebuffer: WebGLFramebuffer; width: number; height: number; mipmapped: boolean }
export interface HerMask { texture: WebGLTexture; region: Region | null }
export interface Sprite { texture: WebGLTexture; width: number; height: number }
/** 2D 仿射：x' = a x + c y + e，y' = b x + d y + f（和 canvas 的 setTransform 同序） */
export type Affine = readonly [number, number, number, number, number, number]

// 和应用 renderer.ts 一致
const GRAPHITE = [0x6b / 255, 0x6e / 255, 0x74 / 255] as const
const WET = 0.55
const VIGNETTE = { center: [0.52, 0.56], radius: [0.52, 0.54] } as const
const MASK_SIZE = 512
const CHANNELS: Record<Channel, readonly [number, number, number, number]> = {
  room: [1, 0, 0, 0], her: [0, 1, 0, 0], paint: [0, 0, 1, 0], real: [0, 0, 0, 1], 'paint+real': [0, 0, 1, 1],
}
const PAPER_COLOR = [0xfb / 255, 0xf7 / 255, 0xf0 / 255] as const

export interface AppPlateArgs {
  current: Img
  reveal: Target
  paint?: { dry: number; keepOutside?: WebGLTexture }
  intro?: { empty: Img }
}

export interface FilmPlateArgs {
  image: Img
  reveal?: Target
  lines?: number
  color?: number
  dry?: number
  /** 颜色、线稿边缘羽化宽度（以画面高为 1），毛边 */
  edge?: { color: number; lines: number; ragged: number }
  grade?: { brightness: number; saturation: number; tint: readonly [number, number, number]; amount: number }
  /** 风把颜色卷走：前沿位置、方向、带宽；push 是颜色被推走多远，streak 拉成一道道的程度，lines 为真时线稿也一起被卷走 */
  sweep?: { front: number; angle: number; width: number; push?: number; streak?: number; lines?: boolean }
  ink?: { x: number; y: number; radius: number; alpha: number; color: readonly [number, number, number] }
  time?: number
}

export interface PlaceOptions {
  alpha?: number
  flip?: boolean
  /** 左、上、右、下羽化（单位方块的比例） */
  feather?: readonly [number, number, number, number]
  ragged?: number
  multiply?: readonly [number, number, number]
}

export class Engine {
  readonly gl: WebGL2RenderingContext
  private readonly programs: Record<'extract' | 'diff' | 'open' | 'stamp' | 'app' | 'film' | 'place' | 'paper', Program>
  private readonly vao: WebGLVertexArrayObject
  private readonly stampVao: WebGLVertexArrayObject
  private readonly stampBuffer: WebGLBuffer
  private readonly blank: WebGLTexture
  private readonly scratch: Target
  private readonly herMasks = new Map<string, HerMask>()
  private readonly polygonMasks = new Map<string, WebGLTexture>()
  private pixels?: Uint8Array

  constructor(readonly canvas: HTMLCanvasElement) {
    const gl = canvas.getContext('webgl2', { alpha: false, premultipliedAlpha: true, antialias: false, preserveDrawingBuffer: true })
    if (!gl) throw new Error('需要 WebGL2')
    this.gl = gl
    this.programs = {
      extract: program(gl, VERTEX, EXTRACT), diff: program(gl, VERTEX, DIFF), open: program(gl, VERTEX, OPEN),
      stamp: program(gl, STAMP_VERTEX, STAMP_FRAGMENT), app: program(gl, VERTEX, COMPOSITE), film: program(gl, VERTEX, FILM),
      place: program(gl, PLACE_VERTEX, PLACE_FRAGMENT), paper: program(gl, VERTEX, PAPER),
    }
    this.vao = gl.createVertexArray()!
    this.stampBuffer = gl.createBuffer()!
    this.stampVao = gl.createVertexArray()!
    gl.bindVertexArray(this.stampVao)
    gl.bindBuffer(gl.ARRAY_BUFFER, this.stampBuffer)
    gl.enableVertexAttribArray(0)
    gl.vertexAttribPointer(0, 4, gl.FLOAT, false, STAMP_FLOATS * 4, 0)
    gl.vertexAttribDivisor(0, 1)
    gl.enableVertexAttribArray(1)
    gl.vertexAttribPointer(1, 2, gl.FLOAT, false, STAMP_FLOATS * 4, 16)
    gl.vertexAttribDivisor(1, 1)
    gl.bindVertexArray(null)
    this.blank = texture(gl, false)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([255, 255, 255, 255]))
    this.scratch = this.target(MASK_SIZE, MASK_SIZE, true)
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true)
  }

  /** 载入整景图并提取铅笔层（和应用同一个着色器）；pencilFrom 指定另一张图来提取（放大过的彩图配原图的线） */
  async image(src: string, pencilFrom?: string): Promise<Img> {
    const gl = this.gl
    const decode = async (url: string) => { const image = new Image(); image.src = url; await image.decode(); return image }
    const image = await decode(src)
    const color = texture(gl, true)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image)
    gl.generateMipmap(gl.TEXTURE_2D)
    let source = color
    let width = image.naturalWidth
    let height = image.naturalHeight
    if (pencilFrom) {
      const original = await decode(pencilFrom)
      source = texture(gl, true)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, original)
      gl.generateMipmap(gl.TEXTURE_2D)
      width = original.naturalWidth
      height = original.naturalHeight
    }
    const pencil = this.target(width, height, true)
    this.pass(this.programs.extract, pencil, [['uImage', source]], (p) => gl.uniform2f(p.uniform('uTexel'), 1 / width, 1 / height))
    gl.bindTexture(gl.TEXTURE_2D, pencil.texture)
    gl.generateMipmap(gl.TEXTURE_2D)
    if (source !== color) gl.deleteTexture(source)
    return { src, color, pencil: pencil.texture, width: image.naturalWidth, height: image.naturalHeight }
  }

  /** 普通贴图（书页截图、卡片、笔、花瓣）：不提取铅笔层 */
  async sprite(src: string | HTMLCanvasElement): Promise<Sprite> {
    const gl = this.gl
    let source: HTMLImageElement | HTMLCanvasElement
    if (typeof src === 'string') { const image = new Image(); image.src = src; await image.decode(); source = image } else source = src
    const handle = texture(gl, true)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source)
    gl.generateMipmap(gl.TEXTURE_2D)
    const width = source instanceof HTMLImageElement ? source.naturalWidth : source.width
    const height = source instanceof HTMLImageElement ? source.naturalHeight : source.height
    return { texture: handle, width, height }
  }

  target(width: number, height: number, mipmapped = false): Target {
    const gl = this.gl
    const handle = texture(gl, mipmapped)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null)
    if (mipmapped) gl.generateMipmap(gl.TEXTURE_2D)
    const framebuffer = gl.createFramebuffer()!
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer)
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, handle, 0)
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    return { texture: handle, framebuffer, width, height, mipmapped }
  }

  clear(target: Target, r: number, g: number, b: number, a: number) {
    const gl = this.gl
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.framebuffer)
    gl.viewport(0, 0, target.width, target.height)
    gl.clearColor(r, g, b, a)
    gl.clear(gl.COLOR_BUFFER_BIT)
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
  }

  /** 她的剪影：有她的图减空房间图（应用 renderer.ts 的 herMask） */
  herMask(pose: Img, empty: Img): HerMask {
    const cached = this.herMasks.get(pose.src)
    if (cached) return cached
    const gl = this.gl
    this.pass(this.programs.diff, this.scratch, [['uPose', pose.color], ['uEmpty', empty.color]])
    gl.bindTexture(gl.TEXTURE_2D, this.scratch.texture)
    gl.generateMipmap(gl.TEXTURE_2D)
    const mask = this.target(MASK_SIZE, MASK_SIZE)
    this.pass(this.programs.open, mask, [['uRaw', this.scratch.texture]])
    const pixels = new Uint8Array(MASK_SIZE * MASK_SIZE * 4)
    gl.bindFramebuffer(gl.FRAMEBUFFER, mask.framebuffer)
    gl.readPixels(0, 0, MASK_SIZE, MASK_SIZE, gl.RGBA, gl.UNSIGNED_BYTE, pixels)
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    const points: [number, number][] = []
    for (let y = 0; y < MASK_SIZE; y += 4) {
      for (let x = 0; x < MASK_SIZE; x += 4) if (pixels[(y * MASK_SIZE + x) * 4] > 128) points.push([(x + 0.5) / MASK_SIZE, (y + 0.5) / MASK_SIZE])
    }
    const result: HerMask = { texture: mask.texture, region: points.length > 40 ? regionOf(points) : null }
    this.herMasks.set(pose.src, result)
    return result
  }

  /** 一件家具的遮罩（应用 renderer.ts 的 polygonMask） */
  polygonMask(id: string, points: readonly (readonly [number, number])[]): WebGLTexture {
    const cached = this.polygonMasks.get(id)
    if (cached) return cached
    const canvas = document.createElement('canvas')
    canvas.width = MASK_SIZE
    canvas.height = MASK_SIZE
    const ctx = canvas.getContext('2d')!
    ctx.fillStyle = '#000'
    ctx.fillRect(0, 0, MASK_SIZE, MASK_SIZE)
    ctx.fillStyle = '#fff'
    ctx.beginPath()
    points.forEach(([x, y], i) => (i ? ctx.lineTo(x * MASK_SIZE, y * MASK_SIZE) : ctx.moveTo(x * MASK_SIZE, y * MASK_SIZE)))
    ctx.closePath()
    ctx.fill()
    const gl = this.gl
    const mask = texture(gl, false)
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, canvas)
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true)
    this.polygonMasks.set(id, mask)
    return mask
  }

  /** 沿路径印笔刷进揭开遮罩：铅笔取最大值，颜料相加，sub 是擦掉（颜色流走） */
  stamp(reveal: Target, data: readonly number[], channel: Channel, blend: 'max' | 'add' | 'sub', ragged: number, mask: WebGLTexture | null) {
    if (data.length === 0) return
    const gl = this.gl
    const p = this.programs.stamp
    gl.bindFramebuffer(gl.FRAMEBUFFER, reveal.framebuffer)
    gl.viewport(0, 0, reveal.width, reveal.height)
    gl.useProgram(p.handle)
    const c = CHANNELS[channel]
    gl.uniform4f(p.uniform('uChannel'), c[0], c[1], c[2], c[3])
    gl.uniform1f(p.uniform('uRagged'), ragged)
    gl.uniform1f(p.uniform('uUseMask'), mask ? 1 : 0)
    bind(gl, 0, mask ?? this.blank); gl.uniform1i(p.uniform('uMask'), 0)
    gl.bindVertexArray(this.stampVao)
    gl.bindBuffer(gl.ARRAY_BUFFER, this.stampBuffer)
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(data), gl.STREAM_DRAW)
    gl.enable(gl.BLEND)
    if (blend === 'max') gl.blendEquation(gl.MAX)
    else { gl.blendEquation(blend === 'add' ? gl.FUNC_ADD : gl.FUNC_REVERSE_SUBTRACT); gl.blendFunc(gl.ONE, gl.ONE) }
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, data.length / STAMP_FLOATS)
    gl.disable(gl.BLEND)
    gl.blendEquation(gl.FUNC_ADD)
    gl.bindVertexArray(null)
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
  }

  fill(reveal: Target, channel: Channel, level: number, mask: WebGLTexture | null, blend: 'max' | 'sub' = 'max') {
    this.stamp(reveal, [0.5, 0.5, 1.5, level, 0, 1], channel, blend, 0, mask)
  }

  /** 房间：应用左页的合成，画进方形目标纹理 */
  appPlate(out: Target, args: AppPlateArgs) {
    const gl = this.gl
    const p = this.programs.app
    gl.bindFramebuffer(gl.FRAMEBUFFER, out.framebuffer)
    gl.viewport(0, 0, out.width, out.height)
    gl.clearColor(0, 0, 0, 0)
    gl.clear(gl.COLOR_BUFFER_BIT)
    gl.useProgram(p.handle)
    bind(gl, 0, args.current.color); gl.uniform1i(p.uniform('uColor'), 0)
    bind(gl, 1, args.current.pencil); gl.uniform1i(p.uniform('uPencil'), 1)
    bind(gl, 2, args.current.color); gl.uniform1i(p.uniform('uPrev'), 2)
    bind(gl, 3, args.reveal.texture); gl.uniform1i(p.uniform('uReveal'), 3)
    bind(gl, 4, (args.intro?.empty ?? args.current).pencil); gl.uniform1i(p.uniform('uEmptyPencil'), 4)
    bind(gl, 5, args.paint?.keepOutside ?? this.blank); gl.uniform1i(p.uniform('uHerMask'), 5)
    gl.uniform1f(p.uniform('uHasPrev'), 0)
    gl.uniform1f(p.uniform('uPrevAlpha'), 0)
    gl.uniform1f(p.uniform('uPaint'), args.paint || args.intro ? 1 : 0)
    gl.uniform1f(p.uniform('uIntro'), args.intro ? 1 : 0)
    gl.uniform1f(p.uniform('uKeepOutside'), args.paint?.keepOutside ? 1 : 0)
    gl.uniform1f(p.uniform('uDry'), args.paint?.dry ?? 1)
    gl.uniform1f(p.uniform('uWet'), WET)
    gl.uniform2f(p.uniform('uRevealTexel'), 1.5 / args.reveal.width, 1.5 / args.reveal.height)
    gl.uniform2f(p.uniform('uVigCenter'), VIGNETTE.center[0], VIGNETTE.center[1])
    gl.uniform2f(p.uniform('uVigRadius'), VIGNETTE.radius[0], VIGNETTE.radius[1])
    gl.uniform3f(p.uniform('uGraphite'), GRAPHITE[0], GRAPHITE[1], GRAPHITE[2])
    gl.uniform1f(p.uniform('uPencilOpacity'), 0.8)
    gl.disable(gl.BLEND)
    gl.bindVertexArray(this.vao)
    gl.drawArrays(gl.TRIANGLES, 0, 3)
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    this.mipmap(out)
  }

  /** 关键帧：FILM 着色器，画进和图同比例的目标纹理 */
  filmPlate(out: Target, args: FilmPlateArgs) {
    const gl = this.gl
    const p = this.programs.film
    gl.bindFramebuffer(gl.FRAMEBUFFER, out.framebuffer)
    gl.viewport(0, 0, out.width, out.height)
    gl.clearColor(0, 0, 0, 0)
    gl.clear(gl.COLOR_BUFFER_BIT)
    gl.useProgram(p.handle)
    bind(gl, 0, args.image.color); gl.uniform1i(p.uniform('uColor'), 0)
    bind(gl, 1, args.image.pencil); gl.uniform1i(p.uniform('uPencil'), 1)
    bind(gl, 2, args.reveal?.texture ?? this.blank); gl.uniform1i(p.uniform('uReveal'), 2)
    gl.uniform1f(p.uniform('uUseReveal'), args.reveal ? 1 : 0)
    gl.uniform1f(p.uniform('uLines'), args.lines ?? 0.8)
    gl.uniform1f(p.uniform('uColorAmt'), args.color ?? 1)
    gl.uniform1f(p.uniform('uDry'), args.dry ?? 1)
    gl.uniform1f(p.uniform('uWet'), WET)
    gl.uniform2f(p.uniform('uRevealTexel'), 1.5 / (args.reveal?.width ?? 1024), 1.5 / (args.reveal?.height ?? 1024))
    gl.uniform3f(p.uniform('uGraphite'), GRAPHITE[0], GRAPHITE[1], GRAPHITE[2])
    const edge = args.edge ?? { color: 0, lines: 0, ragged: 0 }
    gl.uniform4f(p.uniform('uEdge'), edge.color, edge.ragged, edge.lines, 0)
    const grade = args.grade ?? { brightness: 1, saturation: 1, tint: [1, 1, 1], amount: 0 }
    gl.uniform3f(p.uniform('uGrade'), grade.brightness, grade.saturation, grade.amount)
    gl.uniform3f(p.uniform('uTint'), grade.tint[0], grade.tint[1], grade.tint[2])
    const sweep = args.sweep
    gl.uniform4f(p.uniform('uSweep'), sweep?.front ?? 0, sweep?.angle ?? 0, sweep?.width ?? 1, sweep ? 1 : 0)
    gl.uniform3f(p.uniform('uSweepStyle'), sweep?.push ?? 0.55, sweep?.streak ?? 1, sweep?.lines ? 1 : 0)
    gl.uniform1f(p.uniform('uTime'), args.time ?? 0)
    const ink = args.ink
    gl.uniform4f(p.uniform('uInk'), ink?.x ?? 0, ink?.y ?? 0, ink?.radius ?? 0, ink?.alpha ?? 0)
    gl.uniform3f(p.uniform('uInkColor'), ink?.color[0] ?? 0, ink?.color[1] ?? 0, ink?.color[2] ?? 0)
    gl.uniform1f(p.uniform('uAspect'), args.image.width / args.image.height)
    gl.disable(gl.BLEND)
    gl.bindVertexArray(this.vao)
    gl.drawArrays(gl.TRIANGLES, 0, 3)
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    this.mipmap(out)
  }

  /** 缩小贴（拉远看整本书）时要用多级纹理，不然铅笔线会闪 */
  private mipmap(target: Target) {
    if (!target.mipmapped) return
    this.gl.bindTexture(this.gl.TEXTURE_2D, target.texture)
    this.gl.generateMipmap(this.gl.TEXTURE_2D)
  }

  /** 开始一帧：纸色打底 */
  begin() {
    const gl = this.gl
    const p = this.programs.paper
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    gl.viewport(0, 0, this.canvas.width, this.canvas.height)
    gl.useProgram(p.handle)
    gl.uniform3f(p.uniform('uPaper'), PAPER_COLOR[0], PAPER_COLOR[1], PAPER_COLOR[2])
    gl.uniform2f(p.uniform('uSize'), DESIGN.width, DESIGN.height)
    gl.disable(gl.BLEND)
    gl.bindVertexArray(this.vao)
    gl.drawArrays(gl.TRIANGLES, 0, 3)
  }

  /** 把一层贴进画面：matrix 把单位方块（u 向右、v 向下）映到设计像素 */
  place(handle: WebGLTexture, matrix: Affine, options: PlaceOptions = {}) {
    const gl = this.gl
    const p = this.programs.place
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    gl.viewport(0, 0, this.canvas.width, this.canvas.height)
    gl.useProgram(p.handle)
    // 设计像素 → 裁剪空间
    const m = multiply([2 / DESIGN.width, 0, 0, -2 / DESIGN.height, -1, 1], matrix)
    gl.uniformMatrix3fv(p.uniform('uMatrix'), false, [m[0], m[1], 0, m[2], m[3], 0, m[4], m[5], 1])
    bind(gl, 0, handle); gl.uniform1i(p.uniform('uTex'), 0)
    gl.uniform1f(p.uniform('uFlip'), options.flip ? 1 : 0)
    gl.uniform1f(p.uniform('uAlpha'), options.alpha ?? 1)
    const f = options.feather ?? [0, 0, 0, 0]
    gl.uniform4f(p.uniform('uFeather'), f[0], f[1], f[2], f[3])
    gl.uniform1f(p.uniform('uRagged'), options.ragged ?? 0)
    const mul = options.multiply
    gl.uniform4f(p.uniform('uMul'), mul?.[0] ?? 1, mul?.[1] ?? 1, mul?.[2] ?? 1, mul ? 1 : 0)
    gl.enable(gl.BLEND)
    gl.blendEquation(gl.FUNC_ADD)
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
    gl.bindVertexArray(this.vao)
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
    gl.disable(gl.BLEND)
  }

  /** 读出当前帧（RGBA，自下而上的行序；ffmpeg 那边 vflip） */
  read(): Uint8Array {
    const gl = this.gl
    const size = this.canvas.width * this.canvas.height * 4
    if (!this.pixels || this.pixels.length !== size) this.pixels = new Uint8Array(size)
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    gl.readPixels(0, 0, this.canvas.width, this.canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, this.pixels)
    return this.pixels
  }

  private pass(p: Program, out: Target, inputs: readonly [string, WebGLTexture][], setup?: (p: Program) => void) {
    const gl = this.gl
    gl.bindFramebuffer(gl.FRAMEBUFFER, out.framebuffer)
    gl.viewport(0, 0, out.width, out.height)
    gl.useProgram(p.handle)
    inputs.forEach(([name, tex], unit) => { bind(gl, unit, tex); gl.uniform1i(p.uniform(name), unit) })
    setup?.(p)
    gl.disable(gl.BLEND)
    gl.bindVertexArray(this.vao)
    gl.drawArrays(gl.TRIANGLES, 0, 3)
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
  }
}

/**
 * 一块揭开遮罩上的几条“画笔”：每条是应用里的 Painter（一笔一笔排队画），几条可以同时画，
 * 颜色从几处一起铺开。step 传帧时刻（毫秒），返回笔尖位置和湿边干的程度。
 */
export class Brushes {
  readonly painters: Painter[] = []
  constructor(private readonly engine: Engine, readonly reveal: Target, private readonly maskFor: (job: Job) => WebGLTexture | null,
    private readonly blend: (job: Job) => 'max' | 'add' | 'sub' = (job) => job.blend) {}

  lane(index: number): Painter {
    while (this.painters.length <= index) this.painters.push(new Painter())
    return this.painters[index]
  }

  step(now: number) {
    let cursor: { kind: 'pencil' | 'quill'; x: number; y: number; down: boolean } | null = null
    let dry = 1
    let busy = false
    for (const painter of this.painters) {
      const out = painter.step(now)
      for (const { job, data } of out.stamps) this.engine.stamp(this.reveal, data, job.channel, this.blend(job), job.style.ragged, this.maskFor(job))
      for (const { job, level } of out.fills) this.engine.fill(this.reveal, job.channel, level, this.maskFor(job), this.blend(job) === 'sub' ? 'sub' : 'max')
      cursor ??= out.cursor
      dry = Math.min(dry, out.dry)
      busy ||= out.busy
    }
    return { cursor, dry, busy }
  }
}

// —— 仿射变换 ——
export function multiply(a: Affine, b: Affine): Affine {
  return [
    a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5],
  ]
}
export const translate = (x: number, y: number): Affine => [1, 0, 0, 1, x, y]
export const scale = (x: number, y = x): Affine => [x, 0, 0, y, 0, 0]
export const rotate = (radians: number): Affine => [Math.cos(radians), Math.sin(radians), -Math.sin(radians), Math.cos(radians), 0, 0]
export const chain = (...list: Affine[]): Affine => list.reduce((acc, m) => multiply(acc, m), [1, 0, 0, 1, 0, 0] as Affine)
/** 一个矩形：单位方块 → (x, y, w, h) */
export const rect = (x: number, y: number, w: number, h: number): Affine => [w, 0, 0, h, x, y]

/** 镜头：世界坐标里看向 (x, y)，放大 zoom 倍，画面中心对准它 */
export interface Camera { x: number; y: number; zoom: number; roll?: number }
export function view(camera: Camera): Affine {
  return chain(translate(DESIGN.width / 2, DESIGN.height / 2), rotate(camera.roll ?? 0), scale(camera.zoom), translate(-camera.x, -camera.y))
}

interface Program { handle: WebGLProgram; uniform(name: string): WebGLUniformLocation | null }

function program(gl: WebGL2RenderingContext, vertex: string, fragment: string): Program {
  const handle = gl.createProgram()!
  for (const [type, source] of [[gl.VERTEX_SHADER, vertex], [gl.FRAGMENT_SHADER, fragment]] as const) {
    const shader = gl.createShader(type)!
    gl.shaderSource(shader, source)
    gl.compileShader(shader)
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(`shader: ${gl.getShaderInfoLog(shader) ?? ''}`)
    gl.attachShader(handle, shader)
    gl.deleteShader(shader)
  }
  gl.linkProgram(handle)
  if (!gl.getProgramParameter(handle, gl.LINK_STATUS)) throw new Error(`program: ${gl.getProgramInfoLog(handle) ?? ''}`)
  const locations = new Map<string, WebGLUniformLocation | null>()
  return {
    handle,
    uniform(name) {
      if (!locations.has(name)) locations.set(name, gl.getUniformLocation(handle, name))
      return locations.get(name)!
    },
  }
}

function texture(gl: WebGL2RenderingContext, mipmapped: boolean): WebGLTexture {
  const handle = gl.createTexture()!
  gl.bindTexture(gl.TEXTURE_2D, handle)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, mipmapped ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
  return handle
}

function bind(gl: WebGL2RenderingContext, unit: number, handle: WebGLTexture) {
  gl.activeTexture(gl.TEXTURE0 + unit)
  gl.bindTexture(gl.TEXTURE_2D, handle)
}
