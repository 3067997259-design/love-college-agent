import type { MemoryFragment } from './types'

import { describe, expect, it } from 'vitest'

import { buildMemoryDirectory, validateMemoryProposal } from './interaction'

function fact(id: string, patch: Partial<MemoryFragment> = {}): MemoryFragment {
  return { id, content: 'Original fact', memoryType: 'short_term', category: 'chat', importance: 5, emotionalImpact: 0, valence: 0, arousal: 0, halfLifeHours: 24, sessionIds: [], createdAt: 1, lastAccessed: 1, accessCount: 0, scope: { userId: 'a', characterId: 'b' }, reviewStatus: 'approved', factStatus: 'active', revision: 1, pinned: true, ...patch }
}

describe('pinned memory directory', () => {
  it('keeps byte stability across access changes and uses reviewed summaries only', () => {
    const original = fact('a', { summary: 'Old summary', summaryRevision: 0 })
    const before = buildMemoryDirectory([original, fact('b', { pinOrder: -1 })])
    const after = buildMemoryDirectory([fact('b', { pinOrder: -1 }), { ...original, accessCount: 9, lastAccessed: 9000 }])
    expect(after.text).toBe(before.text)
    expect(after.entries.map(entry => entry.id)).toEqual(['b', 'a'])
    expect(after.text).not.toContain('Old summary')
    expect(after.entries[1]?.excerpt).toBe(true)
  })

  it('excludes unreviewed, disputed, replaced and non-factual records', () => {
    expect(buildMemoryDirectory([
      fact('pending', { reviewStatus: 'pending' }),
      fact('rejected', { reviewStatus: 'rejected' }),
      fact('disputed', { factStatus: 'disputed' }),
      fact('old', { factStatus: 'superseded' }),
      fact('muscle', { memoryType: 'muscle' }),
      fact('legacy', { scope: undefined, reviewStatus: undefined }),
    ]).text).toBe('')
  })

  it('bounds the complete serialization and reports omissions without truncating fields', () => {
    const facts = Array.from({ length: 21 }, (_, index) => fact(String(index)))
    const limited = buildMemoryDirectory(facts)
    expect(limited.entries).toHaveLength(20)
    expect(limited.omitted).toHaveLength(1)
    expect(limited.text.length).toBeLessThanOrEqual(4000)
    expect(buildMemoryDirectory(facts, 40).entries).toEqual([])
    expect(buildMemoryDirectory(facts, 40).omitted).toHaveLength(21)
    expect(() => validateMemoryProposal({ kind: 'remember', content: 'x'.repeat(2001) })).toThrow('2000')
  })

  it('carries immutable historical world identity inside the bounded directory', () => {
    const directory = buildMemoryDirectory([fact('game', { sourceContext: { sessionId: 's', neighbors: [], gameWorld: { worldId: 'old-world', connectionId: 'old-connection', connectionGeneration: 1, dimension: 'overworld', observedAt: 1 } } })])
    expect(directory.text).toContain('historicalGameObservation')
    expect(directory.text).toContain('old-world')
  })
})
