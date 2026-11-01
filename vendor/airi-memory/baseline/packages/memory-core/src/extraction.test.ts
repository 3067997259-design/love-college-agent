import { describe, expect, it } from 'vitest'

import { parseMemoryTurnExtractions } from './extraction'

describe('parseMemoryTurnExtractions', () => {
  it('normalizes a well-formed fact entry with its defaults', () => {
    expect(parseMemoryTurnExtractions(
      [{ content: 'The user prefers tests before edits', category: 'chat', memoryType: 'short_term', importance: 8, valence: 0.5, arousal: 0.2, tags: ['workflow'] }],
      { sessionId: 's1' },
    )).toEqual([{
      content: 'The user prefers tests before edits',
      category: 'chat',
      memoryType: 'short_term',
      importance: 8,
      valence: 0.5,
      arousal: 0.2,
      tags: ['workflow'],
      sessionId: 's1',
    }])
  })

  // ROOT CAUSE:
  //
  // A user preference was persisted as muscle because the extraction prompt
  // offered `muscle` as a valid label. Ordinary extraction now only produces
  // facts: a mislabeled entry is corrected to a reviewable short-term fact
  // instead of becoming a zero-token reflex that vector search cannot see.
  it('corrects a muscle label to a reviewable short-term fact', () => {
    const extractions = parseMemoryTurnExtractions(
      [{ content: 'The user prefers tests before edits', category: 'chat', memoryType: 'muscle' }],
      { sessionId: 's1' },
    )

    expect(extractions).toHaveLength(1)
    expect(extractions[0]?.memoryType).toBe('short_term')
    expect(extractions[0]).not.toHaveProperty('triggerPattern')
  })

  it('drops entries without a usable fact shape', () => {
    expect(parseMemoryTurnExtractions([
      { content: '   ', category: 'chat', memoryType: 'short_term' },
      { content: 'No category', memoryType: 'short_term' },
      { content: 'Unknown type', category: 'chat', memoryType: 'long_term' },
      { content: 'Missing type', category: 'chat' },
      'not an object',
      null,
    ], { sessionId: 's1' })).toEqual([])
  })

  it('returns nothing when the payload is not an array', () => {
    expect(parseMemoryTurnExtractions({ content: 'A fact' }, { sessionId: 's1' })).toEqual([])
    expect(parseMemoryTurnExtractions('[]', { sessionId: 's1' })).toEqual([])
    expect(parseMemoryTurnExtractions(null, { sessionId: 's1' })).toEqual([])
  })

  it('clamps mood numbers and filters non-string tags', () => {
    expect(parseMemoryTurnExtractions(
      [{ content: 'A fact', category: 'chat', memoryType: 'short_term', importance: 99, valence: -9, arousal: 9, tags: ['ok', 7, null], sessionId: 'ignored' }],
      { sessionId: 's1' },
    )).toEqual([{
      content: 'A fact',
      category: 'chat',
      memoryType: 'short_term',
      importance: 10,
      valence: -1,
      arousal: 1,
      tags: ['ok'],
      sessionId: 's1',
    }])
  })

  it('keeps a supported event description as episodic source data', () => {
    expect(parseMemoryTurnExtractions([
      {
        content: 'The user and the assistant completed the migration review.',
        category: 'chat',
        memoryType: 'short_term',
        episodic: {
          eventType: 'migration-review',
          participants: ['user', 4, 'assistant', '  '],
          location: 'workspace',
        },
      },
    ], { sessionId: 's1' })).toEqual([expect.objectContaining({
      episodic: {
        eventType: 'migration-review',
        participants: ['user', 'assistant'],
        location: 'workspace',
      },
    })])
  })

  it('falls back to neutral defaults when mood numbers are not numeric', () => {
    expect(parseMemoryTurnExtractions(
      [{ content: 'A fact', category: 'chat', memoryType: 'short_term', importance: 'high' }],
      { sessionId: 's1' },
    )).toEqual([{
      content: 'A fact',
      category: 'chat',
      memoryType: 'short_term',
      importance: 5,
      valence: 0,
      arousal: 0,
      tags: [],
      sessionId: 's1',
    }])
  })
})
