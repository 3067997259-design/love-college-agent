import { describe, expect, it } from 'vitest'
import { HER_DRAW_MS, HER_RADIUS, introDuration, introFrame, penAt, ROOM_DRAW_MS, ROOM_RADIUS, scribble, stampsBetween } from '../../src/renderer/src/book/wash/intro'

const bounds = { x0: 0.1, y0: 0.1, x1: 0.9, y1: 0.9 }

describe('onboarding pencil path', () => {
  it('draws rows back and forth inside the bounds and spends the whole duration', () => {
    const stroke = scribble(bounds, 4, 6000, 0.05, 3)
    const times = stroke.points.map((p) => p.t)
    expect(times[0]).toBe(0)
    expect(times.at(-1)).toBeCloseTo(6000, 6)
    for (let i = 1; i < times.length; i++) expect(times[i]).toBeGreaterThanOrEqual(times[i - 1])
    for (const p of stroke.points) {
      expect(p.x).toBeGreaterThanOrEqual(0.1 - 1e-9)
      expect(p.x).toBeLessThanOrEqual(0.9 + 1e-9)
      expect(p.y).toBeGreaterThan(0.05)
      expect(p.y).toBeLessThan(0.95)
    }
    // 同一个 seed 结果相同
    expect(scribble(bounds, 4, 6000, 0.05, 3)).toEqual(stroke)
  })
  it('lifts the pen between rows and stops at the end', () => {
    const stroke = scribble(bounds, 3, 3000, 0.05, 1)
    const lifts = stroke.points.filter((p, i) => i > 0 && !p.down).length
    expect(lifts).toBe(2)
    expect(penAt(stroke, -5).down).toBe(false)
    expect(penAt(stroke, 3000).down).toBe(false)
    expect(penAt(stroke, 400).down).toBe(true)
  })
  it('stamps only pen-down segments at about 0.3 radius spacing', () => {
    const stroke = scribble({ x0: 0.1, y0: 0.5, x1: 0.9, y1: 0.5 }, 1, 1000, 0.05, 2)
    const stamps = stampsBetween(stroke, 0, 1000)
    expect(stamps.length % 4).toBe(0)
    const count = stamps.length / 4
    // 0.8 宽、间距 0.015：大约 53 个；起伏让路径略长
    expect(count).toBeGreaterThan(45)
    expect(count).toBeLessThan(80)
    expect(stampsBetween(stroke, 500, 500)).toEqual([])
    const halves = stampsBetween(stroke, 0, 500).length + stampsBetween(stroke, 500, 1000).length
    expect(Math.abs(halves - stamps.length)).toBeLessThanOrEqual(16)
  })
})

describe('onboarding left-page timeline', () => {
  it('starts on blank paper and draws the room before her', () => {
    expect(introFrame('paper', 5000)).toMatchObject({ roomT: 0, herT: 0, coverRadius: 0, realRadius: 0 })
    expect(introFrame('drawing', 1000)).toMatchObject({ roomT: 1000, herT: 0 })
    expect(introFrame('drawing', ROOM_DRAW_MS + 500)).toMatchObject({ roomT: ROOM_DRAW_MS, herT: 500 })
    expect(introDuration('drawing')).toBe(ROOM_DRAW_MS + HER_DRAW_MS)
  })
  it('colors her simply first, then for real, then the whole room', () => {
    const flat = introFrame('flat', 100_000)
    expect(flat).toMatchObject({ roomT: ROOM_DRAW_MS, herT: HER_DRAW_MS, realRadius: 0 })
    expect(flat.coverRadius).toBeCloseTo(HER_RADIUS, 6)
    const real = introFrame('real', 100_000)
    expect(real.coverRadius).toBe(HER_RADIUS)
    expect(real.realRadius).toBeCloseTo(HER_RADIUS, 6)
    const room = introFrame('room', 100_000)
    expect(room.coverRadius).toBeCloseTo(ROOM_RADIUS, 6)
    expect(room.realRadius).toBe(room.coverRadius)
    expect(introFrame('done', 0)).toMatchObject({ coverRadius: ROOM_RADIUS, realRadius: ROOM_RADIUS, dry: 1 })
  })
  it('treats skipped steps as already finished', () => {
    expect(introFrame('room', 0)).toMatchObject({ roomT: ROOM_DRAW_MS, herT: HER_DRAW_MS, coverRadius: HER_RADIUS, realRadius: HER_RADIUS })
  })
})
