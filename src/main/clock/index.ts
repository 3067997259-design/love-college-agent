export interface Clock {
  nowMs(): number
  iso(timestampMs: number): string
  after(delayMs: number, callback: () => void): () => void
}

export const systemClock: Clock = {
  nowMs: () => Date.now(),
  iso: (timestampMs) => new Date(timestampMs).toISOString(),
  after: (delayMs, callback) => {
    const timer = setTimeout(callback, Math.max(0, delayMs))
    return () => clearTimeout(timer)
  },
}

/** Deterministic fake time for tests. Never selected automatically for real execution. */
export function createManualClock(initialMs = 0): Clock & { advanceBy(ms: number): void } {
  let now = initialMs
  let nextId = 0
  const timers = new Map<number, { at: number; callback: () => void }>()
  return {
    nowMs: () => now,
    iso: (timestampMs) => new Date(timestampMs).toISOString(),
    after: (delayMs, callback) => {
      const id = ++nextId
      timers.set(id, { at: now + Math.max(0, delayMs), callback })
      return () => { timers.delete(id) }
    },
    advanceBy: (ms) => {
      if (!Number.isFinite(ms) || ms < 0) throw new Error('Clock must advance by a finite nonnegative amount.')
      const target = now + ms
      let callbacks = 0
      while (true) {
        const next = [...timers.entries()].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0]
        if (!next) break
        if (++callbacks > 10_000) throw new Error('Clock callback limit exceeded.')
        now = next[1].at
        timers.delete(next[0])
        next[1].callback()
      }
      now = target
    },
  }
}
