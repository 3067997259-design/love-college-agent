import { describe, expect, it } from 'vitest'

import { parseMemorySourceContext } from './source-context'

describe('parseMemorySourceContext', () => {
  it('accepts a source turn and bounds persisted neighbors', () => {
    const neighbors = Array.from({ length: 6 }, (_, index) => `neighbor-${index}`)

    expect(parseMemorySourceContext({
      sessionId: 'session-1',
      messageId: 'message-1',
      neighbors,
    })).toEqual({
      sessionId: 'session-1',
      messageId: 'message-1',
      neighbors: ['neighbor-0', 'neighbor-1', 'neighbor-2', 'neighbor-3'],
    })
  })

  it('rejects malformed persisted source context', () => {
    expect(parseMemorySourceContext({ sessionId: 'session-1', neighbors: 'not-an-array' })).toBeUndefined()
    expect(parseMemorySourceContext(undefined)).toBeUndefined()
  })

  it('keeps non-chat event provenance fields', () => {
    expect(parseMemorySourceContext({
      sessionId: 'session-1',
      sourceEventId: 'task-1',
      sourceType: 'task:done',
      neighbors: [],
    })).toEqual({
      sessionId: 'session-1',
      sourceEventId: 'task-1',
      sourceType: 'task:done',
      neighbors: [],
    })
  })

  it('round-trips the world-scoped game binding and drops a malformed one (mc-1b)', () => {
    expect(parseMemorySourceContext({
      sessionId: 'session-1',
      neighbors: [],
      gameWorld: { worldId: 'connection-scoped', connectionId: 'connection-3', connectionGeneration: 3, dimension: 'minecraft:overworld', observedAt: 1_700_000_000_000 },
    })).toMatchObject({
      gameWorld: { worldId: 'connection-scoped', connectionId: 'connection-3', connectionGeneration: 3, dimension: 'minecraft:overworld', observedAt: 1_700_000_000_000 },
    })

    expect(parseMemorySourceContext({ sessionId: 'session-1', neighbors: [], gameWorld: { worldId: 'w' } }))
      .toEqual({ sessionId: 'session-1', neighbors: [] })
  })
})
