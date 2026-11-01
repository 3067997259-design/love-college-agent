import { describe, expect, it } from 'vitest'

import { canTransitionDreamIdea, selectDreamSourceFragments } from './dream'

describe('dream idea lifecycle', () => {
  it('allows a new idea to become developing or abandoned', () => {
    expect(canTransitionDreamIdea('new', 'developing')).toBe(true)
    expect(canTransitionDreamIdea('new', 'abandoned')).toBe(true)
  })

  it('allows only completion or abandonment after development', () => {
    expect(canTransitionDreamIdea('developing', 'implemented')).toBe(true)
    expect(canTransitionDreamIdea('developing', 'abandoned')).toBe(true)
    expect(canTransitionDreamIdea('developing', 'new')).toBe(false)
  })

  it('keeps terminal states terminal', () => {
    expect(canTransitionDreamIdea('implemented', 'developing')).toBe(false)
    expect(canTransitionDreamIdea('abandoned', 'new')).toBe(false)
  })

  it('selects only reviewed factual memories for dreaming', () => {
    const fragments = [
      { memoryType: 'short_term', reviewStatus: 'approved', id: 'approved' },
      { memoryType: 'short_term', reviewStatus: 'pending', id: 'pending' },
      { memoryType: 'short_term', reviewStatus: 'rejected', id: 'rejected' },
      { memoryType: 'muscle', reviewStatus: 'approved', id: 'muscle' },
      { memoryType: 'long_term', id: 'legacy-approved' },
    ] as unknown as import('./types').MemoryFragment[]

    expect(selectDreamSourceFragments(fragments).map(fragment => fragment.id)).toEqual(['approved', 'legacy-approved'])
  })
})
