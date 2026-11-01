import { mkdtempSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { createManualClock } from '../../../src/main/clock'
import { createAiriMemoryRuntime, type MemoryHostPort } from '../../../src/main/memory/airi/runtime'
import { createMemoryEmbeddingRuntime, type MemoryEmbeddingSource } from '../../../src/main/memory/airi/embedding'
import { createNativeMemoryDatabase } from '../../../src/main/memory/storage/neo'
import { createMemoryDatabaseClient } from '../../../src/main/memory/storage/client'
import { createMemoryRuntimeState } from '../../../src/main/memory/storage/state'

describe('extracted AIRI runtime with persistent native storage', () => {
  it('remembers, recalls, promotes, corrects and preserves failed mirror work across restart', async () => {
    const root = mkdtempSync(join(resolve('test-results'), 'memory-runtime-'))
    const clock = createManualClock(1_790_000_000_000)
    const scope = { userId: 'owner-root-1', characterId: 'taozi' }
    const context = { scope, sessionId: 'day-1', turnId: 'turn-1', sourceContext: { sessionId: 'day-1', messageId: 'original-1', neighbors: [] }, isCurrent: () => true }
    const embeddingCalls: string[] = []
    let source: MemoryEmbeddingSource | undefined = { provider: 'fixture', model: 'synthetic', fingerprint: 'fixture-a', embed: async text => {
      embeddingCalls.push(text)
      return Array.from({ length: 768 }, (_, i) => i === 0 ? 1 : 0)
    } }
    const insert = vi.fn(async () => { throw new Error('OFFLINE_FIXTURE') })
    const mirror: MemoryHostPort = { configure: async () => ({ status: 'ready' }), getStatus: async () => ({ status: 'ready' }),
      list: async () => [], search: async () => [], insert, update: vi.fn(async () => ({})), remove: vi.fn(async () => ({})) }
    let opens = 0
    const create = () => createAiriMemoryRuntime({ clock, scope: () => scope, isOwner: () => true, effectsHeld: () => false, waitForRestore: async () => {},
      state: createMemoryRuntimeState(join(root, 'state.json')), embedding: createMemoryEmbeddingRuntime(clock, () => source), mirror, journal: () => {},
      openDatabase: async () => { opens++; const db = createMemoryDatabaseClient(createNativeMemoryDatabase(), clock); await db.open(join(root, 'memory.duckdb')); return db },
    })
    let runtime = create()
    try {
      await Promise.all([runtime.directory(scope), runtime.list()])
      expect(opens).toBe(1)
      const operation = await runtime.proposeOperation(context, 'remember', { kind: 'remember', content: 'I prefer tea.', title: 'Drink', summary: 'Tea' })
      await runtime.confirmOperation(scope, 'remember', true)
      const fact = (await runtime.list()).find(item => item.id === operation.fragmentId)!
      await runtime.editPresentation(scope, { id: fact.id, expectedRevision: fact.revision!, title: 'Drink', summary: 'Tea', pinned: true, pinOrder: 0 })
      runtime.longTermSyncEnabled.value = true
      expect((await runtime.retrieve('What is my preference?', 'day-1', { scope }))[0]?.id).toBe(fact.id)
      expect((await runtime.retrieve('What drink do I like?', 'day-2', { scope }))[0]?.id).toBe(fact.id)
      expect((await runtime.list()).find(item => item.id === fact.id)?.memoryType).toBe('long_term')
      expect(embeddingCalls).toContain('I prefer tea.')
      expect(insert).toHaveBeenCalledTimes(1)
      expect(runtime.longTermSyncOutbox.value[0]?.attempts).toBe(1)
      const current = (await runtime.list()).find(item => item.id === fact.id)!
      const correction = await runtime.proposeOperation({ ...context, turnId: 'turn-2' }, 'correct', {
        kind: 'correct', targetId: current.id, expectedRevision: current.revision, content: 'I now prefer coffee.', title: 'Drink', summary: 'Coffee',
      })
      await runtime.confirmOperation(scope, 'correct', true)
      expect((await runtime.directory(scope)).entries.map(item => item.id)).toEqual([correction.fragmentId])
      expect((await runtime.retrieve('What do I like now?', 'day-3', { scope }))[0]?.id).toBe(correction.fragmentId)
      await runtime.dispose()
      source = undefined
      runtime = create()
      expect((await runtime.directory(scope)).entries.map(item => item.id)).toEqual([correction.fragmentId])
      expect(runtime.longTermSyncOutbox.value.length).toBeGreaterThan(0)
      expect(await runtime.retrieve('preference', 'day-4', { scope })).toEqual([])
      expect(runtime.databaseStatus.value).toBe('ready')
      expect((await runtime.operationStatus('correct', scope))?.status).toBe('applied')
    } finally { await runtime.dispose() }
  }, 60_000)
})
