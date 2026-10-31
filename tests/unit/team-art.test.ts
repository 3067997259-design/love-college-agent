import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { artOf, figureOf, SPRITES, TEAM_SPRITES } from '../../src/renderer/src/book/team/teamArt'
import { headAt, slotOf, STATIONS, type Station, type TeamPose } from '../../src/renderer/src/book/team/teamScene'

const dir = join(import.meta.dirname, '../../src/renderer/src/assets/character/taozi/team')
const places = (Object.keys(STATIONS) as Station[]).flatMap((station) => STATIONS[station].map((_, index) => ({ station, index })))
const poses: TeamPose[] = ['idle', 'entering', 'typing', 'reading', 'carrying', 'waiting', 'completed', 'thinking', 'resting', 'failed', 'stopping', 'blocked']

describe('team sprite measurements', () => {
  it('match the pictures on disk (rerun art/tools/measure-team-sprites.mjs after changing a sprite)', () => {
    for (const sprite of TEAM_SPRITES) {
      const m = SPRITES[sprite]
      expect(m, sprite).toBeDefined()
      expect(createHash('sha256').update(readFileSync(join(dir, m.file))).digest('hex'), sprite).toBe(m.sha256)
      // A head box is part of a figure near its top; feet are near the middle of the picture.
      expect(m.head.top / m.height).toBeLessThan(.1)
      expect(m.head.height / m.height).toBeGreaterThan(.3)
      expect(m.head.height / m.height).toBeLessThan(.65)
      expect(m.footX / m.width).toBeGreaterThan(.25)
      expect(m.footX / m.width).toBeLessThan(.75)
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
  it('lifts a helper onto her stool only where the tabletop hides it', () => {
    for (const place of places) {
      const slot = slotOf(place), art = artOf('typing', place, slot)
      expect(art.lift > 0).toBe(slot.stool === 'hidden')
      if (art.lift) expect(figureOf(slot, art).feet).toBeLessThan(slot.y)
    }
  })
  it('never mirrors: direction comes from the place', () => {
    const left = places.find((place) => slotOf(place).facing === 'left')!, right = places.find((place) => slotOf(place).facing === 'right')!
    expect(artOf('carrying', left, slotOf(left)).sprite).toBe('note-left')
    expect(artOf('carrying', right, slotOf(right)).sprite).toBe('note-right')
    expect(artOf('reading', { station: 'bookshelf', index: 0 }, slotOf({ station: 'bookshelf', index: 0 })).sprite).toBe('shelf-reach')
    expect(artOf('reading', { station: 'bookshelf', index: 1 }, slotOf({ station: 'bookshelf', index: 1 })).sprite).toBe('reading-back')
  })
})
