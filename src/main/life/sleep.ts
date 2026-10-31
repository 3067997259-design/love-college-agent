import type { PublicErrorCode } from '../../shared'
import type { Clock } from '../clock'
import { DEFAULT_DAYPART_SCHEDULE, deriveDaypart, type DaypartSchedule } from '../clock/daypart'
import type { Scheduler } from '../scheduler'
import type { SessionStore } from '../store/session'

/** A durable pose/state transition, not a claim that offline work happened. */
export function createSleep(options: { store: SessionStore; clock: Clock; scheduler: Scheduler; daypartSchedule?: DaypartSchedule; canSleep(): boolean; changed(): void }) {
  const { clock, scheduler, store } = options
  const schedule = options.daypartSchedule ?? DEFAULT_DAYPART_SCHEDULE
  let cancelWake: (() => void) | undefined
  let closed = false
  const set = (sleeping: boolean, cause: 'user' | 'day-end' | 'interaction' | 'day-start', request?: { requestId: string; commandHash: string }): PublicErrorCode | undefined => {
    if (closed) return 'unavailable'
    // Sealing an old page after a late start is bookkeeping, not a reason to sleep in daylight.
    if (sleeping && cause === 'day-end' && deriveDaypart(clock.nowMs(), schedule) !== 'night') return
    const unchanged = options.store.projection().sleeping === sleeping
    if (unchanged && !request) return
    if (sleeping && !unchanged && !options.canSleep()) return 'unavailable'
    options.store.append({ type: 'companion/sleep', sleeping, cause, ...request })
    reconcile()
    options.changed()
  }
  const reconcile = () => {
    cancelWake?.(); cancelWake = undefined
    if (closed || !store.projection().sleeping) return
    // Scoped history preserves the cause across existing daily carries and old saves; an unknown or
    // manual cause is never guessed to be automatic sleep.
    const origin = (store.history?.() ?? store.records()).findLast((row) => row.type === 'companion/sleep')
    if (origin?.type !== 'companion/sleep' || !origin.sleeping || origin.cause !== 'day-end') return
    const midnight = clock.parse(clock.iso(origin.atMs + 8 * 3600_000).slice(0, 10) + 'T00:00:00+08:00')
    const morning = midnight + schedule.morningStartHour * 3600_000
    const wakeAt = morning > origin.atMs ? morning : morning + 24 * 3600_000
    if (clock.nowMs() >= wakeAt) { set(false, 'day-start'); return }
    // The clock can update sleep while lights remain an independent, persistent pause switch.
    cancelWake = scheduler.schedule('sleep.wake', wakeAt, reconcile, { background: false })
  }
  reconcile()
  return { set, wake: () => set(false, 'interaction'), reconcile, close: () => { closed = true; cancelWake?.(); cancelWake = undefined } }
}
export type SleepService = ReturnType<typeof createSleep>
