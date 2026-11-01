import { describe, expect, it } from 'vitest'

import { promoteMemory, shouldPromoteMemory } from './promotion'

const fragment = {
  id: 'memory-1',
  content: 'A fact',
  memoryType: 'short_term' as const,
  category: 'chat',
  importance: 5,
  emotionalImpact: 0,
  createdAt: 0,
  lastAccessed: 0,
  accessCount: 3,
  valence: 0,
  arousal: 0,
  halfLifeHours: 24,
  sessionIds: ['session-a', 'session-b'],
}

describe('memory promotion', () => {
  it('requires access and cross-session evidence', () => {
    expect(shouldPromoteMemory(fragment)).toBe(true)
    expect(shouldPromoteMemory({ ...fragment, sessionIds: ['session-a'] })).toBe(false)
    expect(shouldPromoteMemory({ ...fragment, accessCount: 2 })).toBe(false)
  })

  it('changes only eligible short-term fragments', () => {
    expect(promoteMemory(fragment).memoryType).toBe('long_term')
    expect(promoteMemory(fragment).halfLifeHours).toBe(4_320)
    expect(promoteMemory({ ...fragment, memoryType: 'muscle' }).memoryType).toBe('muscle')
  })
})
