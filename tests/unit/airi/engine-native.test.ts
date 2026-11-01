import { mkdtempSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { createManualClock } from '../../../src/main/clock'
import { createMemoryEngine } from '../../../src/main/memory/engine'
import { createMemoryDatabaseClient } from '../../../src/main/memory/storage/client'
import { createNativeMemoryDatabase } from '../../../src/main/memory/storage/neo'
import { createMemoryCommitCoordinator, initializeMemoryCommitSchema } from '../../../src/main/memory/storage/commits'
import { createMemoryRuntimeState } from '../../../src/main/memory/storage/state'
import { createMemorySnapshots } from '../../../src/main/memory/storage/snapshots'
import type { MemoryHostPort } from '../../../src/main/memory/airi/runtime'
import type { MemoryEmbeddingSource } from '../../../src/main/memory/airi/embedding'

const owner = { userId: 'test-user', characterId: 'taozi', dataRootId: 'isolated-root' }
const scope = { userId: owner.userId, characterId: owner.characterId }
const vector = Array.from({ length: 768 }, (_, i) => i === 0 ? 1 : 0)
const source: MemoryEmbeddingSource = { provider: 'fixture', model: 'synthetic', fingerprint: 'fixture-native', embed: async () => vector }
const context = { scope, sessionId: 'day-1', turnId: 'turn-1', sourceContext: { sessionId: 'day-1', messageId: 'original-1', neighbors: [] }, isCurrent: () => true }
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done }); return { promise, resolve } }
const setup = () => {
  const root = mkdtempSync(join(resolve('test-results'), 'memory-engine-'))
  const clock = createManualClock(1_790_000_000_000)
  const openDatabase = async (path: string) => { const db = createMemoryDatabaseClient(createNativeMemoryDatabase(), clock); await db.open(path); return db }
  const create = (embedding: MemoryEmbeddingSource | null = source, mirror?: MemoryHostPort) => createMemoryEngine({ root, clock, owner, embedding: () => embedding ?? undefined,
    held: () => false, waitForRestore: async () => {}, journal: () => {}, openDatabase, mirror })
  return { root, clock, openDatabase, create }
}

describe('owning memory engine', () => {
  it('exports the frozen owner as complete Parquet/state/log entries and rejects cross-owner imports atomically', async () => {
    const env = setup(); let held = false
    const engine = createMemoryEngine({ root: env.root, clock: env.clock, owner, embedding: () => undefined, held: () => held, waitForRestore: async () => {}, journal: () => {}, openDatabase: env.openDatabase })
    try {
      await engine.runtime.proposeOperation(context, 'archive-owned', { kind: 'remember', content: 'Archive fact' })
      await engine.runtime.confirmOperation(scope, 'archive-owned', true)
      await expect(engine.archive()).rejects.toThrow('FREEZE_REQUIRED')
      held = true
      await expect(engine.archive(['Archive fact'])).rejects.toThrow('CREDENTIAL_FORBIDDEN')
      const archive = await engine.archive()
      expect(archive.count).toBe(1); expect(archive.entries).toHaveLength(12)
      const snapshot = archive.entries.filter(entry => entry.path.endsWith('.parquet') || entry.path === 'memory/schema.json')
      const target = await env.openDatabase(join(env.root, 'wrong-owner.duckdb'))
      try {
        await initializeMemoryCommitSchema(target)
        await expect(createMemorySnapshots(target, env.root, true, { ...scope, userId: 'other-user' }).importSnapshot(snapshot)).rejects.toThrow('SCOPE_MISMATCH')
        expect((await target.execute('SELECT count(*) AS count FROM memory_fragments') as { count: bigint }[]).map(row => Number(row.count))).toEqual([0])
        await createMemorySnapshots(target, env.root, true, scope).importSnapshot(snapshot)
        expect((await target.execute('SELECT count(*) AS count FROM memory_fragments') as { count: bigint }[]).map(row => Number(row.count))).toEqual([1])
      } finally { await target.close() }
    } finally { await engine.dispose() }
  })

  it('recovers the database-to-outbox gap and forgotten facts after reopening', async () => {
    const env = setup()
    const db = await env.openDatabase(join(env.root, 'memory.duckdb'))
    const commits = await createMemoryCommitCoordinator({ database: db, clock: env.clock, scope, logPath: join(env.root, 'operations.log') })
    const fact = await commits.repository.insert({ content: 'Tea', memoryType: 'long_term', category: 'chat', importance: 5, valence: 0, arousal: 0, tags: [], scope,
      reviewStatus: 'approved', pinned: true, sourceContext: context.sourceContext })
    await db.close() // State-file outbox was never created.
    const insert = vi.fn(async () => ({ id: 'remote', originId: fact.id }))
    const remove = vi.fn(async () => ({}))
    const update = vi.fn(async () => ({}))
    const mirror: MemoryHostPort = { configure: async () => ({ status: 'ready' }), getStatus: async () => ({ status: 'ready' }), list: async () => [], search: async () => [], insert, remove, update }
    let engine = env.create(source, mirror)
    try {
      engine.runtime.longTermSyncEnabled.value = true
      await engine.runtime.initialize()
      await engine.runtime.refreshRemoteHostStatus()
      expect(insert).toHaveBeenCalledTimes(1)
      expect(update).toHaveBeenCalledWith(expect.objectContaining({ originId: fact.id, patch: expect.objectContaining({ content: 'Tea' }) }))
      expect(engine.runtime.longTermSyncOutbox.value).toHaveLength(0)
      const proposal = await engine.runtime.proposeOperation(context, 'forget', { kind: 'forget', targetId: fact.id, expectedRevision: fact.revision })
      await engine.runtime.confirmOperation(scope, proposal.operationId, true)
      await engine.dispose()
      engine = env.create(source, mirror)
      await engine.runtime.initialize()
      expect((await engine.runtime.directory(scope)).entries).toEqual([])
      await engine.runtime.refreshRemoteHostStatus()
      expect(remove).toHaveBeenCalledWith({ originId: fact.id })
      expect(engine.runtime.longTermSyncOutbox.value).toHaveLength(0)
      expect((await engine.runtime.operationStatus('forget', scope))?.status).toBe('applied')
      expect(readFileSync(join(env.root, 'operations.log'), 'utf8')).not.toContain('Tea')
    } finally { await engine.dispose() }
  })

  it('keeps exact fact reads available while an optional embedding request is stalled (AIRI V3)', async () => {
    const env = setup()
    const started = deferred<void>()
    const pending = deferred<number[]>()
    const engine = env.create({ ...source, embed: () => { started.resolve(); return pending.promise } })
    try {
      const retrieval = engine.runtime.retrieve('What do I like?', 'day-1', { scope })
      await started.promise
      env.clock.advanceBy(3000)
      expect(await retrieval).toEqual([])
      expect(engine.runtime.databaseStatus.value).toBe('ready')
      const operation = await engine.runtime.proposeOperation(context, 'timeout-remember', { kind: 'remember', content: 'Stored without vectors.' })
      await engine.runtime.confirmOperation(scope, operation.operationId, true)
      const references = await engine.runtime.confirmedReferences(scope, 'day-1')
      expect((await engine.runtime.readBodies(context, references, [{ id: operation.fragmentId!, offset: 0 }])).results[0]?.content).toBe('Stored without vectors.')
    } finally { pending.resolve(vector); await engine.dispose() }
  })

  it('restored settings and fact health survive missing vector configuration and repeated readers (AIRI V3)', async () => {
    const env = setup()
    const settings = createMemoryRuntimeState(join(env.root, 'runtime.json'))
    settings.cell('settings/memory/directory-enabled', true).value = true
    settings.cell('settings/memory/tools-enabled', true).value = true
    const engine = env.create(null)
    try {
      await Promise.all([engine.runtime.initialize(), engine.runtime.directory(scope), engine.runtime.directory(scope)])
      expect(engine.runtime.databaseStatus.value).toBe('ready')
      expect(engine.runtime.toolsEnabled.value).toBe(true)
      expect(engine.runtime.directoryEnabled.value).toBe(true)
      settings.reload()
      expect(settings.cell('settings/memory/tools-enabled', false).value).toBe(true)
      const operation = await engine.runtime.proposeOperation(context, 'restored', { kind: 'remember', content: 'Restored ownership' })
      expect(operation.status).toBe('pending_review')
    } finally { await engine.dispose() }
  })

  it('round-trips nonempty version 3 receipts and mirror intents into an empty database', async () => {
    const env = setup()
    const engine = env.create()
    const operation = await engine.runtime.proposeOperation(context, 'roundtrip', { kind: 'remember', content: 'Durable tea' })
    await engine.runtime.confirmOperation(scope, 'roundtrip', true)
    await engine.dispose()
    const original = await env.openDatabase(join(env.root, 'memory.duckdb'))
    let entries
    try { entries = await createMemorySnapshots(original, env.root, true).exportSnapshot() } finally { await original.close() }
    const target = await env.openDatabase(join(env.root, 'restored.duckdb'))
    try {
      const coordinator = await createMemoryCommitCoordinator({ database: target, clock: env.clock, scope, logPath: join(env.root, 'restored.log') })
      await createMemorySnapshots(target, env.root, true).importSnapshot(entries)
      expect((await coordinator.repository.operation('roundtrip'))?.fragmentId).toBe(operation.fragmentId)
      expect((await coordinator.receipt('review:roundtrip')).state).toBe('published')
      await expect(createMemorySnapshots(target, env.root, true).importSnapshot(entries)).rejects.toThrow('empty profile')
    } finally { await target.close() }
  })
})
