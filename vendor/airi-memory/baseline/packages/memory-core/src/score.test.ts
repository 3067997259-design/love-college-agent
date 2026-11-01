import { describe, expect, it } from 'vitest'

import { calculateMemoryScore, scoreMemoryFragment } from './score'

describe('memory score', () => {
  it('applies mood congruence to the valence of a fragment', () => {
    const negativeScore = calculateMemoryScore({
      similarity: 0.8,
      ageHours: 0,
      halfLifeHours: 24,
      arousal: 0.5,
      accessCount: 1,
      valence: -0.8,
      mood: { valence: -1 },
    })
    const positiveScore = calculateMemoryScore({
      similarity: 0.8,
      ageHours: 0,
      halfLifeHours: 24,
      arousal: 0.5,
      accessCount: 1,
      valence: 0.8,
      mood: { valence: -1 },
    })

    expect(negativeScore).toBeGreaterThan(positiveScore)
  })

  it('returns the score components for a persisted fragment', () => {
    const result = scoreMemoryFragment({
      fragment: {
        id: 'memory-1',
        content: 'A fact',
        memoryType: 'short_term',
        category: 'chat',
        importance: 5,
        emotionalImpact: 0,
        createdAt: 0,
        lastAccessed: 0,
        accessCount: 1,
        valence: 0.2,
        arousal: 0.5,
        halfLifeHours: 24,
        sessionIds: [],
      },
      similarity: 0.8,
      now: 0,
      mood: { valence: 1 },
    })

    expect(result.similarity).toBe(0.8)
    expect(result.timeRelevance).toBe(1)
    expect(result.moodCongruence).toBe(1)
    expect(result.score).toBeGreaterThan(0)
  })
})
