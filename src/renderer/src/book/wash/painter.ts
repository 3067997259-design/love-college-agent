import { penAt, stampsBetween, type StampStyle, type Stroke } from './strokes'

/**
 * 一笔一笔画的排队器：铅笔揭线稿、羽毛笔上色都是一个个“活”，按顺序画；后面还有活排着时，当前这件画快一倍。
 * 每一帧告诉调用方这段时间该印哪些笔刷、要不要补满、笔尖在哪，以及湿边干到什么程度。纯逻辑，不碰 WebGL。
 */

export type Channel = 'room' | 'her' | 'paint' | 'real' | 'paint+real'
export type MaskRef = { kind: 'none' } | { kind: 'her' } | { kind: 'polygon'; id: string; points: readonly (readonly [number, number])[] }

export interface Job {
  id: string
  stroke: Stroke
  style: StampStyle
  channel: Channel
  /** 铅笔取最大值（重复走过不会更“多”），颜料相加（叠色） */
  blend: 'max' | 'add'
  mask: MaskRef
  cursor: 'pencil' | 'quill' | null
  /** 笔画完以后，在遮罩里把这个通道补满用的时间；0 表示不补 */
  fillMs: number
}

export interface PainterFrame {
  stamps: { job: Job; data: number[] }[]
  fills: { job: Job; level: number }[]
  cursor: { kind: 'pencil' | 'quill'; x: number; y: number; down: boolean } | null
  busy: boolean
  dry: number
}

const DRY_MS = 900

export class Painter {
  private queue: Job[] = []
  private current?: { job: Job; t: number; stamped: number; filled: number }
  private lastNow: number | null = null
  /** 最近一件上色的活画完的时刻；从没上过色就是 null */
  private paintEndedAt: number | null = null

  /**
   * 空闲时排进来的活从现在开始计时：否则第一帧会把空闲的几秒都算进去，整件一下画完、看不到笔
   * （新手流程里过一会儿再点家具，颜色直接冒出来）。
   */
  enqueue(job: Job) { if (!this.busy) this.lastNow = null; this.queue.push(job) }
  /** 你自己涂了几笔：湿边从现在开始干 */
  wet(now: number) { this.paintEndedAt = now }
  clear() { this.queue = []; this.current = undefined; this.lastNow = null; this.paintEndedAt = null }
  get busy() { return !!this.current || this.queue.length > 0 }
  has(id: string) { return this.current?.job.id === id || this.queue.some((job) => job.id === id) }

  step(now: number): PainterFrame {
    const out: PainterFrame = { stamps: [], fills: [], cursor: null, busy: false, dry: 1 }
    const dt = this.lastNow === null ? 0 : Math.max(0, now - this.lastNow)
    this.lastNow = now
    let budget = dt
    for (let guard = 0; guard < 32; guard++) {
      if (!this.current) {
        const next = this.queue.shift()
        if (!next) break
        this.current = { job: next, t: 0, stamped: 0, filled: 0 }
      }
      const c = this.current
      const speed = this.queue.length > 0 ? 2 : 1
      c.t += budget * speed
      const { job } = c
      const length = job.stroke.durationMs
      const reach = Math.min(c.t, length)
      if (reach > c.stamped) {
        const data = stampsBetween(job.stroke, c.stamped, reach, job.style)
        if (data.length) out.stamps.push({ job, data })
        c.stamped = reach
      }
      if (c.t < length) {
        if (job.cursor) out.cursor = { kind: job.cursor, ...penAt(job.stroke, c.t) }
        break
      }
      if (job.fillMs > 0) {
        const level = Math.min(1, (c.t - length) / job.fillMs)
        if (level > c.filled) { out.fills.push({ job, level }); c.filled = level }
        if (level < 1) break
      }
      // 这件画完了：多出来的时间留给下一件
      budget = Math.max(0, (c.t - length - job.fillMs) / speed)
      if (isPaint(job)) this.paintEndedAt = now
      this.current = undefined
    }
    out.busy = this.busy
    // 上色的时候湿边是湿的；停笔后 0.9 s 干掉。铅笔不留湿边
    out.dry = this.current && isPaint(this.current.job) ? 0
      : this.paintEndedAt === null ? 1 : Math.min(1, Math.max(0, (now - this.paintEndedAt) / DRY_MS))
    return out
  }
}

const isPaint = (job: Job) => job.channel === 'paint' || job.channel === 'real' || job.channel === 'paint+real'
