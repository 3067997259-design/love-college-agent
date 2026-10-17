import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { AWAY_ART_KEYS, resolveAwayArt } from '../../src/renderer/src/book/life/awayArt'
import { SCENARIOS } from '../../src/renderer/src/dev/scenarios'

const awayDir = resolve('src/renderer/src/assets/character/taozi/away')
const companion = SCENARIOS['morning-idle'].companion

describe('away art (视频冻结包外景复用)', () => {
  it('ships an image and a manifest entry for every away key', () => {
    const manifest = JSON.parse(readFileSync(resolve(awayDir, 'manifest.json'), 'utf8')) as {
      assets: { runtime: string; from: string; sha256: string }[]
    }
    for (const key of AWAY_ART_KEYS) {
      expect(existsSync(resolve(awayDir, `${key}.png`)), key).toBe(true)
      expect(manifest.assets.some((asset) => asset.runtime === `${key}.png` && /^[0-9a-f]{64}$/.test(asset.sha256)), key).toBe(true)
    }
  })

  it('uses day art for morning/day and separate frames for evening/night', () => {
    expect(resolveAwayArt({ ...companion, locationId: 'coast' })).toMatchObject({ key: 'coast-day', place: 'coast' })
    expect(resolveAwayArt({ ...companion, locationId: 'coast', daypart: 'evening' })).toMatchObject({ key: 'coast-evening' })
    expect(resolveAwayArt({ ...companion, locationId: 'swing' })).toMatchObject({ key: 'swing-day', place: 'swing' })
    expect(resolveAwayArt({ ...companion, locationId: 'swing', daypart: 'evening' })).toMatchObject({ key: 'swing-evening' })
  })

  it('marks the night swing as baked light so the daypart tint is not applied twice', () => {
    expect(resolveAwayArt({ ...companion, locationId: 'swing', daypart: 'night' })).toMatchObject({
      key: 'swing-night', lighting: 'baked-night',
    })
  })

  it('falls back to the daylit coast frame with ambient tint at night (no fake relight)', () => {
    const art = resolveAwayArt({ ...companion, locationId: 'coast', daypart: 'night' })
    expect(art).toMatchObject({ key: 'coast-day', lighting: 'ambient' })
  })

  it('returns null for the room and for unknown legacy locations', () => {
    expect(resolveAwayArt({ ...companion, locationId: 'room' })).toBeNull()
    expect(resolveAwayArt({ ...companion, locationId: 'shore' })).toBeNull()
  })

  it('resolves every away demo scene without a missing image', () => {
    for (const scene of Object.values(SCENARIOS)) {
      const art = resolveAwayArt(scene.companion)
      if (!art) continue
      expect(existsSync(resolve(awayDir, `${art.key}.png`)), `${scene.companion.locationId}/${scene.companion.daypart}`).toBe(true)
    }
  })
})
