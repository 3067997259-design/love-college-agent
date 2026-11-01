import type { MemoryMood } from './types'

const POSITIVE_EMOTIONS = new Set(['happy', 'surprised', 'curious'])
const NEGATIVE_EMOTIONS = new Set(['sad', 'angry', 'awkward'])

/** Converts the existing AIRI ACT emotion signal into a bounded mood vector. */
export function emotionToMood(emotion: { name: string, intensity: number }): MemoryMood {
  const name = emotion.name.trim().toLowerCase()
  const intensity = Math.max(0, Math.min(1, Number.isFinite(emotion.intensity) ? emotion.intensity : 0))
  const valence = POSITIVE_EMOTIONS.has(name)
    ? intensity
    : NEGATIVE_EMOTIONS.has(name)
      ? -intensity
      : 0

  return { valence, arousal: intensity }
}
