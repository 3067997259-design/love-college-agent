import { COMPOSITE, EXTRACT, VERTEX } from './shaders'

/** 一张整景图在 GPU 上的两层：原彩色和提取出的铅笔层 */
export interface Layer { src: string; color: WebGLTexture; pencil: WebGLTexture }

export interface Frame {
  current: Layer
  previous?: Layer
  previousAlpha: number
  wash?: { origin: readonly [number, number]; radius: number; noiseAmp: number; dry: number; seed: number }
}

// 铅笔线的颜色跟着设计 token 的 --graphite／--pencil 之间取（tokens.css）
const GRAPHITE: readonly [number, number, number] = [0x6b / 255, 0x6e / 255, 0x74 / 255]
const WET = 0.55
// 颜色聚拢的椭圆：中心和半径，和原来的 CSS 遮罩同一处（她周围）
const VIGNETTE = { center: [0.52, 0.56] as const, radius: [0.52, 0.54] as const }
const MAX_LAYERS = 3

/**
 * 左页房间的 WebGL2 绘制。没有 WebGL2 时 create 返回 null，调用方退回 CSS 版。
 * 只在过渡期间每帧画，平时画一次就停。纹理最多留三张图，按最近使用淘汰。
 */
export class WashRenderer {
  private readonly layers = new Map<string, Promise<Layer>>()
  private readonly ready = new Map<string, Layer>()
  private readonly extract: Program
  private readonly composite: Program
  private readonly framebuffer: WebGLFramebuffer
  private readonly vao: WebGLVertexArrayObject
  private disposed = false

  static create(canvas: HTMLCanvasElement): WashRenderer | null {
    const gl = canvas.getContext('webgl2', { alpha: true, premultipliedAlpha: true, antialias: false, preserveDrawingBuffer: false })
    if (!gl) return null
    try { return new WashRenderer(gl) } catch { return null }
  }

  private constructor(private readonly gl: WebGL2RenderingContext) {
    this.extract = program(gl, VERTEX, EXTRACT)
    this.composite = program(gl, VERTEX, COMPOSITE)
    this.framebuffer = gl.createFramebuffer()!
    this.vao = gl.createVertexArray()!
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
    const color = texture(gl)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image)
    gl.generateMipmap(gl.TEXTURE_2D)

    const width = image.naturalWidth
    const height = image.naturalHeight
    const pencil = texture(gl)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null)
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffer)
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, pencil, 0)
    gl.viewport(0, 0, width, height)
    gl.useProgram(this.extract.handle)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, color)
    gl.uniform1i(this.extract.uniform('uImage'), 0)
    gl.uniform2f(this.extract.uniform('uTexel'), 1 / width, 1 / height)
    gl.bindVertexArray(this.vao)
    gl.disable(gl.BLEND)
    gl.drawArrays(gl.TRIANGLES, 0, 3)
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    gl.bindTexture(gl.TEXTURE_2D, pencil)
    gl.generateMipmap(gl.TEXTURE_2D)
    return { src, color, pencil }
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
    gl.uniform1f(p.uniform('uHasPrev'), frame.previous ? 1 : 0)
    gl.uniform1f(p.uniform('uPrevAlpha'), frame.previousAlpha)
    const wash = frame.wash
    gl.uniform1f(p.uniform('uWashOn'), wash ? 1 : 0)
    gl.uniform2f(p.uniform('uOrigin'), wash?.origin[0] ?? 0.5, wash?.origin[1] ?? 0.5)
    gl.uniform1f(p.uniform('uRadius'), wash?.radius ?? 10)
    gl.uniform1f(p.uniform('uNoiseAmp'), wash?.noiseAmp ?? 0)
    gl.uniform1f(p.uniform('uDry'), wash?.dry ?? 1)
    gl.uniform1f(p.uniform('uSeed'), wash?.seed ?? 0)
    gl.uniform1f(p.uniform('uWet'), WET)
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
    this.ready.clear()
    this.layers.clear()
    gl.deleteFramebuffer(this.framebuffer)
    gl.deleteVertexArray(this.vao)
    gl.deleteProgram(this.extract.handle)
    gl.deleteProgram(this.composite.handle)
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
      this.gl.deleteTexture(layer.color)
      this.gl.deleteTexture(layer.pencil)
    }
  }

  /** 正在用的两张不能被淘汰 */
  keep(...layers: (Layer | undefined)[]) {
    for (const layer of layers) if (layer) this.touch(layer.src)
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

function texture(gl: WebGL2RenderingContext): WebGLTexture {
  const handle = gl.createTexture()!
  gl.bindTexture(gl.TEXTURE_2D, handle)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
  return handle
}

function bind(gl: WebGL2RenderingContext, unit: number, handle: WebGLTexture) {
  gl.activeTexture(gl.TEXTURE0 + unit)
  gl.bindTexture(gl.TEXTURE_2D, handle)
}
