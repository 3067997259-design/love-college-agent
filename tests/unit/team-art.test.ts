import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { artOf, figureOf, laptopOf, OVER_DEPTH, PROPS, SPRITES, TEAM_PROPS, TEAM_SPRITES } from '../../src/renderer/src/book/team/teamArt'
import { depthOf, headAt, OCCLUDERS, slotOf, STATIONS, TABLE_HEADS, type Station, type TeamPose } from '../../src/renderer/src/book/team/teamScene'

const dir = join(import.meta.dirname, '../../src/renderer/src/assets/character/taozi/team')
const places = (Object.keys(STATIONS) as Station[]).flatMap((station) => STATIONS[station].map((_, index) => ({ station, index })))
const seats = STATIONS.table.map((slot, index) => ({ place: { station: 'table' as const, index }, slot, seat: slot.seat! }))
const poses: TeamPose[] = ['idle', 'entering', 'typing', 'reading', 'carrying', 'waiting', 'completed', 'thinking', 'resting', 'failed', 'stopping', 'blocked']
// The tea table measured on the 2048 px room image (room fractions): tabletop corners, and the feet of its legs.
const TABLETOP: [number, number][] = [[.065, .735], [.218, .679], [.45, .724], [.312, .795]]
const TABLE_FEET: [number, number][] = [[.087, .87], [.217, .807], [.43, .863], [.312, .947]]
const inside = (polygon: [number, number][], [x, y]: [number, number]) => polygon.every(([ax, ay], i) => {
  const [bx, by] = polygon[(i + 1) % polygon.length]
  return (bx - ax) * (y - ay) - (by - ay) * (x - ax) > 0
})
const sha = (file: string) => createHash('sha256').update(readFileSync(join(dir, file))).digest('hex')

describe('team sprite measurements', () => {
  it('match the pictures on disk (rerun art/tools/measure-team-sprites.mjs after changing a sprite)', () => {
    for (const sprite of TEAM_SPRITES) {
      const m = SPRITES[sprite]
      expect(m, sprite).toBeDefined()
      expect(sha(m.file), sprite).toBe(m.sha256)
      // A head box is part of a figure near its top (a stool below her makes the picture taller); feet near the middle.
      expect(m.head.top / m.height).toBeLessThan(.1)
      expect(m.head.height / m.height).toBeGreaterThan(.25)
      expect(m.head.height / m.height).toBeLessThan(.65)
      expect(m.footX / m.width).toBeGreaterThan(.25)
      expect(m.footX / m.width).toBeLessThan(.75)
    }
    for (const prop of TEAM_PROPS) {
      const m = PROPS[prop]
      expect(m, prop).toBeDefined()
      expect(sha(m.file), prop).toBe(m.sha256)
      // A laptop about a head wide and under a head tall, at the scale of the girls drawn beside it.
      expect(m.width / m.headPx).toBeGreaterThan(.8); expect(m.width / m.headPx).toBeLessThan(1.4)
      expect(m.height / m.headPx).toBeLessThan(1)
    }
  })
})

describe('one size rule for the whole room', () => {
  it('draws every pose at a place with the same head, so changing pose never resizes her', () => {
    for (const place of places) {
      const slot = slotOf(place)
      for (const pose of poses) {
        const art = artOf(pose, place, slot), m = SPRITES[art.sprite]
        expect(m, `${art.sprite} at ${place.station}`).toBeDefined()
        const figure = figureOf(slot, art)
        expect(figure.height * m.head.height / m.height).toBeCloseTo(headAt(slot.y), 10)
      }
    }
  })
  it('makes nearer helpers larger, and keeps the farthest place readable at a 600 px room', () => {
    expect(headAt(.95)).toBeGreaterThan(headAt(.7))
    for (const place of places) {
      const slot = slotOf(place), idle = SPRITES.idle
      expect(headAt(slot.y) * idle.height / idle.head.height * 600, `${place.station} ${place.index}`).toBeGreaterThanOrEqual(80)
    }
  })
  it('never mirrors: direction comes from the place', () => {
    const left = places.find((place) => slotOf(place).facing === 'left')!, right = places.find((place) => slotOf(place).facing === 'right')!
    expect(artOf('carrying', left, slotOf(left)).sprite).toBe('note-left')
    expect(artOf('carrying', right, slotOf(right)).sprite).toBe('note-right')
    expect(artOf('reading', { station: 'bookshelf', index: 0 }, slotOf({ station: 'bookshelf', index: 0 })).sprite).toBe('shelf-reach')
    expect(artOf('reading', { station: 'bookshelf', index: 1 }, slotOf({ station: 'bookshelf', index: 1 })).sprite).toBe('reading-back')
    // Seat pictures are named for where the girl stands: the one at the right turns left, and the other way round.
    for (const { slot, seat } of seats) expect(slot.facing).toBe(seat.sprite.endsWith('-right') ? 'left' : 'right')
  })
})

describe('the tea table', () => {
  it('puts working helpers on their stool picture, and lifts other poses only where the tabletop hides the stool', () => {
    for (const { place, slot, seat } of seats) {
      for (const pose of ['typing', 'reading'] as const) expect(artOf(pose, place, slot)).toEqual({ sprite: seat.sprite, lift: 0 })
      for (const pose of poses.filter((pose) => pose !== 'typing' && pose !== 'reading')) {
        const art = artOf(pose, place, slot), figure = figureOf(slot, art)
        expect(art.lift > 0).toBe(seat.stool === 'hidden')
        // Lifted feet are trimmed so they cannot dangle into the gap under the tabletop.
        expect(figure.cut > 0).toBe(art.lift > 0)
        if (art.lift) expect(figure.feet).toBeLessThan(slot.y)
      }
    }
  })
  it('brings her hands to the tabletop when she stands on her stool', () => {
    for (const { seat } of seats) {
      const m = SPRITES[seat.sprite]
      expect(m.hands, seat.sprite).toBeDefined()
      const hands = (m.bottom - m.hands!) / m.head.height
      expect(hands, seat.sprite).toBeGreaterThanOrEqual(TABLE_HEADS)
      expect(hands, seat.sprite).toBeLessThan(TABLE_HEADS + .15)
    }
  })
  it('stands each helper beside the table and each laptop on the tabletop', () => {
    const table = OCCLUDERS.find((layer) => layer.id === 'table')!.depth
    for (const { place, slot, seat } of seats) {
      expect(inside(TABLE_FEET, [slot.x, slot.y]), `seat ${place.index} stands in the table`).toBe(false)
      const laptop = laptopOf(seat)
      expect(inside(TABLETOP, [laptop.x, laptop.feet]), `laptop ${place.index} is off the tabletop`).toBe(true)
      expect(laptop.depth).toBeGreaterThan(table)
      // Helpers behind the table are under it and its laptops; a helper in front of the table covers them.
      expect(depthOf(slot) > laptop.depth).toBe(!slot.behind)
      if (seat.over) {
        expect(slot.behind).toBe('table')
        expect(OVER_DEPTH).toBeGreaterThan(laptop.depth)
        const figure = figureOf(slot, artOf('typing', place, slot))
        expect(figure.over).toBeGreaterThan(0); expect(figure.over).toBeLessThan(1)
      }
    }
  })
})
