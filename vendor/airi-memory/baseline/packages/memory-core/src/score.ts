import type { MemoryFragment, MemoryMood, MemoryScoreWeights, ScoredMemoryFragment } from './types'

import { calculateMemoryTimeRelevance } from './decay'
import { DEFAULT_MEMORY_SCORE_WEIGHTS } from './types'

function normalizeMoodValence(mood?: MemoryMood): number {
  if (!mood || !Number.isFinite(mood.valence))
    return 0

  return Math.max(-1, Math.min(1, mood.valence))
}

/**
 * Calculates the five-term memory score.
 *
 * @example
 * calculateMemoryScore({ similarity: 0.8, ageHours: 0, halfLifeHours: 24, arousal: 0.5, accessCount: 1, valence: -0.8 }, { valence: -1 })
 * // => 1.614
 */
export function calculateMemoryScore(input: {
  similarity: number
  ageHours: number
  halfLifeHours: number
  arousal: number
  accessCount: number
  valence: number
  mood?: MemoryMood
  weights?: Partial<MemoryScoreWeights>
}): number {
  const weights = { ...DEFAULT_MEMORY_SCORE_WEIGHTS, ...input.weights }
  const moodCongruence = normalizeMoodValence(input.mood)
  const timeRelevance = calculateMemoryTimeRelevance(0, Math.max(0, input.ageHours) * 60 * 60 * 1_000, input.halfLifeHours)

  return (weights.similarity * input.similarity)
    + (weights.timeRelevance * timeRelevance)
    + (weights.arousal * input.arousal)
    + (weights.accessCount * Math.log1p(Math.max(0, input.accessCount)))
    + (weights.moodCongruence * moodCongruence * input.valence)
}

/** Scores a persisted fragment after a vector similarity query. */
export function scoreMemoryFragment(input: {
  fragment: MemoryFragment
  similarity: number
  now: number
  mood?: MemoryMood
  weights?: Partial<MemoryScoreWeights>
}): ScoredMemoryFragment {
  const timeRelevance = calculateMemoryTimeRelevance(input.fragment.lastAccessed, input.now, input.fragment.halfLifeHours)
  const moodCongruence = normalizeMoodValence(input.mood)
  const score = calculateMemoryScore({
    similarity: input.similarity,
    ageHours: Math.max(0, input.now - input.fragment.lastAccessed) / (60 * 60 * 1_000),
    halfLifeHours: input.fragment.halfLifeHours,
    arousal: input.fragment.arousal,
    accessCount: input.fragment.accessCount,
    valence: input.fragment.valence,
    mood: input.mood,
    weights: input.weights,
  })

  return {
    ...input.fragment,
    similarity: input.similarity,
    timeRelevance,
    moodCongruence,
    score,
  }
}
