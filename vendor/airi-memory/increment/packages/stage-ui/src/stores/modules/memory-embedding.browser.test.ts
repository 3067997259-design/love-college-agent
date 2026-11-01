import { embed } from '@xsai/embed'
import { createPinia, disposePinia, setActivePinia } from 'pinia'
import { expect, it, vi } from 'vitest'

import { useDuckDb } from '../../composables/use-duck-db'
import { createDuckDbMemoryRepository } from '../../services/memory/local-memory'
import { completeRestoreGate } from '../../services/restore-gate'
import { useMemoryStore } from './memory'

// Only the external embedding provider is mocked; database and store are real.
vi.mock('@xsai/embed', () => ({ embed: vi.fn(() => new Promise(() => {})) }))

it('keeps exact fact reads available when optional embedding does not respond', async () => {
  // ROOT CAUSE:
  // A failed embedding worker kept chat waiting forever. Its timeout must
  // degrade vector retrieval without closing the independent fact database.
  const originalUrl = location.href
  const url = new URL(originalUrl)
  url.searchParams.set('synced-leader', 'true')
  history.replaceState(null, '', url)
  localStorage.clear()
  localStorage.setItem('settings/memory/enabled', 'true')
  localStorage.setItem('settings/memory/embedding-source', 'api')
  localStorage.setItem('settings/memory/embedding-base-url', 'https://embedding.invalid/v1/')
  localStorage.setItem('settings/memory/embedding-api-key', 'test-only')
  completeRestoreGate(true)
  const pinia = createPinia()
  setActivePinia(pinia)
  const store = useMemoryStore()
  const scope = { userId: 'local', characterId: 'timeout-test' }
  try {
    await store.setInteractionSettings({ directoryEnabled: true, toolsEnabled: true })
    await store.retrieve('warm up', 'timeout-session', { scope })
    await vi.waitFor(() => expect(store.embeddingMigration.state).toBe('complete'))
    const startedAt = performance.now()
    expect(await store.retrieve('pending request', 'timeout-session', { scope })).toEqual([])
    expect(performance.now() - startedAt).toBeGreaterThanOrEqual(2900)
    expect(store.embeddingError).toContain('3000 ms')
    expect(store.databaseStatus).toBe('ready')
    expect((await store.directory(scope)).entries).toEqual([])
    const context = { scope, sessionId: 'timeout-session', turnId: 'timeout-turn', sourceContext: { sessionId: 'timeout-session', messageId: 'timeout-turn', neighbors: [] }, isCurrent: () => true }
    const operation = await store.proposeOperation(context, 'timeout-remember', { kind: 'remember', content: 'Saved without a vector.' })
    await store.confirmOperation(scope, operation.operationId, true)
    const references = await store.confirmedReferences(scope, context.sessionId)
    const read = await store.readBodies(context, references, [{ id: operation.fragmentId!, offset: 0 }])
    expect(read.results[0]?.content).toBe('Saved without a vector.')
  }
  finally {
    await useDuckDb().closeDb()
    disposePinia(pinia)
    localStorage.clear()
    history.replaceState(null, '', originalUrl)
  }
}, 60_000)

it('bounds a stalled vector migration while keeping the directory available', async () => {
  // ROOT CAUSE:
  // Waiting for first-turn vector readiness without a deadline would restore
  // the original hang when migration reaches an unresponsive provider.
  const originalUrl = location.href
  const url = new URL(originalUrl)
  url.searchParams.set('synced-leader', 'true')
  history.replaceState(null, '', url)
  localStorage.clear()
  localStorage.setItem('settings/memory/enabled', 'true')
  localStorage.setItem('settings/memory/embedding-source', 'api')
  localStorage.setItem('settings/memory/embedding-base-url', 'https://embedding.invalid/v1/')
  localStorage.setItem('settings/memory/embedding-api-key', 'test-only')
  localStorage.setItem('settings/memory/embedding-model', 'pending-init-model')
  completeRestoreGate(true)
  const pinia = createPinia()
  setActivePinia(pinia)
  const store = useMemoryStore()
  const scope = { userId: 'local', characterId: 'pending-initialization' }
  vi.mocked(embed).mockImplementation(() => new Promise(() => {}))
  try {
    const db = useDuckDb()
    await db.getDb()
    const repository = createDuckDbMemoryRepository(db.db.value!, db.transaction)
    const fact = await repository.insert({ content: 'The door code is Bamboo 407.', title: 'Door code', summary: 'Bamboo 407', pinned: true, memoryType: 'long_term', category: 'test', importance: 5, valence: 0, arousal: 0, tags: [], scope, reviewStatus: 'approved', factStatus: 'active' })
    await store.setInteractionSettings({ directoryEnabled: true, toolsEnabled: true })
    expect(await store.retrieve('door code', 'pending-init-session', { scope, recordAccess: false })).toEqual([])
    expect(store.embeddingError).toContain('initialization exceeded 3000 ms')
    expect(store.databaseStatus).toBe('ready')
    expect((await store.directory(scope)).entries.map(item => item.id)).toEqual([fact.id])
  }
  finally {
    await useDuckDb().closeDb()
    disposePinia(pinia)
    vi.mocked(embed).mockReset()
    localStorage.clear()
    history.replaceState(null, '', originalUrl)
  }
}, 60_000)

it('retrieves an unpinned fact on the first interaction turn when vectors are ready', async () => {
  // ROOT CAUSE:
  // The first interaction turn returned [] before vector initialization could
  // inspect persisted vectors. A ready API backend therefore lost unpinned
  // facts even though the original route retrieved them on that same turn.
  const originalUrl = location.href
  const url = new URL(originalUrl)
  url.searchParams.set('synced-leader', 'true')
  history.replaceState(null, '', url)
  localStorage.clear()
  localStorage.setItem('settings/memory/enabled', 'true')
  localStorage.setItem('settings/memory/embedding-source', 'api')
  localStorage.setItem('settings/memory/embedding-base-url', 'https://embedding.invalid/v1/')
  localStorage.setItem('settings/memory/embedding-api-key', 'test-only')
  localStorage.setItem('settings/memory/embedding-model', 'ready-model')
  completeRestoreGate(true)
  const pinia = createPinia()
  setActivePinia(pinia)
  const store = useMemoryStore()
  const scope = { userId: 'local', characterId: 'first-turn-ready' }
  const embedding = Array.from<number>({ length: 768 }).fill(1)
  vi.mocked(embed).mockResolvedValue({ embedding, input: 'archive cabinet', usage: { prompt_tokens: 1, total_tokens: 1 } })
  try {
    const db = useDuckDb()
    await db.getDb()
    const repository = createDuckDbMemoryRepository(db.db.value!, db.transaction)
    const fact = await repository.insert({ content: 'The archive cabinet is Sea Salt 928.', memoryType: 'long_term', category: 'test', importance: 5, valence: 0, arousal: 0, tags: [], scope, reviewStatus: 'approved', factStatus: 'active', embedding, embeddingMetadata: { embeddingProvider: 'openai-compatible', embeddingModel: 'ready-model', embeddingDimensions: 768, embeddingInputType: 'document', embeddingSourceFingerprint: 'api:https://embedding.invalid/v1/:ready-model', embeddedAt: Date.now(), embeddingStatus: 'active' } })
    await store.setInteractionSettings({ directoryEnabled: true, toolsEnabled: true })
    expect((await store.directory(scope)).entries).toEqual([])
    const result = await store.retrieve('archive cabinet', 'first-turn-session', { scope, recordAccess: false })
    expect(result.map(item => item.id)).toEqual([fact.id])
  }
  finally {
    await useDuckDb().closeDb()
    disposePinia(pinia)
    vi.mocked(embed).mockReset()
    localStorage.clear()
    history.replaceState(null, '', originalUrl)
  }
}, 60_000)
