import { describe, expect, it } from 'vitest'

import { connectMemoryRepository, ensureMemorySchema } from './repository'

// Integration walkthrough against a real Postgres (pgvector) database.
// Skips unless DATABASE_URL points at a reachable server — the local
// workflow is `docker compose -f server/docker-compose.yaml up -d db` with
// the credentials from that compose file, then:
//   DATABASE_URL=postgresql://... pnpm -F @proj-airi/memory-pgvector exec vitest run src/repository.integration.test.ts
const connectionString = process.env.DATABASE_URL?.trim()
const vector = (seed: number) => Array.from({ length: 768 }, (_, i) => Math.sin(seed + i / 50) * 0.5)

describe.skipIf(!connectionString)('memory repository (real Postgres)', () => {
  it('ensures the schema, then inserts, searches, lists, and removes a fragment', { timeout: 60_000 }, async () => {
    await ensureMemorySchema(connectionString!)
    const { repository, close } = connectMemoryRepository(connectionString!)

    try {
      const inserted = await repository.insert({
        content: 'pgvector integration walkthrough fragment',
        memoryType: 'short_term',
        category: 'chat',
        importance: 5,
        valence: 0,
        arousal: 0.1,
        halfLifeHours: 24,
        reviewStatus: 'approved',
        tags: [],
        embedding: vector(1),
        now: Date.now(),
      })
      expect(inserted.id).toBeTruthy()
      expect(inserted.reviewStatus).toBe('approved')

      const scored = await repository.search({ embedding: vector(1), limit: 3 })
      const hit = scored.find(fragment => fragment.id === inserted.id)
      expect(hit, 'inserted fragment should be returned by vector search').toBeDefined()

      const listed = await repository.list({ memoryType: 'short_term', limit: 100 })
      expect(listed.some(fragment => fragment.id === inserted.id)).toBe(true)

      await repository.remove(inserted.id)
      const afterRemoval = await repository.list({ memoryType: 'short_term', limit: 100 })
      expect(afterRemoval.some(fragment => fragment.id === inserted.id)).toBe(false)
    }
    finally {
      await close()
    }
  })

  // ROOT CAUSE:
  //
  // The only unique index on origin_id is partial
  // (`WHERE origin_id IS NOT NULL AND deleted_at IS NULL`), but the insert used
  // a bare `ON CONFLICT (origin_id)`. Postgres cannot infer a partial unique
  // index from an unpredicated conflict target, so every insert through the
  // repository failed with 42P10 against a real server — invisible to the
  // mock-based unit tests and to the DATABASE_URL-gated walkthrough above.
  it('redelivers the same originId idempotently and inserts without an originId', { timeout: 60_000 }, async () => {
    await ensureMemorySchema(connectionString!)
    const { repository, close } = connectMemoryRepository(connectionString!)
    const mirrorInput = (overrides: Record<string, unknown>) => ({
      content: 'mirrored long-term fact',
      memoryType: 'long_term' as const,
      category: 'chat' as const,
      importance: 5,
      valence: 0,
      arousal: 0,
      halfLifeHours: 4320,
      reviewStatus: 'approved' as const,
      tags: [] as string[],
      embedding: vector(2),
      now: Date.now(),
      ...overrides,
    })

    try {
      const originId = `integration-origin-${Date.now()}`
      const first = await repository.insert(mirrorInput({ originId }))
      const redelivered = await repository.insert(mirrorInput({ originId }))
      expect(redelivered.id).toBe(first.id)

      const listed = await repository.list({ memoryType: 'long_term', limit: 1000 })
      expect(listed.filter(fragment => fragment.originId === originId)).toHaveLength(1)

      const plain = await repository.insert({
        content: 'fact without a stable local id',
        memoryType: 'short_term' as const,
        category: 'chat',
        importance: 5,
        valence: 0,
        arousal: 0,
        tags: [] as string[],
        embedding: vector(3),
        now: Date.now(),
      })
      expect(plain.id).toBeTruthy()
      await repository.remove(plain.id)
    }
    finally {
      await close()
    }
  })

  it('keeps a deleted fact deleted when its originId is redelivered', { timeout: 60_000 }, async () => {
    await ensureMemorySchema(connectionString!)
    const { repository, close } = connectMemoryRepository(connectionString!)
    const mirrorInput = (overrides: Record<string, unknown>) => ({
      content: 'fact that will be deleted remotely',
      memoryType: 'long_term' as const,
      category: 'chat' as const,
      importance: 5,
      valence: 0,
      arousal: 0,
      halfLifeHours: 4320,
      reviewStatus: 'approved' as const,
      tags: [] as string[],
      embedding: vector(4),
      now: Date.now(),
      ...overrides,
    })

    try {
      const originId = `integration-tombstone-${Date.now()}`
      const inserted = await repository.insert(mirrorInput({ originId }))
      await repository.remove(inserted.id)

      // The partial unique index excludes soft-deleted rows, so without the
      // tombstone guard this redelivery would insert a fresh live row.
      const redelivered = await repository.insert(mirrorInput({ originId }))
      expect(redelivered.id).toBe(inserted.id)

      const listed = await repository.list({ memoryType: 'long_term', limit: 1000 })
      expect(listed.filter(fragment => fragment.originId === originId)).toHaveLength(0)
    }
    finally {
      await close()
    }
  })

  it('propagates review, supersede, and delete updates by originId', { timeout: 60_000 }, async () => {
    await ensureMemorySchema(connectionString!)
    const { repository, close } = connectMemoryRepository(connectionString!)
    const mirrorInput = (overrides: Record<string, unknown>) => ({
      content: 'fact that will be superseded remotely',
      memoryType: 'long_term' as const,
      category: 'chat' as const,
      importance: 5,
      valence: 0,
      arousal: 0,
      halfLifeHours: 4320,
      reviewStatus: 'approved' as const,
      tags: [] as string[],
      embedding: vector(5),
      now: Date.now(),
      ...overrides,
    })

    try {
      const originId = `integration-propagate-${Date.now()}`
      await repository.insert(mirrorInput({ originId }))

      const rejected = await repository.updateByOriginId(originId, { reviewStatus: 'rejected' })
      expect(rejected?.reviewStatus).toBe('rejected')

      const superseded = await repository.updateByOriginId(originId, { factStatus: 'superseded' })
      expect(superseded?.factStatus).toBe('superseded')

      // Superseded/disputed facts must leave retrieval entirely.
      const searched = await repository.search({ embedding: vector(5), limit: 100 })
      expect(searched.some(fragment => fragment.originId === originId)).toBe(false)

      await repository.removeByOriginId(originId)
      const listed = await repository.list({ memoryType: 'long_term', limit: 1000 })
      expect(listed.filter(fragment => fragment.originId === originId)).toHaveLength(0)

      // A redelivered insert after the tombstone must not resurrect the fact.
      await repository.insert(mirrorInput({ originId }))
      const afterRedelivery = await repository.list({ memoryType: 'long_term', limit: 1000 })
      expect(afterRedelivery.filter(fragment => fragment.originId === originId)).toHaveLength(0)
    }
    finally {
      await close()
    }
  })
})
