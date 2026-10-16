import type { Clock } from '../clock'

interface Job { id: string; atMs: number; everyMs?: number; background: boolean; callback: () => void }

/** A keyed deterministic queue with a single wake-up; missed intervals never cause catch-up storms. */
export function createScheduler(clock: Clock, failed: () => void = () => {}) {
  const jobs = new Map<string, Job>()
  let cancel: (() => void) | undefined; let disposed = false; let paused = false
  const stopWake = () => { cancel?.(); cancel = undefined }
  const arm = () => {
    stopWake()
    if (disposed) return
    const eligible = [...jobs.values()].filter((job) => !paused || !job.background)
    if (!eligible.length) return
    const next = Math.min(...eligible.map((job) => job.atMs))
    cancel = clock.after(Math.min(2_147_000_000, Math.max(0, next - clock.nowMs())), wake)
  }
  const wake = () => {
    stopWake()
    const due = [...jobs.values()].filter((job) => job.atMs <= clock.nowMs() && (!paused || !job.background)).sort((a, b) => a.atMs - b.atMs || a.id.localeCompare(b.id))
    for (const job of due.slice(0, 1000)) {
      if (jobs.get(job.id) !== job) continue
      jobs.delete(job.id)
      if (job.everyMs) jobs.set(job.id, { ...job, atMs: clock.nowMs() + job.everyMs })
      try { job.callback() } catch { disposed = true; jobs.clear(); stopWake(); failed(); return }
    }
    arm()
  }
  return {
    schedule: (id: string, atMs: number, callback: () => void, options?: { everyMs?: number; background?: boolean }) => {
      if (disposed || !Number.isFinite(atMs) || (options?.everyMs !== undefined && (!Number.isFinite(options.everyMs) || options.everyMs < 1))) throw new Error('SCHEDULER_INVALID')
      const job: Job = { id, atMs, callback, background: options?.background ?? true, everyMs: options?.everyMs }
      jobs.set(id, job); arm()
      return () => { if (jobs.get(id) === job) { jobs.delete(id); arm() } }
    },
    cancel: (id: string) => { jobs.delete(id); arm() },
    queue: () => [...jobs.values()].map(({ id, atMs, everyMs, background }) => ({ id, atMs, everyMs, paused: paused && background })).sort((a, b) => a.atMs - b.atMs || a.id.localeCompare(b.id)),
    pauseBackground: (value: boolean) => { paused = value; arm() },
    reconcile: () => { wake() },
    dispose: () => { disposed = true; cancel?.(); jobs.clear() },
  }
}
export type Scheduler = ReturnType<typeof createScheduler>
