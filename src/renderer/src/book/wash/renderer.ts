import type { Channel } from './painter'
import { regionOf, STAMP_FLOATS, type Region } from './strokes'
import { COMPOSITE, DIFF, EXTRACT, OPEN, STAMP_FRAGMENT, STAMP_VERTEX, VERTEX } from './shaders'

/** 一张整景图在 GPU 上的两层：原彩色和提取出的铅笔层 */
export interface Layer { src: string; color: WebGLTexture; pencil: WebGLTexture }
/** 她的剪影（有她的图减空房间图）和它的大致范围；她不在时 region 为 null */
export interface HerMask { texture: WebGLTexture; region: Region | null }

export interface Frame {
  current: Layer
  previous?: Layer
  previousAlpha: number
  /** 上色中：颜色只在笔触扫过的地方；keepOutside 为她的剪影时，剪影以外保持着色 */
  paint?: { dry: number; keepOutside?: WebGLTexture }
  /** 新手流程：铅笔层也按揭开遮罩显示，先是空房间的线 */
  intro?: { empty: Layer }
}

// 铅笔线的颜色跟着设计 token 的 --graphite／--pencil 之间取（tokens.css）
const GRAPHITE: readonly [number, number, number] = [0x6b / 255, 0x6e / 255, 0x74 / 255]
const WET = 0.55
// 颜色聚拢的椭圆：中心和半径，和原来的 CSS 遮罩同一处（她周围）
const VIGNETTE = { center: [0.52, 0.56] as const, radius: [0.52, 0.54] as const }
const MAX_LAYERS = 4
const MASK_SIZE = 512
const CHANNELS: Record<Channel, readonly [number, number, number, number]> = {
  room: [1, 0, 0, 0], her: [0, 1, 0, 0], paint: [0, 0, 1, 0], real: [0, 0, 0, 1], 'paint+real': [0, 0, 1, 1],
}

/**
 * 左页房间的 WebGL2 绘制。没有 WebGL2 时 create 返回 null，调用方退回 CSS 版。
 * 揭开遮罩（RGBA 各管一件事）、她的剪影、家具遮罩都是 512² 的纹理；整景图最多留四张，按最近使用淘汰。
 */
export class WashRenderer {
  private readonly layers = new Map<string, Promise<Layer>>()
  private readonly ready = new Map<string, Layer>()
  private readonly herMasks = new Map<string, HerMask>()
  private readonly polygonMasks = new Map<string, WebGLTexture>()
  private readonly extract: Program
  private readonly diff: Program
  private readonly open: Program
  private readonly composite: Program
  private readonly stampProgram: Program
  private readonly framebuffer: WebGLFramebuffer
  private readonly vao: WebGLVertexArrayObject
  private readonly stampVao: WebGLVertexArrayObject
  private readonly stampBuffer: WebGLBuffer
  private readonly reveal: WebGLTexture
  private readonly scratch: WebGLTexture
  private disposed = false

  static create(canvas: HTMLCanvasElement): WashRenderer | null {
    const gl = canvas.getContext('webgl2', { alpha: true, premultipliedAlpha: true, antialias: false, preserveDrawingBuffer: false })
    if (!gl) return null
    try { return new WashRenderer(gl) } catch (error) {
      // 退回 CSS 版不影响使用，但要留下原因（着色器编译失败、驱动限制等）
      console.warn('左页改用 CSS 绘制：', error instanceof Error ? error.message : error)
      return null
    }
  }

  private constructor(private readonly gl: WebGL2RenderingContext) {
    this.extract = program(gl, VERTEX, EXTRACT)
    this.diff = program(gl, VERTEX, DIFF)
    this.open = program(gl, VERTEX, OPEN)
    this.composite = program(gl, VERTEX, COMPOSITE)
    this.stampProgram = program(gl, STAMP_VERTEX, STAMP_FRAGMENT)
    this.framebuffer = gl.createFramebuffer()!
    this.vao = gl.createVertexArray()!
    this.reveal = target(gl, MASK_SIZE, false)
    this.scratch = target(gl, MASK_SIZE, true)
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
    this.resetReveal(1, 1, 1, 1)
  }

  get lost() { return this.gl.isContextLost() }

  /** 载入整景图并提取铅笔层；同一张图只做一次 */
  layer(src: string): Promise<Layer> {
    const cached = this.layers.get(src)
    if (cached) { this.touch(src); return cached }
    const loading = this.load(src)
    this.layers.set(src, loading)
    loading.then((layer) => { this.ready.set(src, layer); this.evict() }, () => { this.layers.delete(src) })
    return loading
  }

  private async load(src: string): Promise<Layer> {
    const image = new Image()
    image.decoding = 'async'
    image.src = src
    await image.decode()
    // 等图解码期间组件可能已经卸载（开发模式下 StrictMode 会挂两次）：不再碰已经删掉的 GL 对象
    if (this.disposed || this.gl.isContextLost()) throw new Error('renderer disposed')
    const gl = this.gl
    const color = texture(gl, true)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image)
    gl.generateMipmap(gl.TEXTURE_2D)
    const width = image.naturalWidth
    const height = image.naturalHeight
    const pencil = texture(gl, true)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null)
    this.pass(this.extract, pencil, width, height, [['uImage', color]], (p) => gl.uniform2f(p.uniform('uTexel'), 1 / width, 1 / height))
    gl.bindTexture(gl.TEXTURE_2D, pencil)
    gl.generateMipmap(gl.TEXTURE_2D)
    return { src, color, pencil }
  }

  /** 她的剪影：有她的图减空房间图；同一姿势只算一次 */
  herMask(pose: Layer, empty: Layer): HerMask {
    const cached = this.herMasks.get(pose.src)
    if (cached) return cached
    const gl = this.gl
    this.pass(this.diff, this.scratch, MASK_SIZE, MASK_SIZE, [['uPose', pose.color], ['uEmpty', empty.color]])
    gl.bindTexture(gl.TEXTURE_2D, this.scratch)
    gl.generateMipmap(gl.TEXTURE_2D)
    const mask = target(gl, MASK_SIZE, false)
    this.pass(this.open, mask, MASK_SIZE, MASK_SIZE, [['uRaw', this.scratch]])
    // 读回来算范围：笔触顺着她身体的长轴走
    const pixels = new Uint8Array(MASK_SIZE * MASK_SIZE * 4)
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffer)
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, mask, 0)
    gl.readPixels(0, 0, MASK_SIZE, MASK_SIZE, gl.RGBA, gl.UNSIGNED_BYTE, pixels)
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    const points: [number, number][] = []
    for (let y = 0; y < MASK_SIZE; y += 4) {
      for (let x = 0; x < MASK_SIZE; x += 4) if (pixels[(y * MASK_SIZE + x) * 4] > 128) points.push([(x + 0.5) / MASK_SIZE, (y + 0.5) / MASK_SIZE])
    }
    const result: HerMask = { texture: mask, region: points.length > 40 ? regionOf(points) : null }
    this.herMasks.set(pose.src, result)
    return result
  }

  /** 一件家具的遮罩：多边形按 512² 填出来；同一件只画一次 */
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
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, canvas)
    this.polygonMasks.set(id, mask)
    return mask
  }

  /** 揭开遮罩整体设成某个值 */
  resetReveal(room: number, her: number, paint: number, real: number) {
    const gl = this.gl
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffer)
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.reveal, 0)
    gl.viewport(0, 0, MASK_SIZE, MASK_SIZE)
    gl.clearColor(room, her, paint, real)
    gl.clear(gl.COLOR_BUFFER_BIT)
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
  }

  /** 沿路径印笔刷：data 每 6 个数一个印章；铅笔取最大值，颜料相加；mask 把颜料限在一块里 */
  stamp(data: readonly number[], channel: Channel, blend: 'max' | 'add', ragged: number, mask: WebGLTexture | null) {
    if (data.length === 0) return
    const gl = this.gl
    const p = this.stampProgram
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffer)
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.reveal, 0)
    gl.viewport(0, 0, MASK_SIZE, MASK_SIZE)
    gl.useProgram(p.handle)
    const c = CHANNELS[channel]
    gl.uniform4f(p.uniform('uChannel'), c[0], c[1], c[2], c[3])
    gl.uniform1f(p.uniform('uRagged'), ragged)
    gl.uniform1f(p.uniform('uUseMask'), mask ? 1 : 0)
    // 没有遮罩时绑一张别的纹理占位：不能把正在写的揭开遮罩同时当输入
    bind(gl, 0, mask ?? this.scratch); gl.uniform1i(p.uniform('uMask'), 0)
    gl.bindVertexArray(this.stampVao)
    gl.bindBuffer(gl.ARRAY_BUFFER, this.stampBuffer)
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(data), gl.STREAM_DRAW)
    gl.enable(gl.BLEND)
    if (blend === 'max') gl.blendEquation(gl.MAX)
    else { gl.blendEquation(gl.FUNC_ADD); gl.blendFunc(gl.ONE, gl.ONE) }
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, data.length / STAMP_FLOATS)
    gl.disable(gl.BLEND)
    gl.blendEquation(gl.FUNC_ADD)
    gl.bindVertexArray(null)
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
  }

  /** 补满：在遮罩里把通道抬到 level（取最大值，可以分几帧逐步抬） */
  fill(channel: Channel, level: number, mask: WebGLTexture | null) {
    this.stamp([0.5, 0.5, 1.5, level, 0, 1], channel, 'max', 0, mask)
  }

  resize(width: number, height: number) {
    const canvas = this.gl.canvas as HTMLCanvasElement
    if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height }
  }

  draw(frame: Frame) {
    const gl = this.gl
    const p = this.composite
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight)
    gl.clearColor(0, 0, 0, 0)
    gl.clear(gl.COLOR_BUFFER_BIT)
    gl.useProgram(p.handle)
    bind(gl, 0, frame.current.color); gl.uniform1i(p.uniform('uColor'), 0)
    bind(gl, 1, frame.current.pencil); gl.uniform1i(p.uniform('uPencil'), 1)
    bind(gl, 2, (frame.previous ?? frame.current).color); gl.uniform1i(p.uniform('uPrev'), 2)
    bind(gl, 3, this.reveal); gl.uniform1i(p.uniform('uReveal'), 3)
    bind(gl, 4, (frame.intro?.empty ?? frame.current).pencil); gl.uniform1i(p.uniform('uEmptyPencil'), 4)
    bind(gl, 5, frame.paint?.keepOutside ?? this.scratch); gl.uniform1i(p.uniform('uHerMask'), 5)
    gl.uniform1f(p.uniform('uHasPrev'), frame.previous ? 1 : 0)
    gl.uniform1f(p.uniform('uPrevAlpha'), frame.previousAlpha)
    gl.uniform1f(p.uniform('uPaint'), frame.paint || frame.intro ? 1 : 0)
    gl.uniform1f(p.uniform('uIntro'), frame.intro ? 1 : 0)
    gl.uniform1f(p.uniform('uKeepOutside'), frame.paint?.keepOutside ? 1 : 0)
    gl.uniform1f(p.uniform('uDry'), frame.paint?.dry ?? 1)
    gl.uniform1f(p.uniform('uWet'), WET)
    gl.uniform2f(p.uniform('uRevealTexel'), 1.5 / MASK_SIZE, 1.5 / MASK_SIZE)
    gl.uniform2f(p.uniform('uVigCenter'), VIGNETTE.center[0], VIGNETTE.center[1])
    gl.uniform2f(p.uniform('uVigRadius'), VIGNETTE.radius[0], VIGNETTE.radius[1])
    gl.uniform3f(p.uniform('uGraphite'), GRAPHITE[0], GRAPHITE[1], GRAPHITE[2])
    gl.uniform1f(p.uniform('uPencilOpacity'), 0.8)
    gl.bindVertexArray(this.vao)
    gl.drawArrays(gl.TRIANGLES, 0, 3)
  }

  dispose() {
    this.disposed = true
    const gl = this.gl
    for (const layer of this.ready.values()) { gl.deleteTexture(layer.color); gl.deleteTexture(layer.pencil) }
    for (const mask of this.herMasks.values()) gl.deleteTexture(mask.texture)
    for (const mask of this.polygonMasks.values()) gl.deleteTexture(mask)
    this.ready.clear()
    this.layers.clear()
    this.herMasks.clear()
    this.polygonMasks.clear()
    gl.deleteTexture(this.reveal)
    gl.deleteTexture(this.scratch)
    gl.deleteFramebuffer(this.framebuffer)
    gl.deleteVertexArray(this.vao)
    gl.deleteVertexArray(this.stampVao)
    gl.deleteBuffer(this.stampBuffer)
    for (const p of [this.extract, this.diff, this.open, this.composite, this.stampProgram]) gl.deleteProgram(p.handle)
  }

  /** 正在用的几张不能被淘汰 */
  keep(...layers: (Layer | undefined)[]) {
    for (const layer of layers) if (layer) this.touch(layer.src)
  }

  /** 全屏画一遍到某张纹理上（铅笔提取、剪影） */
  private pass(p: Program, out: WebGLTexture, width: number, height: number, inputs: readonly [string, WebGLTexture][], setup?: (p: Program) => void) {
    const gl = this.gl
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffer)
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, out, 0)
    gl.viewport(0, 0, width, height)
    gl.useProgram(p.handle)
    inputs.forEach(([name, tex], unit) => { bind(gl, unit, tex); gl.uniform1i(p.uniform(name), unit) })
    setup?.(p)
    gl.disable(gl.BLEND)
    gl.bindVertexArray(this.vao)
    gl.drawArrays(gl.TRIANGLES, 0, 3)
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
  }

  private touch(src: string) {
    const layer = this.ready.get(src)
    if (!layer) return
    this.ready.delete(src)
    this.ready.set(src, layer)
  }

  private evict() {
    while (this.ready.size > MAX_LAYERS) {
      const [src, layer] = this.ready.entries().next().value as [string, Layer]
      this.ready.delete(src)
      this.layers.delete(src)
      const mask = this.herMasks.get(src)
      if (mask) { this.gl.deleteTexture(mask.texture); this.herMasks.delete(src) }
      this.gl.deleteTexture(layer.color)
      this.gl.deleteTexture(layer.pencil)
    }
  }
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

/** 可以画进去的 512² 纹理 */
function target(gl: WebGL2RenderingContext, size: number, mipmapped: boolean): WebGLTexture {
  const handle = texture(gl, mipmapped)
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, size, size, 0, gl.RGBA, gl.UNSIGNED_BYTE, null)
  if (mipmapped) gl.generateMipmap(gl.TEXTURE_2D)
  return handle
}

function bind(gl: WebGL2RenderingContext, unit: number, handle: WebGLTexture) {
  gl.activeTexture(gl.TEXTURE0 + unit)
  gl.bindTexture(gl.TEXTURE_2D, handle)
}
