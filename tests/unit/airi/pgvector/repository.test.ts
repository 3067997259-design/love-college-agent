// Adapted from AIRI (MIT). Pinned source and modifications: vendor/airi-memory/README.md
// Upstream: packages/memory-pgvector/src/repository.test.ts
import type { SQL } from 'drizzle-orm'

import { PgDialect } from 'drizzle-orm/pg-core'
import { describe, expect, it, vi } from 'vitest'

import { createMemoryRepository } from '../../../../src/main/memory/airi/pgvector/repository'

const EMBEDDING = Array.from(new Uint8Array(768))

function transactional<T extends object>(db: T) {
  const executor = { ...db, execute: vi.fn(async (_sql: SQL) => undefined) }
  return { ...executor, transaction: async <R>(action: (tx: typeof executor) => Promise<R>) => action(executor) }
}

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: '00000000-0000-0000-0000-000000000001',
    content: 'A durable fact',
    memory_type: 'short_term',
    category: 'chat',
    importance: 5,
    emotional_impact: 0,
    valence: 0,
    arousal: 0,
    half_life_hours: 24,
    session_ids: [],
    trigger_pattern: null,
    last_intruded_at: null,
    review_status: 'pending',
    created_at: 1,
    last_accessed: 1,
    access_count: 1,
    metadata: {},
    content_vector_1536: null,
    content_vector_1024: null,
    content_vector_768: EMBEDDING,
    deleted_at: null,
    ...overrides,
  }
}

describe('pgvector memory repository', () => {
  it('persists a tombstone when forget arrives before the first insert', async () => {
    const rows: ReturnType<typeof row>[] = []
    const values = vi.fn(async (value: Record<string, unknown>) => { rows.push(row(value)) })
    const db = transactional({
      select: () => ({ from: () => ({ where: () => ({ limit: async () => rows }) }) }),
      insert: () => ({ values }),
      update: () => ({ set: () => ({ where: async () => undefined }) }),
    })
    const repository = createMemoryRepository(db as never, { nowMs: () => 50 })
    await repository.removeByOriginId('late-origin')
    await repository.removeByOriginId('late-origin')
    await repository.insert({ content: 'Must never return', category: 'chat', memoryType: 'long_term', importance: 5, valence: 0, arousal: 0, tags: [], originId: 'late-origin' })
    expect(values).toHaveBeenCalledTimes(1)
    expect(rows).toEqual([expect.objectContaining({ origin_id: 'late-origin', content: '', deleted_at: 50 })])
    expect(db.execute).toHaveBeenCalledTimes(3)
    const lock = new PgDialect().sqlToQuery(db.execute.mock.calls[0][0])
    expect(lock.sql).toContain('pg_advisory_xact_lock')
    expect(lock.params).toEqual(['late-origin'])
  })

  it('defaults a fresh extraction to pending human review', async () => {
    const values = vi.fn((input: Record<string, unknown>) => ({
      onConflictDoNothing: () => ({ returning: async () => [row(input)] }),
    }))
    const repository = createMemoryRepository(transactional({
      insert: vi.fn(() => ({ values })),
    }) as never)

    const fragment = await repository.insert({
      content: 'A durable fact',
      category: 'chat',
      memoryType: 'short_term',
      importance: 5,
      valence: 0,
      arousal: 0,
      tags: [],
      embedding: EMBEDDING,
      now: 1,
    })

    expect(values).toHaveBeenCalledWith(expect.objectContaining({ review_status: 'pending' }))
    expect(fragment.reviewStatus).toBe('pending')
  })

  it('updates content and its embedding in one database write', async () => {
    const set = vi.fn((patch: Record<string, unknown>) => ({
      where: () => ({ returning: async () => [row({ content: patch.content, content_vector_768: patch.content_vector_768 })] }),
    }))
    const repository = createMemoryRepository(transactional({
      update: vi.fn(() => ({ set })),
    }) as never)

    await repository.update('00000000-0000-0000-0000-000000000001', {
      content: 'Updated fact',
      contentVector: EMBEDDING,
    })

    expect(set).toHaveBeenCalledWith(expect.objectContaining({
      content: 'Updated fact',
      content_vector_768: EMBEDDING,
    }))
  })

  // The conflict target must repeat the partial unique index's predicate
  // (`WHERE origin_id IS NOT NULL AND deleted_at IS NULL`); a bare target
  // makes Postgres reject every insert with 42P10.
  it('repeats the partial index predicate in the insert conflict target', async () => {
    const onConflictDoNothing = vi.fn(() => ({ returning: async () => [row()] }))
    const values = vi.fn(() => ({ onConflictDoNothing }))
    const repository = createMemoryRepository(transactional({
      select: vi.fn(() => ({
        from: () => ({
          where: () => ({
            limit: async () => [],
          }),
        }),
      })),
      insert: vi.fn(() => ({ values })),
    }) as never)

    await repository.insert({
      content: 'A durable fact',
      category: 'chat',
      memoryType: 'short_term',
      importance: 5,
      valence: 0,
      arousal: 0,
      tags: [],
      embedding: EMBEDDING,
      originId: 'origin-1',
      now: 1,
    })

    expect(onConflictDoNothing).toHaveBeenCalledWith({
      target: expect.anything(),
      where: expect.anything(),
    })
  })

  it('returns the tombstone row instead of resurrecting a deleted fact', async () => {
    const insert = vi.fn(() => ({ values: vi.fn() }))
    const repository = createMemoryRepository(transactional({
      select: vi.fn(() => ({
        from: () => ({
          where: () => ({
            limit: async () => [row({ deleted_at: 5 })],
          }),
        }),
      })),
      insert,
    }) as never)

    const fragment = await repository.insert({
      content: 'A durable fact',
      category: 'chat',
      memoryType: 'short_term',
      importance: 5,
      valence: 0,
      arousal: 0,
      tags: [],
      embedding: EMBEDDING,
      originId: 'origin-1',
      now: 1,
    })

    expect(insert).not.toHaveBeenCalled()
    expect(fragment.id).toBe('00000000-0000-0000-0000-000000000001')
  })

  // The local DuckDB store requires approved review status and an active fact
  // status; the mirror must rank with the same gate, or a `pending` row that
  // reached Postgres could steer behavior from the remote side.
  it('gates semantic search to approved active facts like the local store', async () => {
    const where = vi.fn((_condition: SQL) => ({
      orderBy: () => ({
        limit: async () => [],
      }),
    }))
    const repository = createMemoryRepository(transactional({
      select: vi.fn(() => ({
        from: () => ({ where }),
      })),
    }) as never)

    await repository.search({ embedding: EMBEDDING, limit: 3 })

    const { sql, params } = new PgDialect().sqlToQuery(where.mock.calls[0][0])
    expect(sql).toContain('"memory_fragments"."memory_type" <> $1')
    expect(sql).toContain('"memory_fragments"."review_status" is null')
    expect(sql).toContain('"memory_fragments"."review_status" = $2')
    expect(sql).toContain('"memory_fragments"."fact_status" is null')
    expect(sql).toContain('"memory_fragments"."fact_status" = $3')
    expect(params[0]).toBe('muscle')
    expect(params[1]).toBe('approved')
    expect(params[2]).toBe('active')
    // The gate uses the MQ-2 calibrated default, not the old 0.5.
    expect(params[4]).toBe(0.42)
  })

  it('adds both ownership keys to semantic search', async () => {
    const where = vi.fn((_condition: SQL) => ({
      orderBy: () => ({
        limit: async () => [],
      }),
    }))
    const repository = createMemoryRepository(transactional({
      select: vi.fn(() => ({
        from: () => ({ where }),
      })),
    }) as never)

    await repository.search({
      embedding: EMBEDDING,
      scope: { userId: 'user-1', characterId: 'character-a' },
    })

    const { sql, params } = new PgDialect().sqlToQuery(where.mock.calls[0][0])
    expect(sql).toContain('"memory_fragments"."scope"->>\'userId\'')
    expect(sql).toContain('"memory_fragments"."scope"->>\'characterId\'')
    expect(params).toContain('user-1')
    expect(params).toContain('character-a')
  })
})
