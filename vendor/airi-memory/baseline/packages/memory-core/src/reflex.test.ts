import { describe, expect, it } from 'vitest'

import { isActionableMemoryFragment, matchesMuscleMemory, selectIntrusiveMemory } from './reflex'

const trauma = {
  id: 'trauma',
  content: 'A traumatic memory',
  memoryType: 'long_term' as const,
  category: 'life',
  importance: 10,
  emotionalImpact: -10,
  createdAt: 0,
  lastAccessed: 0,
  accessCount: 1,
  valence: -0.9,
  arousal: 0.95,
  halfLifeHours: 4_320,
  sessionIds: [],
  lastIntrudedAt: null,
}

describe('memory reflexes', () => {
  it('selects a rare intrusive memory without semantic input', () => {
    expect(selectIntrusiveMemory({
      fragments: [trauma],
      now: 100_000,
      random: () => 0,
    })).toBe(trauma)
  })

  it('keeps intrusive memory on cooldown', () => {
    expect(selectIntrusiveMemory({
      fragments: [{ ...trauma, lastIntrudedAt: 90_000 }],
      now: 100_000,
      random: () => 0,
    })).toBeUndefined()
  })

  it('matches muscle memory patterns', () => {
    expect(matchesMuscleMemory({ ...trauma, memoryType: 'muscle', triggerPattern: 'tea|coffee' }, 'Make tea')).toBe(true)
    expect(matchesMuscleMemory({ ...trauma, memoryType: 'muscle', triggerPattern: '[' }, 'Make tea')).toBe(false)
  })

  // ROOT CAUSE:
  //
  // A user preference was persisted as muscle, so ordinary vector search
  // excluded it and the reflex channel still fired for any review status.
  // Unconfirmed and dethroned claims must never act even when their pattern
  // matches, otherwise a superseded reflex keeps steering behavior after the
  // correction loop replaced it.
  it('fires only an approved, still-active muscle with a usable trigger pattern', () => {
    const muscle = { ...trauma, memoryType: 'muscle' as const, triggerPattern: 'tea|coffee' }

    expect(matchesMuscleMemory({ ...muscle, triggerPattern: null }, 'Make tea')).toBe(false)
    expect(matchesMuscleMemory({ ...muscle, triggerPattern: '   ' }, 'Make tea')).toBe(false)
    expect(matchesMuscleMemory({ ...muscle, reviewStatus: 'pending' }, 'Make tea')).toBe(false)
    expect(matchesMuscleMemory({ ...muscle, reviewStatus: 'rejected' }, 'Make tea')).toBe(false)
    expect(matchesMuscleMemory({ ...muscle, factStatus: 'superseded' }, 'Make tea')).toBe(false)
    expect(matchesMuscleMemory({ ...muscle, factStatus: 'disputed' }, 'Make tea')).toBe(false)
    expect(matchesMuscleMemory({ ...muscle }, 'Make tea')).toBe(true)
    expect(matchesMuscleMemory({ ...muscle, reviewStatus: 'approved', factStatus: 'active' }, 'Make tea')).toBe(true)
  })

  it('treats only approved and active rows as actionable facts', () => {
    expect(isActionableMemoryFragment({ reviewStatus: undefined, factStatus: undefined })).toBe(true)
    expect(isActionableMemoryFragment({ reviewStatus: 'approved', factStatus: 'active' })).toBe(true)
    expect(isActionableMemoryFragment({ reviewStatus: 'pending', factStatus: undefined })).toBe(false)
    expect(isActionableMemoryFragment({ reviewStatus: 'rejected', factStatus: 'active' })).toBe(false)
    expect(isActionableMemoryFragment({ reviewStatus: 'approved', factStatus: 'superseded' })).toBe(false)
    expect(isActionableMemoryFragment({ reviewStatus: 'approved', factStatus: 'disputed' })).toBe(false)
  })
})
