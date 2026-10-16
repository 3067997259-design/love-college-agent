import { describe, expect, it } from 'vitest'
import { clampMiniBounds } from '../../src/main/windows/bounds'
import { createAppController } from '../../src/main/bridge/controller'
import { createManualClock } from '../../src/main/clock'

describe('mini window bounds and authoritative companion state', () => {
  it('clamps to negative-coordinate displays and small work areas', () => {
    expect(clampMiniBounds({ x: -9999, y: 9999, width: 320, height: 400 }, { x: -1920, y: 0, width: 1920, height: 1040 })).toEqual({ x: -1920, y: 640, width: 320, height: 400 })
    expect(clampMiniBounds({ x: 1000, y: 1000, width: 320, height: 400 }, { x: 50, y: 50, width: 200, height: 200 })).toEqual({ x: 50, y: 50, width: 200, height: 200 })
  })
  it('rejects forged mini-only commands and does not turn lights-out into sleep', () => {
    const controller = createAppController(createManualClock()); const base = { protocolVersion: 1, epoch: controller.getSnapshot().epoch, requestId: 'hover' }
    expect(controller.dispatch({ ...base, type: 'window.mini.hover', over: true })).toMatchObject({ status: 'rejected', error: { code: 'permission-denied' } })
    controller.dispatch({ ...base, requestId: 'quiet', type: 'mode.set', mode: 'quiet' }); controller.dispatch({ ...base, requestId: 'dark', type: 'lights.set', lightsOut: true })
    expect(controller.getSnapshot().companion.pose).toBe('desk-writing'); expect(controller.getSnapshot().companion.lightsOut).toBe(true)
  })
})
