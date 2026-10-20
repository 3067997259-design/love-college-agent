import { describe, expect, it } from 'vitest'
import { DEFAULT_FURNITURE } from '../../src/renderer/src/book/wash/furniture'
import { furnitureJob, introJobs, poseJob, restoreJob } from '../../src/renderer/src/book/wash/intro'
import { Painter, type Job } from '../../src/renderer/src/book/wash/painter'
import { brushStrokes, coverageOf, insidePolygon, penAt, regionOf, scribble, segment, stampsBetween, STAMP_FLOATS, strokeEase, tracedStroke } from '../../src/renderer/src/book/wash/strokes'

const pencil = { radius: 0.05, strength: 1, aspect: 1, ragged: 0 }

describe('strokes', () => {
  it('draws pencil rows back and forth over the whole duration, deterministically', () => {
    const stroke = scribble({ x0: 0.1, y0: 0.1, x1: 0.9, y1: 0.9 }, 4, 6000, 3)
    const times = stroke.points.map((p) => p.t)
    expect(times[0]).toBe(0)
    expect(times.at(-1)).toBeCloseTo(6000, 6)
    for (let i = 1; i < times.length; i++) expect(times[i]).toBeGreaterThanOrEqual(times[i - 1])
    expect(stroke.points.filter((p, i) => i > 0 && !p.down)).toHaveLength(3)
    expect(scribble({ x0: 0.1, y0: 0.1, x1: 0.9, y1: 0.9 }, 4, 6000, 3)).toEqual(stroke)
    expect(penAt(stroke, -1).down).toBe(false)
    expect(penAt(stroke, 6000).down).toBe(false)
    expect(penAt(stroke, 300).down).toBe(true)
  })
  it('stamps only pen-down segments, at about 0.3 radius, oriented along the segment', () => {
    const stroke = { durationMs: 1000, points: [{ x: 0.1, y: 0.5, t: 0, down: false }, { x: 0.9, y: 0.5, t: 1000, down: true }] }
    const stamps = stampsBetween(stroke, 0, 1000, pencil)
    expect(stamps.length % STAMP_FLOATS).toBe(0)
    expect(stamps.length / STAMP_FLOATS).toBe(Math.ceil(0.8 / 0.015))
    expect(stamps[4]).toBeCloseTo(0, 6) // 方向：水平
    expect(stampsBetween(stroke, 500, 500, pencil)).toEqual([])
    const pressed = stampsBetween({ ...stroke, points: stroke.points.map((p) => ({ ...p, p: 1 })) }, 0, 1000, { ...pencil, pressure: true })
    expect(pressed[2]).toBeCloseTo(0.05 * 1.45, 6)
  })
  it('finds the long axis of a furniture shape and brushes along it with overlap', () => {
    const tilted = [[0.2, 0.2], [0.8, 0.5], [0.75, 0.6], [0.15, 0.3]] as const
    const region = regionOf(tilted)
    expect(region.halfLength).toBeGreaterThan(region.halfWidth)
    expect(Math.abs(region.angle - Math.atan2(0.3, 0.6))).toBeLessThan(0.15)
    const { stroke, radius } = brushStrokes(region, 4, 1200, 1)
    expect(radius).toBeGreaterThanOrEqual(1.3 * region.halfWidth / 4 - 1e-9)
    expect(stroke.points.filter((p, i) => i > 0 && !p.down)).toHaveLength(3)
    expect(stroke.points.at(-1)?.t).toBeCloseTo(1200, 6)
  })
  it('starts outward painting from the middle lane', () => {
    const region = { cx: 0.5, cy: 0.5, angle: 0, halfLength: 0.4, halfWidth: 0.4 }
    const first = brushStrokes(region, 5, 1000, 2, 'outward').stroke.points[1]
    expect(Math.abs(first.y - 0.5)).toBeLessThan(0.05)
  })
  it('compresses the pauses of a hand-traced path and rescales it', () => {
    const raw = [
      { x: 0.1, y: 0.1, t: 1000, down: false }, { x: 0.2, y: 0.1, t: 1500, down: true },
      { x: 0.5, y: 0.5, t: 9000, down: false }, { x: 0.6, y: 0.5, t: 9400, down: true },
    ]
    const stroke = tracedStroke(raw, 2000)
    expect(stroke.points[0].t).toBe(0)
    expect(stroke.points.at(-1)?.t).toBeCloseTo(2000, 6)
    // 7.5 s 的停顿压到 120 ms：抬笔那一段只占很小一部分
    expect(stroke.points[2].t - stroke.points[1].t).toBeLessThan(stroke.points[1].t - stroke.points[0].t)
  })
  it('hit-tests furniture shapes', () => {
    const mug = DEFAULT_FURNITURE.find((f) => f.id === 'mug')!
    expect(insidePolygon(0.24, 0.67, mug.points)).toBe(true)
    expect(insidePolygon(0.5, 0.2, mug.points)).toBe(false)
  })
})

const job = (id: string, durationMs: number, fillMs = 0, channel: Job['channel'] = 'paint'): Job => ({
  id, channel, blend: 'add', mask: { kind: 'none' }, cursor: 'quill', fillMs, style: pencil,
  stroke: { durationMs, points: [{ x: 0.1, y: 0.5, t: 0, down: false }, { x: 0.9, y: 0.5, t: durationMs, down: true }] },
})

describe('painter', () => {
  it('paints jobs one after another, then fills, and shows the pen only while drawing', () => {
    const painter = new Painter()
    painter.enqueue(job('a', 1000, 200))
    let frame = painter.step(0)
    expect(frame.busy).toBe(true)
    frame = painter.step(500)
    expect(frame.stamps[0].job.id).toBe('a')
    expect(frame.cursor?.kind).toBe('quill')
    expect(frame.dry).toBe(0)
    frame = painter.step(1100)
    expect(frame.fills[0]?.level).toBeCloseTo(0.5, 6)
    frame = painter.step(1200)
    expect(frame.fills[0]?.level).toBe(1)
    expect(frame.busy).toBe(false)
    expect(frame.cursor).toBeNull()
    expect(painter.step(1650).dry).toBeCloseTo(0.5, 6)
    expect(painter.step(2200).dry).toBe(1)
  })
  it('hurries the current job while more are queued, and never loses stamps', () => {
    const painter = new Painter()
    painter.enqueue(job('a', 1000))
    painter.enqueue(job('b', 1000))
    painter.step(0)
    const frame = painter.step(500) // 后面还有一件：这一件按两倍速，0.5 s 就画完
    expect(frame.stamps.map((s) => s.job.id)).toEqual(['a'])
    expect(painter.has('b')).toBe(true)
    const next = painter.step(1000)
    expect(next.stamps.map((s) => s.job.id)).toEqual(['b'])
    const total = [frame, next].flatMap((f) => f.stamps).filter((s) => s.job.id === 'a').reduce((n, s) => n + s.data.length, 0)
    expect(total).toBe(stampsBetween(job('a', 1000).stroke, 0, 1000, pencil).length)
  })
  it('keeps pencil lines free of wet edges', () => {
    const painter = new Painter()
    painter.enqueue(job('lines', 1000, 0, 'room'))
    painter.step(0)
    expect(painter.step(500).dry).toBe(1)
  })
})

describe('what gets painted', () => {
  const her = { cx: 0.68, cy: 0.53, angle: 1.45, halfLength: 0.4, halfWidth: 0.24 }
  it('draws the empty room before her, then colors her simply, then for real, then the room', () => {
    const drawing = introJobs('drawing', her, undefined)
    expect(drawing.map((j) => [j.channel, j.cursor])).toEqual([['room', 'pencil'], ['her', 'pencil']])
    expect(drawing.every((j) => j.blend === 'max' && j.fillMs > 0)).toBe(true)
    expect(introJobs('flat', her, undefined)[0]).toMatchObject({ channel: 'paint', mask: { kind: 'her' }, cursor: 'quill', blend: 'add' })
    expect(introJobs('real', her, undefined)[0]).toMatchObject({ channel: 'real', mask: { kind: 'her' } })
    expect(introJobs('room', her, undefined)[0]).toMatchObject({ channel: 'paint+real', mask: { kind: 'none' } })
    expect(introJobs('paper', her, undefined)).toEqual([])
  })
  it('uses the hand-traced path when there is one', () => {
    const trace = { version: 1 as const, room: [{ x: 0.1, y: 0.1, t: 0, down: false }, { x: 0.5, y: 0.5, t: 800, down: true, p: 0.7 }], her: [] }
    const [room, herLines] = introJobs('drawing', her, trace)
    expect(room.style.pressure).toBe(true)
    expect(room.stroke.points).toHaveLength(2)
    expect(herLines.style.pressure).toBe(true)
  })
  it('paints one furniture piece inside its shape, restores the whole room with her quill, and repaints only her on a pose change', () => {
    const mug = DEFAULT_FURNITURE.find((f) => f.id === 'mug')!
    expect(furnitureJob(mug, regionOf(mug.points))).toMatchObject({ id: 'furniture:mug', channel: 'paint+real', mask: { kind: 'polygon', id: 'mug' }, cursor: 'quill' })
    expect(restoreJob()).toMatchObject({ channel: 'paint', mask: { kind: 'none' }, cursor: 'quill' })
    expect(poseJob(her)).toMatchObject({ channel: 'paint', mask: { kind: 'her' }, cursor: null })
  })
})

describe('painting together in the onboarding', () => {
  it('eases each pen-down stroke without changing its ends', () => {
    expect(strokeEase(0)).toBe(0); expect(strokeEase(1)).toBe(1)
    // 起笔慢、中间快：前十分之一的路走得比匀速少
    expect(strokeEase(0.1)).toBeLessThan(0.1); expect(strokeEase(0.5)).toBeCloseTo(0.5, 9)
    const { stroke } = brushStrokes({ cx: 0.5, cy: 0.5, angle: 0, halfLength: 0.3, halfWidth: 0.1 }, 2, 1000, 4)
    const down = stroke.points.slice(0, 18)
    const early = down[2].t - down[1].t, middle = down[9].t - down[8].t
    expect(early).toBeLessThan(middle)
  })
  it('measures how much of a furniture piece your strokes covered', () => {
    const square = [[0.2, 0.2], [0.4, 0.2], [0.4, 0.4], [0.2, 0.4]] as const
    const area = coverageOf(square)
    expect(area.ratio()).toBe(0)
    expect(area.sweep({ x: 0.2, y: 0.3 }, { x: 0.4, y: 0.3 }, 0.03)).toBeGreaterThan(0.2)
    for (let y = 0.2; y <= 0.4; y += 0.04) area.sweep({ x: 0.2, y }, { x: 0.4, y }, 0.03)
    expect(area.ratio()).toBe(1)
    expect(stampsBetween(segment({ x: 0.1, y: 0.1 }, { x: 0.1, y: 0.1 }), 0, 1, { radius: 0.02, strength: 0.5, aspect: 1, ragged: 0 })).toHaveLength(STAMP_FLOATS)
  })
  it('times a job queued on an idle painter from when it starts, so its pen is seen', () => {
    const painter = new Painter()
    const job = furnitureJob(DEFAULT_FURNITURE.find((f) => f.id === 'mug')!, regionOf(DEFAULT_FURNITURE.find((f) => f.id === 'mug')!.points))
    painter.enqueue(job)
    painter.step(0)
    while (painter.busy) painter.step(5_000)
    // Seconds later, after the room sat idle: the next piece still starts at its first stroke.
    painter.enqueue({ ...job, id: 'again' })
    const first = painter.step(60_000)
    expect(first.cursor).toMatchObject({ kind: 'quill' })
    expect(painter.step(60_016).busy).toBe(true)
  })
})

