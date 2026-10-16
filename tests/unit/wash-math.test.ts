import { describe, expect, it } from 'vitest'
import { dryness, noiseAmplitude, poseOf, transitionKind, washProgress, washRadius } from '../../src/renderer/src/book/wash/wash-math'

describe('wash timing', () => {
  it('spreads fast then slow and reaches 98% of the radius at the stated duration', () => {
    expect(washRadius(0, 6000, 1)).toBe(0)
    expect(washRadius(6000, 6000, 1)).toBeCloseTo(0.98, 6)
    const early = washRadius(600, 6000, 1)
    const late = washRadius(5400, 6000, 1) - washRadius(4800, 6000, 1)
    expect(early).toBeGreaterThan(late * 5)
    expect(washRadius(-100, 6000, 1)).toBe(0)
    expect(washRadius(10, 0, 0.8)).toBe(0.8)
  })
  it('dries the wet edge only in the last fifth and forces completion', () => {
    expect(dryness(0.5)).toBe(0)
    expect(dryness(0.8)).toBe(0)
    expect(dryness(0.9)).toBeCloseTo(0.5, 6)
    expect(dryness(1)).toBe(1)
    expect(washProgress(7000, 6000)).toBe(1)
    expect(washProgress(1, 0)).toBe(1)
  })
  it('keeps the noise smaller than the radius while the bloom is tiny', () => {
    expect(noiseAmplitude(0, 0.045)).toBe(0)
    expect(noiseAmplitude(0.03, 0.045)).toBeLessThan(0.03)
    expect(noiseAmplitude(0.5, 0.045)).toBe(0.045)
  })
  it('re-washes only when the pose changes; expressions and lighting crossfade', () => {
    expect(poseOf('desk-writing_night')).toBe('desk-writing')
    expect(transitionKind(null, 'facing-user_calm')).toBe('none')
    expect(transitionKind('facing-user_calm', 'facing-user_calm')).toBe('none')
    expect(transitionKind('facing-user_calm', 'facing-user_smile')).toBe('crossfade')
    expect(transitionKind('desk-writing_calm', 'desk-writing_night')).toBe('crossfade')
    expect(transitionKind('facing-user_smile', 'desk-computer_calm')).toBe('wash')
    expect(transitionKind('desk-writing_calm', 'empty')).toBe('wash')
  })
})
