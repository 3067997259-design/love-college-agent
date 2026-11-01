import { describe, expect, it } from 'vitest'

import { calculateMemoryDecay, calculateMemoryTimeRelevance } from './decay'

describe('memory decay', () => {
  it('returns one for an infinite muscle-memory half-life', () => {
    expect(calculateMemoryDecay(1e9, 10_000)).toBe(1)
  })

  it('returns one half-life at the half-life age', () => {
    expect(calculateMemoryDecay(24, 24)).toBeCloseTo(0.5)
  })

  it('does not become negative for old memories', () => {
    expect(calculateMemoryDecay(24, 24 * 1_000)).toBeGreaterThan(0)
    expect(calculateMemoryDecay(24, 24 * 1_000)).toBeLessThan(0.001)
  })

  it('uses the timestamp as the decay reference', () => {
    expect(calculateMemoryTimeRelevance(0, 24 * 60 * 60 * 1_000, 24)).toBeCloseTo(0.5)
  })
})
