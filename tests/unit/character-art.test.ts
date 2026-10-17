import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { resolveCharacterArt } from '../../src/renderer/src/book/characterArt'
import { SCENARIOS } from '../../src/renderer/src/dev/scenarios'

describe('approved art and companion state', () => {
  it('has a shipped image for every Demo scene', () => {
    for (const scene of Object.values(SCENARIOS)) {
      const art = resolveCharacterArt(scene.companion)
      expect(existsSync(resolve('src/renderer/src/assets/character/taozi/approved', `${art.key}.png`)), art.key).toBe(true)
    }
  })
  it('distinguishes sleeping with a nightlight from explicit lights out', () => {
    const sleeping = SCENARIOS.asleep.companion
    expect(resolveCharacterArt(sleeping)).toEqual({ key: 'sleeping_nightlight', lighting: 'baked-night' })
    expect(resolveCharacterArt({ ...sleeping, lightsOut: true })).toEqual({ key: 'sleeping_dark', lighting: 'baked-dark' })
    expect(resolveCharacterArt({ ...sleeping, daypart: 'day' }).key).toBe('sleeping_calm')
  })
  it('does not invent sleep or use a lit work lamp when a conscious user pauses activity', () => {
    expect(resolveCharacterArt(SCENARIOS['lights-out'].companion)).toEqual({ key: 'desk-writing_calm', lighting: 'ambient' })
    expect(resolveCharacterArt(SCENARIOS['night-lamp'].companion)).toEqual({
      key: 'desk-writing_night', lighting: 'baked-night', baseKey: 'desk-writing_calm',
    })
  })
  it('keeps an away room empty even if the retained pose is sleeping', () => {
    expect(resolveCharacterArt({ ...SCENARIOS.asleep.companion, locationId: 'shore' })).toMatchObject({
      key: 'empty__night', lighting: 'baked-night',
    })
  })
  it('uses the think frame for the fourth expression', () => {
    expect(resolveCharacterArt({ ...SCENARIOS['morning-idle'].companion, pose: 'facing-user', expression: 'think' })).toMatchObject({
      key: 'facing-user_think', lighting: 'ambient', baseKey: 'facing-user_calm',
    })
  })
  it('uses baked night relights for the awake indoor poses (2026-10-17 deltas)', () => {
    const base = SCENARIOS['morning-idle'].companion
    expect(resolveCharacterArt({ ...base, pose: 'facing-user', expression: 'calm', daypart: 'night' })).toMatchObject({
      key: 'facing-user_calm__night', lighting: 'baked-night', baseKey: 'facing-user_calm',
    })
    expect(resolveCharacterArt({ ...base, pose: 'desk-computer', daypart: 'night' })).toMatchObject({
      key: 'desk-computer_calm__night', lighting: 'baked-night', baseKey: 'desk-computer_calm',
    })
    // 明确熄灯不是夜景重光：仍用白天图加暗色
    expect(resolveCharacterArt({ ...base, pose: 'facing-user', expression: 'calm', daypart: 'night', lightsOut: true })).toMatchObject({
      key: 'facing-user_calm', lighting: 'ambient',
    })
  })
})
