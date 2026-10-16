import { describe, expect, it } from 'vitest'
import { createManualClock } from '../../src/main/clock'

describe('unified clock', () => {
  it('fires in deadline order, supports cancellation and nested scheduling', () => {
    const clock = createManualClock(1000)
    const fired: number[] = []
    const cancel = clock.after(3, () => fired.push(-1))
    clock.after(5, () => { fired.push(clock.nowMs()); clock.after(2, () => fired.push(clock.nowMs())) })
    cancel()
    clock.advanceBy(6)
    expect(fired).toEqual([1005])
    clock.advanceBy(1)
    expect(fired).toEqual([1005, 1007])
    expect(() => clock.advanceBy(-1)).toThrow()
  })
})
