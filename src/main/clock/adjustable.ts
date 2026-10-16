import type { Clock } from './index'

/** Development only: every timer remains in virtual time when its rate/anchor changes. */
export function createAdjustableClock(real: Clock, initial?: { nowMs: number; rate: number; frozen: boolean }) {
  let anchorReal = real.nowMs(); let anchorVirtual = initial?.nowMs ?? anchorReal
  let rate = initial?.rate ?? 1; let frozen = initial?.frozen ?? false
  let sequence = 0; let disposed = false
  const timers = new Map<number, { at: number; callback: () => void }>()
  let cancel: (() => void) | undefined
  const nowMs = () => Math.trunc(Math.min(8_640_000_000_000_000, anchorVirtual + (frozen ? 0 : (real.nowMs() - anchorReal) * rate)))
  const arm = () => {
    cancel?.(); cancel = undefined
    if (disposed || !timers.size) return
    const next = Math.min(...[...timers.values()].map((timer) => timer.at))
    const delay = next - nowMs()
    if (frozen && delay > 0) return
    cancel = real.after(Math.min(2_147_000_000, Math.max(0, frozen ? 0 : delay / rate)), () => {
      cancel = undefined
      const due = [...timers.entries()].filter(([, timer]) => timer.at <= nowMs()).sort((a, b) => a[1].at - b[1].at || a[0] - b[0])
      for (const [id, timer] of due.slice(0, 10_000)) if (timers.delete(id)) timer.callback()
      arm()
    })
  }
  const clock: Clock = { nowMs, iso: real.iso, parse: real.parse,
    after: (delayMs, callback) => {
      if (disposed || !Number.isFinite(delayMs)) throw new Error('CLOCK_UNAVAILABLE')
      const id = ++sequence; timers.set(id, { at: nowMs() + Math.max(0, delayMs), callback }); arm()
      return () => { timers.delete(id); arm() }
    } }
  return { clock, view: () => ({ rate, frozen }),
    set: (value: { nowMs?: number; rate?: number; frozen?: boolean }) => {
      if (value.nowMs !== undefined && (!Number.isFinite(value.nowMs) || value.nowMs < 0 || value.nowMs > 8_640_000_000_000_000)) throw new Error('CLOCK_INVALID')
      if (value.rate !== undefined && (!Number.isFinite(value.rate) || value.rate < 0.01 || value.rate > 3600)) throw new Error('CLOCK_INVALID')
      anchorVirtual = value.nowMs ?? nowMs(); anchorReal = real.nowMs(); rate = value.rate ?? rate; frozen = value.frozen ?? frozen; arm()
    },
    dispose: () => { disposed = true; cancel?.(); timers.clear() },
  }
}
