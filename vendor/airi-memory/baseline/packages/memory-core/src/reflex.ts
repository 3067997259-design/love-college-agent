import type { MemoryFragment } from './types'

/** Base probability used by the rare intrusive-memory reflex. */
export const DEFAULT_INTRUSION_BASE_RATE = 0.02

/** Minimum delay between two intrusive-memory activations. */
export const DEFAULT_INTRUSION_COOLDOWN_MS = 30_000

/** Returns whether a fragment is eligible for the intrusive-memory channel. */
export function isIntrusiveMemoryCandidate(fragment: MemoryFragment, now: number, cooldownMs = DEFAULT_INTRUSION_COOLDOWN_MS): boolean {
  return fragment.memoryType !== 'muscle'
    && fragment.arousal >= 0.7
    && fragment.valence <= -0.5
    && (fragment.lastIntrudedAt == null || now - fragment.lastIntrudedAt >= cooldownMs)
}

/** Calculates the rare intrusion probability for one traumatic fragment. */
export function calculateIntrusionProbability(fragment: MemoryFragment, baseRate = DEFAULT_INTRUSION_BASE_RATE): number {
  return Math.max(0, Math.min(1, fragment.arousal * Math.abs(Math.min(fragment.valence, 0)) * baseRate))
}

/** Selects the highest-arousal candidate when the injected random draw succeeds. */
export function selectIntrusiveMemory(input: {
  fragments: MemoryFragment[]
  now: number
  random?: () => number
  baseRate?: number
  cooldownMs?: number
}): MemoryFragment | undefined {
  const random = input.random ?? Math.random
  const candidates = input.fragments
    .filter(fragment => isIntrusiveMemoryCandidate(fragment, input.now, input.cooldownMs))
    .filter(fragment => random() < calculateIntrusionProbability(fragment, input.baseRate))
    .sort((left, right) => right.arousal - left.arousal)

  return candidates[0]
}

/**
 * Whether a fragment may influence behavior right now.
 *
 * An `undefined` review or fact status marks rows that predate the review
 * gate; those count as approved and active (MEMORY-DESIGN §11.2). Explicit
 * `pending` or `rejected` rows are not confirmed facts yet, and `superseded`
 * or `disputed` rows lost their claim, so none of them may enter a behavior
 * prompt or fire a reflex.
 */
export function isActionableMemoryFragment(fragment: Pick<MemoryFragment, 'reviewStatus' | 'factStatus'>): boolean {
  const reviewed = fragment.reviewStatus === undefined || fragment.reviewStatus === 'approved'
  const active = fragment.factStatus === undefined || fragment.factStatus === 'active'
  return reviewed && active
}

/**
 * Matches a muscle-memory trigger as a regular expression or exact text.
 *
 * Only an approved, still-active muscle may fire: a pending or rejected one
 * has no human confirmation and a superseded or disputed one lost its claim,
 * so none of them act even when the pattern matches the input.
 */
export function matchesMuscleMemory(fragment: MemoryFragment, text: string): boolean {
  if (fragment.memoryType !== 'muscle' || !fragment.triggerPattern?.trim())
    return false
  if (!isActionableMemoryFragment(fragment))
    return false

  try {
    return new RegExp(fragment.triggerPattern, 'i').test(text)
  }
  catch {
    return fragment.triggerPattern === text
  }
}
