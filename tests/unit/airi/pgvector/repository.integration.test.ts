// Adapted from AIRI (MIT). Pinned source and modifications: vendor/airi-memory/README.md
// Upstream: packages/memory-pgvector/src/repository.integration.test.ts
import { describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import postgres from 'postgres'

import { connectMemoryRepository, ensureMemorySchema } from '../../../../src/main/memory/airi/pgvector/repository'

// Run through scripts/continuity-postgres-gate.mjs against its private Docker DB.
// The explicit test opt-in never consumes an ambient daily DATABASE_URL.
const connectionString = process.env.LCA_MEMORY_TEST_POSTGRES === '1' ? process.env.LCA_MEMORY_TEST_DATABASE_URL?.trim() : undefined
const vector = (seed: number) => Array.from({ length: 768 }, (_, i) => Math.sin(seed + i / 50) * 0.5)

describe.skipIf(!connectionString)('memory repository (real Postgres)', () => {
  it('shares vector types across private namespaces without sharing facts', { timeout: 60_000 }, async () => {
    const namespaces = Array.from({ length: 2 }, () => `lca_memory_${randomUUID().replaceAll('-', '')}`)
    await Promise.all(namespaces.map(namespace => ensureMemorySchema(connectionString!, namespace)))
    const connections = namespaces.map(namespace => connectMemoryRepository(connectionString!, undefined, namespace))
    try {
      for (const [i, { repository }] of connections.entries()) {
        await repository.insert({ originId: 'same-origin', content: `Owner ${i}`, category: 'chat', memoryType: 'long_term', importance: 5, valence: 0, arousal: 0, tags: [], reviewStatus: 'approved', embedding: vector(i + 1) })
      }
      for (const [i, { repository }] of connections.entries()) {
        expect((await repository.list({ limit: 10 })).map(fact => fact.content)).toEqual([`Owner ${i}`])
        expect((await repository.search({ embedding: vector(i + 1), limit: 10 })).map(fact => fact.content)).toEqual([`Owner ${i}`])
      }
    } finally { await Promise.all(connections.map(connection => connection.close())) }
  })

  it('repairs a legacy private vector extension while preserving existing rows and isolation', { timeout: 60_000 }, async () => {
    const legacy = `lca_memory_${randomUUID().replaceAll('-', '')}`, next = `lca_memory_${randomUUID().replaceAll('-', '')}`
    await ensureMemorySchema(connectionString!, legacy)
    const first = connectMemoryRepository(connectionString!, undefined, legacy)
    const sql = postgres(connectionString!)
    let second: ReturnType<typeof connectMemoryRepository> | undefined
    try {
      const original = await first.repository.insert({ originId: 'legacy', content: 'Preserved legacy fact', category: 'chat', memoryType: 'long_term', importance: 5, valence: 0, arousal: 0, tags: [], reviewStatus: 'approved', embedding: vector(4) })
      await sql.unsafe(`ALTER EXTENSION vector SET SCHEMA "${legacy}"`)
      await ensureMemorySchema(connectionString!, next)
      second = connectMemoryRepository(connectionString!, undefined, next)
      expect(await second.repository.list({ limit: 10 })).toEqual([])
      expect((await first.repository.search({ embedding: vector(4), limit: 10 })).map(fact => fact.id)).toEqual([original.id])
      const [extension] = await sql`SELECT n.nspname FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace WHERE e.extname = 'vector'`
      expect(extension.nspname).toBe('public')
    } finally { await first.close(); await second?.close(); await sql.end() }
  })

  it('keeps an absent or concurrently arriving origin forgotten across two connections', { timeout: 60_000 }, async () => {
    const namespace = `lca_memory_${randomUUID().replaceAll('-', '')}`
    await ensureMemorySchema(connectionString!, namespace)
    const first = connectMemoryRepository(connectionString!, undefined, namespace)
    const second = connectMemoryRepository(connectionString!, undefined, namespace)
    const input = (originId: string) => ({ originId, content: 'Forgotten before delivery', category: 'chat', memoryType: 'long_term' as const, importance: 5, valence: 0, arousal: 0, tags: [], embedding: vector(7) })
    try {
      await first.repository.removeByOriginId('absent')
      await second.repository.insert(input('absent'))
      await Promise.all([first.repository.removeByOriginId('racing'), second.repository.insert(input('racing'))])
      await second.repository.insert(input('racing'))
      expect(await first.repository.list({ limit: 100 })).toEqual([])
    } finally { await first.close(); await second.close() }
  })

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
