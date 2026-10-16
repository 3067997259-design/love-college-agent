import { describe, expect, it, vi } from 'vitest'
import { createManualClock } from '../../src/main/clock'
import { createAdjustableClock } from '../../src/main/clock/adjustable'
import { createScheduler } from '../../src/main/scheduler'

describe('shared scheduler and adjustable development clock', () => {
  it('replaces named jobs, cancels, and pauses background while keeping UI ticks', () => {
    const clock = createManualClock(1000); const scheduler = createScheduler(clock); const called: string[] = []
    scheduler.schedule('phase', 2000, () => called.push('old'))
    scheduler.schedule('phase', 2000, () => called.push('phase'))
    scheduler.schedule('ui', 2000, () => called.push('ui'), { background: false })
    scheduler.pauseBackground(true); clock.advanceBy(1000)
    expect(called).toEqual(['ui']); expect(scheduler.queue()[0].paused).toBe(true)
    scheduler.pauseBackground(false); clock.advanceBy(0); expect(called).toEqual(['ui', 'phase'])
    scheduler.schedule('cancelled', 3000, () => called.push('bad')); scheduler.cancel('cancelled'); clock.advanceBy(1000)
    expect(called).toHaveLength(2); scheduler.dispose()
  })
  it('freezes and rearms timers on rate changes and forward seeks', () => {
    const real = createManualClock(1000); const adjustable = createAdjustableClock(real); const called = vi.fn()
    adjustable.clock.after(10_000, called)
    adjustable.set({ frozen: true }); real.advanceBy(5000); expect(adjustable.clock.nowMs()).toBe(1000)
    adjustable.set({ frozen: false, rate: 10 }); real.advanceBy(999); expect(called).not.toHaveBeenCalled()
    real.advanceBy(1); expect(called).toHaveBeenCalledTimes(1)
    adjustable.clock.after(10_000, called); adjustable.set({ nowMs: 50_000, frozen: true }); real.advanceBy(0)
    expect(called).toHaveBeenCalledTimes(2); adjustable.dispose()
  })
  it('keeps interval cancellation valid after the first tick without cancelling its replacement', () => {
    const clock = createManualClock(); const scheduler = createScheduler(clock); const callback = vi.fn()
    const cancel = scheduler.schedule('repeat', 1000, callback, { everyMs: 1000 })
    clock.advanceBy(1000); cancel(); clock.advanceBy(2000); expect(callback).toHaveBeenCalledTimes(1)
    const old = scheduler.schedule('repeat', 4000, callback, { everyMs: 1000 })
    scheduler.schedule('repeat', 4000, callback); old(); clock.advanceBy(1000)
    expect(callback).toHaveBeenCalledTimes(2); scheduler.dispose()
  })
})
