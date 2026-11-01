import type { MemoryDreamIdeaStatus, MemoryFragment } from './types'

const DREAM_IDEA_TRANSITIONS: Readonly<Record<MemoryDreamIdeaStatus, readonly MemoryDreamIdeaStatus[]>> = Object.freeze({
  new: ['new', 'developing', 'abandoned'],
  developing: ['developing', 'implemented', 'abandoned'],
  implemented: ['implemented'],
  abandoned: ['abandoned'],
})

/**
 * Returns whether a dream idea can move to the requested lifecycle state.
 *
 * @example
 * canTransitionDreamIdea('new', 'developing')
 * // => true
 */
export function canTransitionDreamIdea(from: MemoryDreamIdeaStatus, to: MemoryDreamIdeaStatus): boolean {
  return DREAM_IDEA_TRANSITIONS[from].includes(to)
}

/**
 * Selects reviewed factual memories as inputs for a bounded dreaming pass.
 *
 * @example
 * selectDreamSourceFragments([{ memoryType: 'short_term', reviewStatus: 'approved' } as MemoryFragment])
 * // => the approved short-term fragment
 */
export function selectDreamSourceFragments(fragments: readonly MemoryFragment[], limit = 12): MemoryFragment[] {
  return fragments
    .filter(fragment => (fragment.memoryType === 'short_term' || fragment.memoryType === 'long_term')
      && fragment.reviewStatus !== 'pending'
      && fragment.reviewStatus !== 'rejected'
      && fragment.factStatus !== 'superseded'
      && fragment.factStatus !== 'disputed')
    .slice(0, Math.max(0, limit))
}
