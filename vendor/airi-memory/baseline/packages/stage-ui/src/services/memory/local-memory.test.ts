import { describe, expect, it, vi } from 'vitest'

import { createDuckDbMemoryRepository } from './local-memory'

const EMBEDDING = Array.from({ length: 768 }, (_, index) => (index % 7) + 1)

function memoryRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'memory-1',
    content: 'A durable fact',
    memory_type: 'short_term',
    category: 'chat',
    importance: 5,
    emotional_impact: 0,
    valence: 0.4,
    arousal: 0.5,
    half_life_hours: 24,
    session_ids_json: '["session-1"]',
    trigger_pattern: null,
    last_intruded_at: null,
    created_at: 1,
    last_accessed: 1,
    access_count: 1,
    content_vector_768: EMBEDDING,
    source_context_json: JSON.stringify({
      sessionId: 'session-1',
      messageId: 'message-1',
      neighbors: ['Assistant: Earlier context'],
    }),
    similarity: 0.9,
    ...overrides,
  }
}

describe('createDuckDbMemoryRepository', () => {
  it('saves, loads, and soft-deletes plan snapshots by id', async () => {
    const planRow = {
      id: 'goal-1',
      spec_json: JSON.stringify({
        goal: 'Maintain the workspace',
        horizon: 'long',
        steps: [{
          id: 'inspect',
          lane: 'coding',
          intent: 'Inspect the workspace',
          allowedTools: ['list'],
          expectedEvidence: [{ source: 'tool_result', description: 'directory listing' }],
          riskLevel: 'low',
          approvalRequired: false,
        }],
      }),
      state_json: JSON.stringify({
        currentStepId: 'inspect',
        completedSteps: [],
        failedSteps: [],
        skippedSteps: [],
        evidenceRefs: [],
        blockers: [],
      }),
      status: 'in_progress',
      created_at: 10,
      updated_at: 20,
      deadline: null,
    }
    const execute = vi.fn<(query: string) => Promise<unknown[]>>(async query => query.includes('FROM memory_long_term_goals') ? [planRow] : [])
    const repository = createDuckDbMemoryRepository({ execute })

    const plans = await repository.loadPlans()
    await repository.savePlan(plans[0]!)
    await repository.softDeletePlan('goal-1', 30)

    expect(plans[0]).toEqual(expect.objectContaining({
      id: 'goal-1',
      spec: expect.objectContaining({ horizon: 'long' }),
      state: expect.objectContaining({ currentStepId: 'inspect' }),
    }))
    const saveQuery = execute.mock.calls.find(([query]) => query.includes('INSERT INTO memory_long_term_goals'))?.[0]
    expect(saveQuery).toContain('spec_json')
    expect(saveQuery).toContain('state_json')
    expect(saveQuery).toContain('ON CONFLICT (id) DO UPDATE')
    expect(execute.mock.calls.some(([query]) => query.includes('SET deleted_at = 30'))).toBe(true)
  })

  it('restores source-turn neighbors from persisted search rows', async () => {
    const execute = vi.fn<(query: string) => Promise<unknown[]>>(async (query: string) => query.includes('FROM memory_fragments') ? [memoryRow()] : [])
    const repository = createDuckDbMemoryRepository({ execute })

    const results = await repository.search({
      embedding: EMBEDDING,
      now: 1,
    })

    expect(results[0]?.sourceContext).toEqual({
      sessionId: 'session-1',
      messageId: 'message-1',
      neighbors: ['Assistant: Earlier context'],
    })
  })

  it('excludes pending memories from behavior retrieval', async () => {
    const execute = vi.fn<(query: string) => Promise<unknown[]>>(async (query: string) => query.includes('FROM memory_fragments') ? [memoryRow({ review_status: 'pending' })] : [])
    const repository = createDuckDbMemoryRepository({ execute })

    await repository.search({ embedding: EMBEDDING, now: 1 })

    const searchQuery = execute.mock.calls.find(([query]) => query.includes('review_status'))?.[0]
    expect(searchQuery).toBeDefined()
    expect(searchQuery).toContain('review_status = \'approved\'')
  })

  it('returns only facts from the active user and character scope', async () => {
    const execute = vi.fn<(query: string) => Promise<unknown[]>>(async (query: string) => query.includes('FROM memory_fragments')
      ? [
          memoryRow({ id: 'character-a', scope_json: JSON.stringify({ userId: 'user-1', characterId: 'character-a' }) }),
          memoryRow({ id: 'character-b', scope_json: JSON.stringify({ userId: 'user-1', characterId: 'character-b' }) }),
        ]
      : [])
    const repository = createDuckDbMemoryRepository({ execute })

    const results = await repository.search({
      embedding: EMBEDDING,
      now: 1,
      scope: { userId: 'user-1', characterId: 'character-a' },
    })

    expect(results.map(result => result.id)).toEqual(['character-a'])
  })

  it('pushes shareable-fact eligibility into the query', async () => {
    // ROOT CAUSE (#12): the store filtered a page ordered by last access in
    // memory, so an eligible fact outside that page was never a candidate.
    const execute = vi.fn<(query: string) => Promise<unknown[]>>(async () => [])
    const repository = createDuckDbMemoryRepository({ execute })

    await repository.list({ limit: 5, scope: { userId: 'user-1', characterId: 'character-a' }, shareable: true })

    const query = execute.mock.calls[0]?.[0] ?? ''
    expect(query).toContain('json_extract_string(source_context_json')
    expect(query).toContain('review_status')
    expect(query).toContain('fact_status')
  })

  it('writes source-turn neighbors with the memory fragment', async () => {
    const execute = vi.fn<(query: string) => Promise<unknown[]>>(async (_query: string) => [])
    const repository = createDuckDbMemoryRepository({ execute })
    const sourceContext = {
      sessionId: 'session-1',
      messageId: 'message-1',
      neighbors: ['User: Earlier context'],
    }

    await repository.insert({
      content: 'A durable fact',
      category: 'chat',
      memoryType: 'short_term',
      importance: 5,
      valence: 0,
      arousal: 0,
      tags: ['important'],
      episodic: {
        eventType: 'conversation',
        participants: ['user'],
        location: 'home',
      },
      sessionId: 'session-1',
      sourceContext,
      embedding: EMBEDDING,
      now: 1,
    })

    const insertQuery = execute.mock.calls.find(([query]) => query.includes('INSERT INTO memory_fragments'))?.[0]
    expect(insertQuery).toContain('source_context_json')
    expect(insertQuery).toContain('Earlier context')
    expect(insertQuery).toContain('\'pending\'')
    expect(execute.mock.calls.some(([query]) => query.includes('INSERT INTO memory_tags'))).toBe(true)
    expect(execute.mock.calls.some(([query]) => query.includes('INSERT INTO memory_episodic'))).toBe(true)
  })

  it('stores and filters embedding source metadata', async () => {
    const execute = vi.fn<(query: string) => Promise<unknown[]>>(async (query: string) => {
      if (query.includes('FROM memory_fragments')) {
        return [memoryRow({
          embedding_provider: 'voyage',
          embedding_model: 'voyage-4-large',
          embedding_dimensions: 768,
          embedding_input_type: 'document',
          embedding_source_fingerprint: 'voyage-space',
          embedded_at: 10,
          embedding_status: 'active',
        })]
      }
      return []
    })
    const repository = createDuckDbMemoryRepository({ execute })
    const metadata = {
      embeddingProvider: 'voyage',
      embeddingModel: 'voyage-4-large',
      embeddingDimensions: 768,
      embeddingInputType: 'document' as const,
      embeddingSourceFingerprint: 'voyage-space',
      embeddedAt: 10,
      embeddingStatus: 'active' as const,
    }

    const fragment = await repository.insert({
      content: 'A voyage fact',
      category: 'chat',
      memoryType: 'short_term',
      importance: 5,
      valence: 0,
      arousal: 0,
      tags: [],
      embedding: EMBEDDING,
      embeddingMetadata: metadata,
      now: 10,
    })
    await repository.search({
      embedding: EMBEDDING,
      embeddingMetadata: { ...metadata, embeddingInputType: 'query' },
    })

    const insertQuery = execute.mock.calls.find(([query]) => query.includes('INSERT INTO memory_fragments'))?.[0]
    const searchQuery = execute.mock.calls.find(([query]) => query.includes('SELECT id') && query.includes('embedding_source_fingerprint'))?.[0]
    expect(insertQuery).toContain('voyage-4-large')
    expect(fragment.embeddingSourceFingerprint).toBe('voyage-space')
    expect(searchQuery).toContain('embedding_input_type = \'document\'')
    expect(searchQuery).toContain('embedding_source_fingerprint = \'voyage-space\'')
  })

  // ROOT CAUSE:
  //
  // Editing memory content changed only the text column. Semantic retrieval
  // kept comparing queries against the embedding of the old text.
  it('updates content and its embedding in one repository write', async () => {
    const execute = vi.fn<(query: string) => Promise<unknown[]>>(async (query: string) => query.includes('SELECT id') ? [memoryRow({ content: 'Updated fact' })] : [])
    const repository = createDuckDbMemoryRepository({ execute })

    await repository.update('memory-1', {
      content: 'Updated fact',
      contentVector: EMBEDDING,
    })

    const updateQuery = execute.mock.calls.find(([query]) => query.includes('UPDATE memory_fragments SET'))?.[0]
    expect(updateQuery).toContain('content = \'Updated fact\'')
    expect(updateQuery).toContain(`content_vector_json = '[1,2,3`)
  })

  it('keeps dream ideas in their own short-term table', async () => {
    const execute = vi.fn<(query: string) => Promise<unknown[]>>(async (query: string) => query.includes('FROM memory_short_term_ideas')
      ? [{
          id: 'idea-1',
          content: 'Try a smaller build loop',
          scope_json: JSON.stringify({ userId: 'local', characterId: 'card-a' }),
          source_type: 'dream-pass',
          source_id: 'memory-1',
          status: 'new',
          excitement: 7,
          created_at: 1,
          updated_at: 1,
          content_vector_768: EMBEDDING,
        }]
      : [])
    const repository = createDuckDbMemoryRepository({ execute })

    const idea = await repository.addDreamIdea({
      content: 'Try a smaller build loop',
      scope: { userId: 'local', characterId: 'card-a' },
      sourceType: 'dream-pass',
      sourceId: 'memory-1',
      excitement: 7,
      embedding: EMBEDDING,
      now: 1,
    })

    expect(idea.status).toBe('new')
    expect(idea.scope).toEqual({ userId: 'local', characterId: 'card-a' })
    expect(idea.sourceType).toBe('dream-pass')
    expect(execute.mock.calls.some(([query]) => query.includes('INSERT INTO memory_short_term_ideas'))).toBe(true)
    expect((await repository.listDreamIdeas())[0]?.content).toBe('Try a smaller build loop')
    expect((await repository.listDreamIdeas({ scope: { userId: 'local', characterId: 'card-a' } }))[0]?.scope).toEqual({ userId: 'local', characterId: 'card-a' })
    expect(execute.mock.calls.at(-1)?.[0]).toContain('json_extract_string(scope_json, \'$.characterId\') = \'card-a\'')
  })

  // ROOT CAUSE:
  //
  // Extraction inputs are model-authored JSON. insert() interpolated
  // Math.max(-1, Math.min(1, input.valence)) verbatim, and with a missing or
  // non-finite mood/importance value Math.min(1, undefined) is NaN, so DuckDB
  // received a literal `NaN, NaN` column reference:
  // "Binder Error: Referenced column "NaN" not found in FROM clause!".
  // Every capture whose extraction lacked readable mood numbers died here,
  // which kept the pending-review list permanently empty. Found by the
  // real-machine smoke run. We fixed this by normalizing numerics with
  // numberValue() at the SQL boundary; neutral defaults match what
  // rowToFragment reads back.
  it('defaults non-finite mood and importance values instead of interpolating NaN into SQL', async () => {
    const execute = vi.fn<(query: string) => Promise<unknown[]>>(async (_query: string) => [])
    const repository = createDuckDbMemoryRepository({ execute })

    const fragment = await repository.insert({
      content: 'A fact without readable mood',
      category: 'chat',
      memoryType: 'short_term',
      importance: Number.NaN,
      valence: Number.NaN,
      arousal: Number.NaN,
      tags: [],
      embedding: EMBEDDING,
      now: 1,
    })

    const insertQuery = execute.mock.calls.find(([query]) => query.includes('INSERT INTO memory_fragments'))?.[0]
    expect(insertQuery).toBeDefined()
    expect(insertQuery).not.toContain('NaN')
    expect(fragment.importance).toBe(5)
    expect(fragment.valence).toBe(0)
    expect(fragment.arousal).toBe(0)

    // Same class of producer gap: a missing tags array must not fail the
    // insert after the fragment row is already persisted.
    const withoutTags = await repository.insert({
      content: 'A fact without tags',
      category: 'chat',
      memoryType: 'short_term',
      importance: 5,
      valence: 0,
      arousal: 0,
      embedding: EMBEDDING,
      now: 1,
    } as unknown as Parameters<typeof repository.insert>[0])
    expect(withoutTags.content).toBe('A fact without tags')
  })

  it('keeps character isolation while linked user ids widen retrieval visibility (mq-2)', async () => {
    const rows = [
      memoryRow({ id: 'local-same-char', scope_json: JSON.stringify({ userId: 'local', characterId: 'character-a' }) }),
      memoryRow({ id: 'account-same-char', scope_json: JSON.stringify({ userId: 'account-1', characterId: 'character-a' }) }),
      memoryRow({ id: 'local-other-char', scope_json: JSON.stringify({ userId: 'local', characterId: 'character-b' }) }),
    ]
    const execute = vi.fn<(query: string) => Promise<unknown[]>>(async (_query: string) => rows)
    const repository = createDuckDbMemoryRepository({ execute })
    const scope = { userId: 'account-1', characterId: 'character-a' }

    const linked = await repository.search({ embedding: EMBEDDING, scope, linkedUserIds: ['local'] })
    expect(linked.map(fragment => fragment.id).sort()).toEqual(['account-same-char', 'local-same-char'])

    // Without the link (or for another character) the anonymous history stays out.
    const strict = await repository.search({ embedding: EMBEDDING, scope })
    expect(strict.map(fragment => fragment.id)).toEqual(['account-same-char'])
    const otherCharacter = await repository.search({ embedding: EMBEDDING, scope: { userId: 'account-1', characterId: 'character-b' }, linkedUserIds: ['local'] })
    expect(otherCharacter.map(fragment => fragment.id)).toEqual(['local-other-char'])

    const listed = await repository.list({ scope, linkedUserIds: ['local'] })
    expect(listed.map(fragment => fragment.id).sort()).toEqual(['account-same-char', 'local-same-char'])
  })
})
