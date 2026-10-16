import { describe, expect, it } from 'vitest'
import { clampMiniBounds } from '../../src/main/windows/bounds'
import { createAppController } from '../../src/main/bridge/controller'
import { createManualClock } from '../../src/main/clock'
import { hasBlackMiniCorners, roundedMiniShape } from '../../src/main/windows/presentation'

describe('mini window bounds and authoritative companion state', () => {
  it('detects opaque black corners without treating transparent black pixels or dark interior artwork as failure', () => {
    const pixels = new Uint8Array(32 * 40 * 4)
    expect(hasBlackMiniCorners(pixels, 32, 40)).toBe(false)
    const middle = (20 * 32 + 16) * 4; pixels[middle + 3] = 255
    expect(hasBlackMiniCorners(pixels, 32, 40)).toBe(false)
    for (const [x, y] of [[1, 1], [30, 1], [1, 38], [30, 38]]) pixels[(y * 32 + x) * 4 + 3] = 255
    expect(hasBlackMiniCorners(pixels, 32, 40)).toBe(true)
    pixels[(32 + 1) * 4] = 255; expect(hasBlackMiniCorners(pixels, 32, 40)).toBe(false)
    expect(hasBlackMiniCorners(new Uint8Array(), 32, 40)).toBe(false)
  })
  it('uses a native opaque region with cut corners and a full-width center', () => {
    const shape = roundedMiniShape(320, 400)
    expect(shape.every((rect) => rect.x >= 0 && rect.y >= 0 && rect.width > 0 && rect.height > 0 && rect.x + rect.width <= 320 && rect.y + rect.height <= 400)).toBe(true)
    expect(shape.some((rect) => rect.y === 0 && rect.x > 0 && rect.width < 320)).toBe(true)
    expect(shape.some((rect) => rect.x === 0 && rect.width === 320 && rect.height > 1)).toBe(true)
  })
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
