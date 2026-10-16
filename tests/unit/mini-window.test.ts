import { describe, expect, it } from 'vitest'
import { clampMiniBounds, defaultMiniBounds, moveMiniByPixels, restoreMiniBounds } from '../../src/main/windows/bounds'
import { createAppController } from '../../src/main/bridge/controller'
import { createManualClock } from '../../src/main/clock'
import { hasBlackMiniCorners, roundedMiniShape } from '../../src/main/windows/presentation'

describe('mini window bounds and authoritative companion state', () => {
  it('defaults to a 280 by 350 DIP window with a 24 DIP margin, including negative and tiny displays', () => {
    expect(defaultMiniBounds({ x: 0, y: 0, width: 1920, height: 1040 })).toEqual({ x: 1616, y: 666, width: 280, height: 350 })
    expect(defaultMiniBounds({ x: -1920, y: -100, width: 1920, height: 1040 })).toEqual({ x: -304, y: 566, width: 280, height: 350 })
    expect(defaultMiniBounds({ x: 50, y: 50, width: 200, height: 200 })).toEqual({ x: 50, y: 50, width: 200, height: 200 })
  })
  it('restores valid positions but rehomes off-screen positions and removed displays', () => {
    const primary = { x: 0, y: 0, width: 1920, height: 1040 }; const left = { x: -1920, y: 0, width: 1920, height: 1040 }
    const displays = [{ id: 1, workArea: primary }, { id: 2, workArea: left }]
    expect(restoreMiniBounds({ x: -500, y: 100, displayId: 2 }, displays, primary)).toEqual({ x: -500, y: 100, width: 280, height: 350 })
    expect(restoreMiniBounds({ x: -500, y: 100 }, displays, primary)).toEqual({ x: -500, y: 100, width: 280, height: 350 })
    for (const saved of [{ x: -500, y: 100, displayId: 3 }, { x: 1800, y: 900, displayId: 1 }, { x: -99999, y: 99999 }]) expect(restoreMiniBounds(saved, displays, primary)).toEqual(defaultMiniBounds(primary))
  })
  it('converts physical pixels at high DPI and retains sub-DIP movement without drift', () => {
    const area = { x: -1000, y: 0, width: 2000, height: 1500 }
    let current = { x: -500, y: 100, width: 280, height: 350 }; let remainder = { x: 0, y: 0 }
    for (let i = 0; i < 150; i++) { const moved = moveMiniByPixels(current, 1, 1, area, 1.5, remainder); current = moved.bounds; remainder = moved.remainder }
    expect(current).toEqual({ x: -400, y: 200, width: 280, height: 350 }); expect(Math.abs(remainder.x)).toBeLessThan(1e-8)
    expect(moveMiniByPixels(current, -150, -75, area, 1.5).bounds).toEqual({ x: -500, y: 150, width: 280, height: 350 })
  })
  it('clamps movement within the current display and discards overshoot when reversing', () => {
    const area = { x: -1920, y: 0, width: 1920, height: 1040 }
    const moved = moveMiniByPixels({ x: -500, y: 100, width: 280, height: 350 }, 10000, 10000, area, 1.5)
    expect(moved.bounds).toEqual({ x: -280, y: 690, width: 280, height: 350 }); expect(moved.remainder).toEqual({ x: 0, y: 0 })
    expect(moveMiniByPixels(moved.bounds, -15, -15, area, 1.5, moved.remainder).bounds).toEqual({ x: -290, y: 680, width: 280, height: 350 })
  })
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
    expect(controller.dispatch({ ...base, type: 'window.mini.moveBy', dx: 1, dy: 1 })).toMatchObject({ status: 'rejected', error: { code: 'permission-denied' } })
    expect(controller.dispatch({ ...base, type: 'window.mini.moveBy', dx: 0.1, dy: 1 }, 'mini')).toMatchObject({ status: 'rejected', error: { code: 'invalid-command' } })
    controller.dispatch({ ...base, requestId: 'quiet', type: 'mode.set', mode: 'quiet' }); controller.dispatch({ ...base, requestId: 'dark', type: 'lights.set', lightsOut: true })
    expect(controller.getSnapshot().companion.pose).toBe('desk-writing'); expect(controller.getSnapshot().companion.lightsOut).toBe(true)
  })
  it('refuses diagnostics-surface mutations before command replay, keeping it read-only', () => {
    const controller = createAppController(createManualClock()); const base = { protocolVersion: 1, epoch: controller.getSnapshot().epoch, requestId: 'book-command' }
    const command = { ...base, type: 'mode.set', mode: 'quiet' }
    expect(controller.dispatch(command).status).toBe('accepted')
    expect(controller.dispatch(command, 'diagnostics')).toMatchObject({ status: 'rejected', error: { code: 'permission-denied' } })
    for (const body of [{ type: 'lights.set', lightsOut: true }, { type: 'window.mini.hover', over: true }, { type: 'window.mini.moveBy', dx: 1, dy: 1 }, { type: 'window.expand' }, { type: 'window.diagnostics.open' }]) expect(controller.dispatch({ ...base, requestId: 'diagnostics-command', ...body }, 'diagnostics')).toMatchObject({ status: 'rejected', error: { code: 'permission-denied' } })
    expect(controller.getSnapshot().companion.lightsOut).toBe(false)
  })
})
