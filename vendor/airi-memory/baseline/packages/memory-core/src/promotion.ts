import type { MemoryFragment } from './types'

import { DEFAULT_MEMORY_HALF_LIFE_HOURS } from './types'

/** Returns whether a short-term fragment has enough cross-session evidence. */
export function shouldPromoteMemory(input: MemoryFragment, options: {
  minAccessCount?: number
  minSessionCount?: number
  /** Pending/rejected fragments never enter long-term (MEMORY-DESIGN §11.2). */
  requireApproved?: boolean
} = {}): boolean {
  if (input.memoryType !== 'short_term')
    return false

  if (options.requireApproved !== false) {
    if (input.reviewStatus === 'pending' || input.reviewStatus === 'rejected')
      return false
  }

  const minAccessCount = options.minAccessCount ?? 3
  const minSessionCount = options.minSessionCount ?? 2
  const sessionCount = new Set(input.sessionIds).size

  return input.accessCount >= minAccessCount && sessionCount >= minSessionCount
}

/** Promotes an eligible fragment without mutating the source object. */
export function promoteMemory(input: MemoryFragment, halfLifeHours = DEFAULT_MEMORY_HALF_LIFE_HOURS.long_term): MemoryFragment {
  if (!shouldPromoteMemory(input))
    return input

  return {
    ...input,
    memoryType: 'long_term',
    halfLifeHours,
  }
}
