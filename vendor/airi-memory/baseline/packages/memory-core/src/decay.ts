const HOURS_IN_MS = 60 * 60 * 1_000

/**
 * Calculates exponential memory decay.
 *
 * @example
 * calculateMemoryDecay(24, 24, 0)
 * // => 1
 */
export function calculateMemoryDecay(halfLifeHours: number, ageHours: number, minimum = 0): number {
  if (!Number.isFinite(halfLifeHours) || halfLifeHours >= 1e9)
    return 1

  if (halfLifeHours <= 0)
    return minimum

  const safeAgeHours = Math.max(0, ageHours)
  const decay = Math.exp(-safeAgeHours * Math.LN2 / halfLifeHours)
  return Math.max(minimum, Math.min(1, decay))
}

/**
 * Calculates decay from millisecond timestamps.
 *
 * @example
 * calculateMemoryTimeRelevance(0, 24 * 60 * 60 * 1000, 24)
 * // => 0.5
 */
export function calculateMemoryTimeRelevance(createdAt: number, now: number, halfLifeHours: number): number {
  const ageHours = Math.max(0, now - createdAt) / HOURS_IN_MS
  return calculateMemoryDecay(halfLifeHours, ageHours)
}
