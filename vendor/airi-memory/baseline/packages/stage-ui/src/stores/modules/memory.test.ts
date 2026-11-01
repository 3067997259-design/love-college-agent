// @vitest-environment jsdom

import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { completeRestoreGate } from '../../services/restore-gate'
import { useJournalStore } from '../journal'
import { installMemoryDreamAgent, installMemoryHostPort, MEMORY_BROWSER_SESSION_ID, useMemoryStore } from './memory'

const dreamScope = { userId: 'local', characterId: 'default' }

const repository = vi.hoisted(() => ({
  addDreamIdea: vi.fn(),
  insert: vi.fn(),
  list: vi.fn(),
  listDreamIdeas: vi.fn(),
  promoteEligible: vi.fn(),
  recordAccess: vi.fn(),
  remove: vi.fn(),
  search: vi.fn(),
  update: vi.fn(),
  updateDreamIdea: vi.fn(),
}))

const database = vi.hoisted(() => ({
  db: { value: {} },
  getDb: vi.fn(async () => undefined),
}))

const embedMemoryText = vi.hoisted(() => vi.fn(async (_text: string, _inputType?: 'query' | 'document') => Array.from({ length: 768 }).fill(0)))
const activeMemoryEmbeddingMetadata = vi.hoisted(() => vi.fn((input: { kind: 'query' | 'document', dimensions: number }) => ({
  embeddingProvider: 'test',
  embeddingModel: 'test-model',
  embeddingDimensions: input.dimensions,
  embeddingInputType: input.kind,
  embeddingSourceFingerprint: 'test-vector-space',
  embeddedAt: 1,
  embeddingStatus: 'active',
})))
const installMemoryEmbeddingSource = vi.hoisted(() => vi.fn())
const activeMemoryEmbeddingFingerprint = vi.hoisted(() => vi.fn(() => 'test-vector-space'))
const activeMemoryEmbeddingUsage = vi.hoisted(() => vi.fn(() => undefined as { promptTokens: number, totalTokens: number } | undefined))
const createApiMemoryEmbeddingSource = vi.hoisted(() => vi.fn((input: { baseUrl: string, apiKey: string, model: string }) => ({
  fingerprint: `api:${input.baseUrl}:${input.model}:768`,
  embed: embedMemoryText,
})))

const memoryHost = vi.hoisted(() => ({
  configure: vi.fn(),
  getStatus: vi.fn(),
  list: vi.fn(),
  search: vi.fn(),
  insert: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
}))

vi.mock('../../composables/use-duck-db', () => ({
  useDuckDb: () => database,
}))

vi.mock('../../services/memory/local-memory', () => ({
  createDuckDbMemoryRepository: () => repository,
}))

vi.mock('../../services/memory/local-memory-embedding', () => ({
  embedMemoryText,
  activeMemoryEmbeddingMetadata,
  installMemoryEmbeddingSource,
  activeMemoryEmbeddingFingerprint,
  activeMemoryEmbeddingUsage,
  createApiMemoryEmbeddingSource,
  MEMORY_EMBEDDING_DIMENSIONS: 768,
}))

beforeEach(() => {
  completeRestoreGate()
  localStorage.clear()
  setActivePinia(createPinia())
  vi.stubGlobal('location', new URL('http://localhost/?synced-leader=true'))
  repository.addDreamIdea.mockReset()
  repository.insert.mockReset()
  repository.list.mockReset()
  repository.listDreamIdeas.mockReset()
  repository.promoteEligible.mockReset()
  repository.recordAccess.mockReset()
  repository.search.mockReset()
  repository.update.mockReset()
  repository.updateDreamIdea.mockReset()
  embedMemoryText.mockClear()
  activeMemoryEmbeddingUsage.mockReset()
  activeMemoryEmbeddingUsage.mockReturnValue(undefined)
  installMemoryEmbeddingSource.mockClear()
  activeMemoryEmbeddingFingerprint.mockReturnValue('test-vector-space')
  database.getDb.mockClear()
  memoryHost.getStatus.mockReset()
  memoryHost.insert.mockReset()
  memoryHost.update.mockReset()
  memoryHost.remove.mockReset()
  repository.promoteEligible.mockResolvedValue([])
  repository.recordAccess.mockResolvedValue(undefined)
  repository.updateDreamIdea.mockResolvedValue(undefined)
  repository.update.mockImplementation(async (id: string, patch: Record<string, unknown>) => ({ id, ...patch }))
  repository.insert.mockImplementation(async (input: { content: string }) => ({ id: input.content, content: input.content }))
  repository.list.mockResolvedValue([])
  repository.addDreamIdea.mockImplementation(async (input: { content: string }) => ({ id: input.content }))
  repository.listDreamIdeas.mockResolvedValue([])
  embedMemoryText.mockReset()
  embedMemoryText.mockImplementation(async () => Array.from({ length: 768 }).fill(0))
  installMemoryDreamAgent(undefined)
  installMemoryHostPort(undefined)
  memoryHost.getStatus.mockResolvedValue({ status: 'ready' })
  memoryHost.insert.mockResolvedValue({ id: 'remote-1' })
  memoryHost.update.mockResolvedValue({ id: 'remote-1' })
  memoryHost.remove.mockResolvedValue({ removed: true })
})

describe('memory store', () => {
  it('retains restored delivery records after initialization and explicit retry', async () => {
    // ROOT CAUSE:
    // Completing import released the same gate used by remote delivery, so
    // reconnect and retry could replay restored operations automatically.
    completeRestoreGate(true)
    localStorage.setItem('settings/memory/long-term-sync-enabled', 'true')
    installMemoryHostPort(memoryHost)
    const store = useMemoryStore()
    const item = { kind: 'delete' as const, originId: 'restored-fact', attempts: 0, nextAttemptAt: 123, createdAt: 1 }
    store.longTermSyncOutbox = [item]
    await store.initialize()
    await store.retryLongTermSync()
    expect(memoryHost.remove).not.toHaveBeenCalled()
    expect(store.longTermSyncOutbox).toEqual([item])
  })

  it('does not synthesize template ideas without a dream agent', async () => {
    localStorage.setItem('settings/memory/enabled', 'true')
    localStorage.setItem('settings/memory/dreaming-enabled', 'true')
    repository.list.mockResolvedValue([{ id: 'memory-1', content: 'A fact', memoryType: 'short_term', importance: 8, reviewStatus: 'approved' }])

    await useMemoryStore().dream(dreamScope)

    expect(repository.addDreamIdea).not.toHaveBeenCalled()
  })

  it('uses only reviewed factual fragments as dreaming inputs', async () => {
    localStorage.setItem('settings/memory/enabled', 'true')
    localStorage.setItem('settings/memory/dreaming-enabled', 'true')
    repository.list.mockResolvedValue([
      { id: 'approved', content: 'Approved fact', memoryType: 'short_term', importance: 8, reviewStatus: 'approved', scope: dreamScope },
      { id: 'pending', content: 'Pending fact', memoryType: 'short_term', importance: 8, reviewStatus: 'pending' },
      { id: 'rejected', content: 'Rejected fact', memoryType: 'long_term', importance: 8, reviewStatus: 'rejected' },
      { id: 'muscle', content: 'Muscle procedure', memoryType: 'muscle', importance: 8, reviewStatus: 'approved' },
      { id: 'legacy', content: 'Legacy fact', memoryType: 'long_term', importance: 8 },
      { id: 'other', content: 'Other character fact', memoryType: 'long_term', importance: 8, reviewStatus: 'approved', scope: { userId: 'local', characterId: 'other' } },
    ])
    installMemoryDreamAgent(async ({ fragments }) => fragments.map(fragment => ({
      content: `Follow up on ${fragment.content}`,
      sourceId: fragment.id,
      excitement: fragment.importance,
    })))

    await useMemoryStore().dream(dreamScope)

    expect(repository.list).toHaveBeenCalledWith({ limit: 1_000, scope: dreamScope })
    expect(repository.addDreamIdea).toHaveBeenCalledTimes(1)
    expect(repository.addDreamIdea.mock.calls.map(([input]) => input.sourceId)).toEqual(['approved'])
    expect(repository.addDreamIdea).toHaveBeenCalledWith(expect.objectContaining({ scope: dreamScope }))
  })

  it('checks promotion after recording retrieval access', async () => {
    localStorage.setItem('settings/memory/enabled', 'true')
    repository.search.mockResolvedValue([{
      id: 'memory-1',
      content: 'A remembered fact',
      memoryType: 'short_term',
      category: 'life',
      importance: 7,
      emotionalImpact: 0,
      createdAt: 1,
      lastAccessed: 1,
      accessCount: 2,
      valence: 0,
      arousal: 0.2,
      halfLifeHours: 24,
      sessionIds: ['session-old'],
      similarity: 0.9,
      timeRelevance: 1,
      moodCongruence: 0,
      score: 1,
    }])
    repository.list.mockResolvedValue([])

    const results = await useMemoryStore().retrieve('remembered fact', 'session-new', { scope: { userId: 'local', characterId: 'default' } })

    expect(results).toHaveLength(1)
    expect(repository.recordAccess).toHaveBeenCalledWith({ memoryIds: ['memory-1'], sessionId: 'session-new' })
    expect(repository.promoteEligible).toHaveBeenCalledTimes(1)
    expect(repository.recordAccess.mock.invocationCallOrder[0]).toBeLessThan(repository.promoteEligible.mock.invocationCallOrder[0])
  })

  it('merges original and normalized query candidates by maximum similarity', async () => {
    localStorage.setItem('settings/memory/enabled', 'true')
    repository.list.mockResolvedValue([])
    const fact = {
      id: 'memory-1',
      content: '先检查测试再修改接口',
      memoryType: 'short_term' as const,
      category: 'life',
      importance: 7,
      emotionalImpact: 0,
      createdAt: 1,
      lastAccessed: 1,
      accessCount: 1,
      valence: 0,
      arousal: 0,
      halfLifeHours: 24,
      sessionIds: [],
      timeRelevance: 1,
      moodCongruence: 0,
    }
    repository.search.mockImplementation(async ({ embedding }: { embedding: number[] }) => [{
      ...fact,
      similarity: embedding[0] === 1 ? 0.4 : 0.8,
      score: embedding[0] === 1 ? 0.4 : 0.8,
    }])
    embedMemoryText.mockImplementation(async (text: string) => text.startsWith('我想') ? [1, 0] : [0, 1])

    const results = await useMemoryStore().retrieve('我想在修改接口之前先检查现有测试，避免协议已经变了。', 'session-new', { scope: { userId: 'local', characterId: 'default' } })

    expect(repository.search).toHaveBeenCalledTimes(2)
    expect(results[0]).toEqual(expect.objectContaining({
      id: 'memory-1',
      originalSimilarity: 0.4,
      normalizedSimilarity: 0.8,
      retrievalQuery: 'both',
    }))
    expect(repository.recordAccess).toHaveBeenCalledWith({ memoryIds: ['memory-1'], sessionId: 'session-new' })
  })

  it('captures every production route candidate before the final injection bound', async () => {
    localStorage.setItem('settings/memory/enabled', 'true')
    const fields = {
      content: 'A retrieval fixture',
      memoryType: 'short_term' as const,
      category: 'life',
      importance: 7,
      emotionalImpact: 0,
      createdAt: 1,
      lastAccessed: 1,
      accessCount: 1,
      valence: 0,
      arousal: 0,
      halfLifeHours: 24,
      sessionIds: [],
      timeRelevance: 1,
      moodCongruence: 0,
    }
    const candidate = (id: string, score: number) => ({ ...fields, id, similarity: score, score })
    repository.search
      .mockResolvedValueOnce([
        candidate('original-1', 0.99),
        candidate('original-2', 0.98),
        candidate('original-3', 0.97),
        candidate('original-4', 0.96),
      ])
      .mockResolvedValueOnce([
        candidate('normalized-1', 0.95),
        candidate('normalized-2', 0.94),
      ])
    activeMemoryEmbeddingUsage
      .mockReturnValueOnce({ promptTokens: 12, totalTokens: 12 })
      .mockReturnValueOnce({ promptTokens: 5, totalTokens: 5 })

    const trace = await useMemoryStore().retrieveEvaluationTrace(
      '我想在修改接口之前先检查现有测试，避免协议已经变了。',
      'session-evaluation',
      { userId: 'profile-evaluation', characterId: 'card-evaluation' },
    )

    expect(trace.originalQuery).toContain('修改接口')
    expect(trace.normalizedQuery).toBeTruthy()
    expect(trace.originalCandidateIds).toEqual(['original-1', 'original-2', 'original-3', 'original-4'])
    expect(trace.normalizedCandidateIds).toEqual(['normalized-1', 'normalized-2'])
    expect(trace.retrievedIds).toHaveLength(3)
    expect(trace.queryTokenCount).toBe(12)
    expect(trace.normalizedQueryTokenCount).toBe(5)
    expect(repository.search).toHaveBeenCalledWith(expect.objectContaining({
      scope: { userId: 'profile-evaluation', characterId: 'card-evaluation' },
    }))
  })

  it('uses stable origin ids in production traces while retrieval keeps row ids', async () => {
    localStorage.setItem('settings/memory/enabled', 'true')
    repository.list.mockResolvedValue([])
    repository.search.mockResolvedValue([{
      id: 'row-1',
      originId: 'fact-scholarship',
      content: 'A stable evaluation fact',
      memoryType: 'short_term',
      category: 'life',
      importance: 7,
      emotionalImpact: 0,
      createdAt: 1,
      lastAccessed: 1,
      accessCount: 1,
      valence: 0,
      arousal: 0,
      halfLifeHours: 24,
      sessionIds: [],
      similarity: 0.9,
      score: 0.9,
      timeRelevance: 1,
      moodCongruence: 0,
    }])

    const store = useMemoryStore()
    const trace = await store.retrieveEvaluationTrace(
      '奖学金材料怎么准备？',
      'session-evaluation',
      { userId: 'profile-evaluation', characterId: 'card-evaluation' },
    )

    expect(trace.retrievedIds).toEqual(['fact-scholarship'])
    expect(trace.originalCandidateIds).toEqual(['fact-scholarship'])
  })

  it('returns an explicit profile, session, and scope with the production evaluation', async () => {
    localStorage.setItem('settings/memory/enabled', 'true')
    repository.search.mockResolvedValue([])

    const result = await useMemoryStore().evaluateProductionRetrieval({
      profileId: 'profile-evaluation',
      sessionId: 'session-evaluation',
      scope: { userId: 'profile-evaluation', characterId: 'card-evaluation' },
    })

    expect(result.context).toEqual({
      profileId: 'profile-evaluation',
      sessionId: 'session-evaluation',
      scope: { userId: 'profile-evaluation', characterId: 'card-evaluation' },
    })
    expect(result.metrics.caseCount).toBe(90)
    expect(repository.search).toHaveBeenCalled()
  })

  // ROOT CAUSE:
  //
  // The reflex channel only skipped `rejected` muscles, so a pending or
  // superseded reflex could still steer a prompt, and a preference stored as
  // muscle stayed invisible to ordinary vector search.
  it('fires the muscle reflex only for approved active claims', async () => {
    localStorage.setItem('settings/memory/enabled', 'true')
    repository.search.mockResolvedValue([])
    const reflexFields = {
      memoryType: 'muscle',
      category: 'chat',
      importance: 9,
      emotionalImpact: 0,
      createdAt: 1,
      lastAccessed: 1,
      accessCount: 1,
      valence: 0,
      arousal: 0,
      halfLifeHours: 1e9,
      sessionIds: [],
    }
    repository.list.mockResolvedValue([
      { ...reflexFields, id: 'pending-muscle', content: 'Pending reflex', reviewStatus: 'pending', triggerPattern: 'remembered fact' },
      { ...reflexFields, id: 'superseded-muscle', content: 'Superseded reflex', reviewStatus: 'approved', factStatus: 'superseded', triggerPattern: 'remembered fact' },
      { ...reflexFields, id: 'patternless-muscle', content: 'Patternless reflex', reviewStatus: 'approved', triggerPattern: null },
      { ...reflexFields, id: 'approved-muscle', content: 'Approved reflex', reviewStatus: 'approved', triggerPattern: 'remembered fact' },
    ])

    const results = await useMemoryStore().retrieve('remembered fact', 'session-new', { scope: { userId: 'local', characterId: 'default' } })

    expect(results.map(result => result.id)).toEqual(['approved-muscle'])
    expect(repository.recordAccess).toHaveBeenCalledWith({ memoryIds: ['approved-muscle'], sessionId: 'session-new' })
  })

  it('rejects backwards transitions from terminal dream idea states', async () => {
    localStorage.setItem('settings/memory/enabled', 'true')
    repository.listDreamIdeas.mockResolvedValue([{ id: 'idea-1', content: 'Finished', status: 'implemented', scope: dreamScope }])

    await expect(useMemoryStore().updateDreamIdea('idea-1', { status: 'developing' }, dreamScope)).rejects.toThrow('cannot move')
    expect(repository.updateDreamIdea).not.toHaveBeenCalled()
  })

  it('rejects an idea update from another character scope', async () => {
    localStorage.setItem('settings/memory/enabled', 'true')
    repository.listDreamIdeas.mockResolvedValue([{ id: 'other-idea', status: 'new', scope: { userId: 'local', characterId: 'other' } }])
    await expect(useMemoryStore().updateDreamIdea('other-idea', { status: 'developing' }, dreamScope)).rejects.toThrow('outside the current memory scope')
    expect(repository.updateDreamIdea).not.toHaveBeenCalled()
  })

  it('runs automatic dreaming behind its own interval, daily budget, and new-memory gates', async () => {
    const now = new Date(2026, 8, 4, 12).getTime()
    localStorage.setItem('settings/memory/enabled', 'true')
    localStorage.setItem('settings/memory/dreaming-enabled', 'true')
    localStorage.setItem('settings/memory/automatic-dreaming-enabled', 'true')
    localStorage.setItem('settings/memory/dreaming-interval-hours', '0')
    localStorage.setItem('settings/memory/dreaming-min-new-memory-count', '1')
    repository.list.mockResolvedValue([{
      id: 'approved-new',
      scope: dreamScope,
      content: 'A new approved fact',
      memoryType: 'short_term',
      category: 'life',
      importance: 8,
      createdAt: now - 1_000,
      reviewStatus: 'approved',
    }])
    installMemoryDreamAgent(async ({ fragments }) => [{
      content: `Follow up on ${fragments[0]?.content ?? 'the fact'}`,
      sourceId: fragments[0]?.id,
      excitement: 7,
    }])

    const store = useMemoryStore()
    const first = await store.runAutomaticDreaming({ now, scope: dreamScope })
    expect(first.status).toBe('ran')
    expect(repository.addDreamIdea).toHaveBeenCalledTimes(1)
    expect(store.lastDreamAt).toBe(now)
    expect(store.dreamingBudgetUsed).toBe(1)

    const second = await store.runAutomaticDreaming({ now: now + 1_000, scope: dreamScope })
    expect(second).toEqual({ status: 'skipped', reason: 'budget' })
  })

  it('does not spend an automatic pass before enough approved memories arrive', async () => {
    const now = new Date(2026, 8, 4, 12).getTime()
    localStorage.setItem('settings/memory/enabled', 'true')
    localStorage.setItem('settings/memory/dreaming-enabled', 'true')
    localStorage.setItem('settings/memory/automatic-dreaming-enabled', 'true')
    repository.list.mockResolvedValue([{
      id: 'one',
      content: 'One fact',
      memoryType: 'short_term',
      category: 'life',
      importance: 8,
      createdAt: now,
      reviewStatus: 'approved',
    }])

    const result = await useMemoryStore().runAutomaticDreaming({ now, scope: dreamScope })

    expect(result).toEqual({ status: 'skipped', reason: 'insufficient-new-memory' })
    expect(repository.addDreamIdea).not.toHaveBeenCalled()
  })

  it('enforces the automatic dreaming interval independently of its daily budget', async () => {
    const now = new Date(2026, 8, 4, 12).getTime()
    localStorage.setItem('settings/memory/enabled', 'true')
    localStorage.setItem('settings/memory/dreaming-enabled', 'true')
    localStorage.setItem('settings/memory/automatic-dreaming-enabled', 'true')
    localStorage.setItem('settings/memory/dreaming-daily-budget', '0')
    localStorage.setItem('settings/memory/dreaming-min-new-memory-count', '1')
    repository.list.mockResolvedValue([{
      id: 'approved-new',
      scope: dreamScope,
      content: 'A new approved fact',
      memoryType: 'short_term',
      category: 'life',
      importance: 8,
      createdAt: now - 1_000,
      reviewStatus: 'approved',
    }])

    const store = useMemoryStore()
    expect((await store.runAutomaticDreaming({ now, scope: dreamScope })).status).toBe('ran')
    expect(await store.runAutomaticDreaming({ now: now + 60 * 60 * 1_000, scope: dreamScope })).toEqual({ status: 'skipped', reason: 'cooldown' })
  })

  it('queues promoted long-term memories and clears the outbox after idempotent delivery', async () => {
    localStorage.setItem('settings/memory/enabled', 'true')
    localStorage.setItem('settings/memory/long-term-sync-enabled', 'true')
    repository.list.mockResolvedValue([{
      id: 'local-long-1',
      content: 'A promoted fact',
      memoryType: 'long_term',
      category: 'life',
      importance: 8,
      emotionalImpact: 0,
      createdAt: 1,
      lastAccessed: 1,
      accessCount: 3,
      valence: 0.2,
      arousal: 0.4,
      halfLifeHours: 4_320,
      sessionIds: ['session-1', 'session-2'],
      reviewStatus: 'approved',
      contentVector: Array.from({ length: 768 }).fill(0),
    }])
    installMemoryHostPort(memoryHost)

    const store = useMemoryStore()
    await store.queueExistingLongTermMemories()

    expect(memoryHost.insert).toHaveBeenCalledWith(expect.objectContaining({
      originId: 'local-long-1',
      content: 'A promoted fact',
    }))
    expect(store.longTermSyncOutbox).toEqual([])
    expect(store.lastLongTermSyncError).toBe('')
  })

  it('marks the remote mirror unavailable while retaining a failed outbox item', async () => {
    localStorage.setItem('settings/memory/enabled', 'true')
    localStorage.setItem('settings/memory/long-term-sync-enabled', 'true')
    repository.list.mockResolvedValue([{
      id: 'remote-fact-1',
      content: 'A fact waiting for the remote mirror',
      memoryType: 'long_term',
      category: 'life',
      importance: 8,
      createdAt: 1,
      lastAccessed: 1,
      accessCount: 3,
      valence: 0,
      arousal: 0,
      halfLifeHours: 4_320,
      sessionIds: ['session-1'],
      reviewStatus: 'approved',
      factStatus: 'active',
      contentVector: Array.from({ length: 768 }).fill(0),
    }])
    installMemoryHostPort(memoryHost)
    memoryHost.insert.mockRejectedValueOnce(new Error('connection lost'))

    const store = useMemoryStore()
    await store.refreshRemoteHostStatus()
    await store.queueExistingLongTermMemories()

    expect(store.remoteStatus).toBe('error')
    expect(store.remoteError).toBe('connection lost')
    expect(store.longTermSyncOutbox).toEqual([
      expect.objectContaining({ originId: 'remote-fact-1', attempts: 1, lastError: 'connection lost' }),
    ])

    memoryHost.insert.mockResolvedValueOnce({ id: 'remote-fact-1' })
    await store.refreshRemoteHostStatus()
    expect(store.remoteStatus).toBe('ready')
    expect(store.longTermSyncOutbox).toEqual([])
  })

  it('keeps fact revisions pending until approval, then supersedes the old claim', async () => {
    localStorage.setItem('settings/memory/enabled', 'true')
    const current = {
      id: 'old-fact',
      content: 'The old fact',
      memoryType: 'long_term',
      category: 'life',
      importance: 7,
      emotionalImpact: 0,
      createdAt: 1,
      lastAccessed: 1,
      accessCount: 3,
      valence: 0,
      arousal: 0.2,
      halfLifeHours: 4_320,
      sessionIds: ['a', 'b'],
      reviewStatus: 'approved',
      factStatus: 'active',
    }
    repository.list.mockResolvedValue([current])
    repository.insert.mockResolvedValue({ ...current, id: 'new-fact', content: 'The revised fact', reviewStatus: 'pending', supersedesId: 'old-fact' })

    const store = useMemoryStore()
    await store.reviseFact({ memoryId: 'old-fact', content: 'The revised fact', relation: 'supersedes' })

    expect(repository.insert).toHaveBeenCalledWith(expect.objectContaining({
      content: 'The revised fact',
      reviewStatus: 'pending',
      supersedesId: 'old-fact',
      factStatus: 'active',
    }))

    repository.list.mockResolvedValue([{ ...current, id: 'new-fact', reviewStatus: 'pending', supersedesId: 'old-fact' }])
    await store.setReviewStatus('new-fact', 'approved')
    expect(repository.update).toHaveBeenCalledWith('old-fact', { factStatus: 'superseded' })
  })

  it('inherits the replaced fact source so an approved revision can be shared', async () => {
    // ROOT CAUSE:
    //
    // reviseFact persisted the revision without a sourceContext, so the
    // shareable-source gate filtered it out forever: after a correction the
    // social consideration boundary had neither the old fact nor the new one
    // (ACC-20260910 S17).
    localStorage.setItem('settings/memory/enabled', 'true')
    const sourceContext = { sessionId: 'session-1', messageId: 'message-1', sourceType: 'chat' as const, neighbors: [] }
    const scope = { userId: 'local', characterId: 'default' }
    const current = {
      id: 'old-fact',
      content: 'The old fact',
      memoryType: 'long_term',
      category: 'life',
      importance: 7,
      emotionalImpact: 0,
      createdAt: 1,
      lastAccessed: 1,
      accessCount: 3,
      valence: 0,
      arousal: 0.2,
      halfLifeHours: 4_320,
      sessionIds: ['a'],
      reviewStatus: 'approved',
      factStatus: 'active',
      sourceContext,
      scope,
    }
    repository.list.mockResolvedValue([current])

    const store = useMemoryStore()
    await store.reviseFact({ memoryId: 'old-fact', content: 'The revised fact', relation: 'supersedes' })

    const inserted = repository.insert.mock.calls[0]?.[0]
    expect(inserted).toEqual(expect.objectContaining({ supersedesId: 'old-fact', sourceContext }))

    repository.list.mockResolvedValue([
      { ...current, id: 'new-fact', content: 'The revised fact', reviewStatus: 'approved', supersedesId: 'old-fact', createdAt: 2 },
      { ...current, factStatus: 'superseded' },
    ])
    const shareable = await store.listShareableFacts(scope)
    expect(shareable.map(fragment => fragment.id)).toContain('new-fact')
    expect(shareable.map(fragment => fragment.id)).not.toContain('old-fact')
    // Eligibility is pushed into the query; a top-N page by last access used
    // to hide an eligible fact that had not been read recently (#12).
    expect(repository.list).toHaveBeenLastCalledWith(expect.objectContaining({ shareable: true, scope }))
  })

  it('drops the broken database handle so the next call reopens it', async () => {
    // ROOT CAUSE (#16): a failed query left the cached WASM connection in an
    // unusable state ('peek' of undefined), and every later call reused it
    // until the app restarted.
    localStorage.setItem('settings/memory/enabled', 'true')
    repository.search.mockRejectedValueOnce(new Error('peek fail'))
    const store = useMemoryStore()

    await expect(store.retrieve('anything', 'session-1', { scope: { userId: 'local', characterId: 'default' } })).resolves.toEqual([])
    expect(store.databaseStatus).toBe('error')

    repository.search.mockResolvedValueOnce([])
    await store.retrieve('anything', 'session-1', { scope: { userId: 'local', characterId: 'default' } })

    expect(store.databaseStatus).toBe('ready')
    expect(database.getDb.mock.calls.length).toBeGreaterThanOrEqual(2)
  })

  it('does not queue a remote update for a short-term fact without a remote row', async () => {
    // ROOT CAUSE:
    //
    // Approving a not-yet-promoted short-term fact queued an `update`. The
    // remote update matched zero rows, was treated as success, and cleared
    // the outbox while the mirror stayed missing (R06).
    localStorage.setItem('settings/memory/enabled', 'true')
    localStorage.setItem('settings/memory/long-term-sync-enabled', 'true')
    installMemoryHostPort(memoryHost)
    const shortFact = {
      id: 'short-fact',
      content: 'A pending fact',
      memoryType: 'short_term',
      category: 'chat',
      importance: 5,
      emotionalImpact: 0,
      createdAt: 1,
      lastAccessed: 1,
      accessCount: 1,
      valence: 0,
      arousal: 0,
      halfLifeHours: 24,
      sessionIds: ['session-1'],
      reviewStatus: 'pending',
      factStatus: 'active',
      scope: { userId: 'local', characterId: 'default' },
    }
    repository.list.mockResolvedValue([shortFact])
    repository.update.mockResolvedValue({ ...shortFact, reviewStatus: 'approved' })

    const store = useMemoryStore()
    await store.refreshRemoteHostStatus()
    await store.setReviewStatus('short-fact', 'approved')

    expect(store.longTermSyncOutbox).toEqual([])
    expect(memoryHost.update).not.toHaveBeenCalled()
  })

  it('queues a remote update for an already-promoted fact', async () => {
    localStorage.setItem('settings/memory/enabled', 'true')
    localStorage.setItem('settings/memory/long-term-sync-enabled', 'true')
    installMemoryHostPort(memoryHost)
    const longFact = {
      id: 'long-fact',
      content: 'A promoted fact',
      memoryType: 'long_term',
      category: 'life',
      importance: 8,
      emotionalImpact: 0,
      createdAt: 1,
      lastAccessed: 1,
      accessCount: 3,
      valence: 0,
      arousal: 0,
      halfLifeHours: 4_320,
      sessionIds: ['session-1'],
      reviewStatus: 'pending',
      factStatus: 'active',
      scope: { userId: 'local', characterId: 'default' },
    }
    repository.list.mockResolvedValue([longFact])
    repository.update.mockResolvedValue({ ...longFact, reviewStatus: 'approved' })

    const store = useMemoryStore()
    await store.refreshRemoteHostStatus()
    await store.setReviewStatus('long-fact', 'approved')
    await store.retryLongTermSync()

    expect(memoryHost.update).toHaveBeenCalledWith({ originId: 'long-fact', patch: { reviewStatus: 'approved' } })
    expect(store.longTermSyncOutbox).toEqual([])
  })

  it('converts a muscle revision into a reviewable fact without carrying the reflex', async () => {
    localStorage.setItem('settings/memory/enabled', 'true')
    const current = {
      id: 'old-muscle',
      content: 'The old reflex',
      memoryType: 'muscle',
      category: 'chat',
      importance: 9,
      emotionalImpact: 0,
      createdAt: 1,
      lastAccessed: 1,
      accessCount: 2,
      valence: 0,
      arousal: 0,
      halfLifeHours: 1e9,
      sessionIds: ['a'],
      triggerPattern: 'old pattern',
      reviewStatus: 'approved',
      factStatus: 'active',
    }
    repository.list.mockResolvedValue([current])

    await useMemoryStore().reviseFact({ memoryId: 'old-muscle', content: 'The corrected fact', relation: 'supersedes' })

    const inserted = repository.insert.mock.calls[0]?.[0]
    expect(inserted).toEqual(expect.objectContaining({
      memoryType: 'short_term',
      reviewStatus: 'pending',
      supersedesId: 'old-muscle',
    }))
    expect(inserted?.triggerPattern).toBeUndefined()

    const revised = useJournalStore().readSession(MEMORY_BROWSER_SESSION_ID).find(event => event.type === 'memory/revised')
    expect(revised).toEqual(expect.objectContaining({
      type: 'memory/revised',
      memoryId: 'old-muscle',
      revisionId: 'The corrected fact',
      relation: 'supersedes',
    }))
  })

  it('refuses to store a muscle memory without a trigger pattern', async () => {
    localStorage.setItem('settings/memory/enabled', 'true')

    const store = useMemoryStore()
    await expect(store.rememberMuscle({ content: 'A procedure', triggerPattern: '   ' })).resolves.toBeUndefined()
    await expect(store.rememberMuscle({ content: 'A procedure', triggerPattern: 'run tests' })).resolves.toBeDefined()

    expect(repository.insert).toHaveBeenCalledTimes(1)
    expect(repository.insert).toHaveBeenCalledWith(expect.objectContaining({
      memoryType: 'muscle',
      triggerPattern: 'run tests',
      reviewStatus: 'approved',
    }))
  })

  it('converts a patternless muscle into a pending fact in place', async () => {
    localStorage.setItem('settings/memory/enabled', 'true')
    localStorage.setItem('settings/memory/long-term-sync-enabled', 'true')
    const current = {
      id: 'misplaced-pref',
      content: 'The user prefers running tests before edits',
      memoryType: 'muscle',
      category: 'chat',
      importance: 9,
      emotionalImpact: 0,
      createdAt: 1,
      lastAccessed: 1,
      accessCount: 3,
      valence: 0,
      arousal: 0,
      halfLifeHours: 1e9,
      sessionIds: ['a', 'b'],
      triggerPattern: null,
      reviewStatus: 'approved',
      factStatus: 'active',
    }
    repository.list.mockResolvedValue([current])
    repository.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({ ...current, ...patch }))
    installMemoryHostPort(memoryHost)

    const store = useMemoryStore()
    const converted = await store.convertMuscleToFact('misplaced-pref')

    // The migration keeps the id and access history and reruns the review
    // gate; the re-embed makes sure search ranks the fact, not the reflex.
    expect(converted).toEqual(expect.objectContaining({
      id: 'misplaced-pref',
      memoryType: 'short_term',
      reviewStatus: 'pending',
      triggerPattern: null,
    }))
    const updatePatch = repository.update.mock.calls[0]?.[1] as Record<string, unknown>
    expect(updatePatch.memoryType).toBe('short_term')
    expect(updatePatch.reviewStatus).toBe('pending')
    expect(updatePatch.triggerPattern).toBeNull()
    expect(updatePatch.halfLifeHours).toBe(24)
    expect(updatePatch.contentVector).toHaveLength(768)
    // Neither the muscle nor the short-term fact it becomes is mirrored yet;
    // the promotion insert carries the final state (R06).
    expect(store.longTermSyncOutbox).toEqual([])

    // The migration stays auditable: the browser session journal records what
    // was converted and into what.
    const migrated = useJournalStore().readSession(MEMORY_BROWSER_SESSION_ID).find(event => event.type === 'memory/migrated')
    expect(migrated).toEqual(expect.objectContaining({
      type: 'memory/migrated',
      memoryId: 'misplaced-pref',
      fromType: 'muscle',
      toType: 'short_term',
      reviewStatus: 'pending',
    }))
  })

  it('refuses muscle conversions that would rewrite a verdict or a working reflex', async () => {
    localStorage.setItem('settings/memory/enabled', 'true')
    const base = {
      memoryType: 'muscle',
      category: 'chat',
      importance: 9,
      emotionalImpact: 0,
      createdAt: 1,
      lastAccessed: 1,
      accessCount: 1,
      valence: 0,
      arousal: 0,
      halfLifeHours: 1e9,
      sessionIds: [],
    }
    const store = useMemoryStore()

    repository.list.mockResolvedValue([{ ...base, id: 'rejected-muscle', content: 'Rejected', reviewStatus: 'rejected', triggerPattern: null }])
    await expect(store.convertMuscleToFact('rejected-muscle')).rejects.toThrow('rejected')

    repository.list.mockResolvedValue([{ ...base, id: 'working-muscle', content: 'Working', reviewStatus: 'approved', triggerPattern: 'run tests' }])
    await expect(store.convertMuscleToFact('working-muscle')).rejects.toThrow('trigger pattern')

    repository.list.mockResolvedValue([{ ...base, id: 'plain-fact', content: 'A fact', memoryType: 'short_term', reviewStatus: 'approved', triggerPattern: null }])
    await expect(store.convertMuscleToFact('plain-fact')).rejects.toThrow('muscle')

    expect(repository.update).not.toHaveBeenCalled()
  })

  it('queues a remote update for the superseded claim when a revision is approved', async () => {
    // The replacement is short_term, so it has no remote row; only the
    // already-promoted claim it supersedes can be updated remotely (R06).
    localStorage.setItem('settings/memory/enabled', 'true')
    localStorage.setItem('settings/memory/long-term-sync-enabled', 'true')
    const current = {
      id: 'old-fact',
      content: 'The old fact',
      memoryType: 'long_term',
      category: 'life',
      importance: 7,
      emotionalImpact: 0,
      createdAt: 1,
      lastAccessed: 1,
      accessCount: 3,
      valence: 0,
      arousal: 0.2,
      halfLifeHours: 4_320,
      sessionIds: ['a', 'b'],
      reviewStatus: 'approved',
      factStatus: 'active',
    }
    repository.list.mockResolvedValue([
      { ...current, id: 'new-fact', memoryType: 'short_term', reviewStatus: 'pending', supersedesId: 'old-fact' },
      current,
    ])
    installMemoryHostPort(memoryHost)
    const store = useMemoryStore()
    await store.refreshRemoteHostStatus()

    await store.setReviewStatus('new-fact', 'approved')

    expect(store.longTermSyncOutbox.map(item => [item.kind, item.originId])).toEqual([
      ['update', 'old-fact'],
    ])
    expect(store.longTermSyncOutbox[0]?.patch).toEqual({ factStatus: 'superseded' })
  })

  it('flushes queued ops in FIFO order, ending removals with a tombstone', async () => {
    localStorage.setItem('settings/memory/enabled', 'true')
    localStorage.setItem('settings/memory/long-term-sync-enabled', 'true')
    repository.list.mockResolvedValue([
      {
        id: 'fact-1',
        content: 'A long fact',
        memoryType: 'long_term',
        category: 'life',
        importance: 7,
        createdAt: 1,
        lastAccessed: 1,
        accessCount: 3,
        valence: 0,
        arousal: 0,
        halfLifeHours: 4_320,
        sessionIds: ['a'],
        reviewStatus: 'approved',
        factStatus: 'active',
      },
    ])
    installMemoryHostPort(memoryHost)
    const store = useMemoryStore()
    await store.refreshRemoteHostStatus()

    await store.setReviewStatus('fact-1', 'rejected')
    await store.remove('fact-1')
    expect(store.longTermSyncOutbox.map(item => item.kind)).toEqual(['update', 'delete'])

    await store.retryLongTermSync()

    expect(memoryHost.update).toHaveBeenCalledWith({ originId: 'fact-1', patch: { reviewStatus: 'rejected' } })
    expect(memoryHost.remove).toHaveBeenCalledWith({ originId: 'fact-1' })
    expect(store.longTermSyncOutbox).toEqual([])
  })

  it('installs the API embedding source from the configured endpoint', async () => {
    localStorage.setItem('settings/memory/enabled', 'true')
    localStorage.setItem('settings/memory/embedding-source', 'api')
    localStorage.setItem('settings/memory/embedding-base-url', 'https://emb.example/v1/')
    localStorage.setItem('settings/memory/embedding-api-key', 'ek')
    localStorage.setItem('settings/memory/embedding-model', 'text-embedding-3-small')

    await useMemoryStore().initialize()

    expect(createApiMemoryEmbeddingSource).toHaveBeenCalledWith({
      baseUrl: 'https://emb.example/v1/',
      apiKey: 'ek',
      model: 'text-embedding-3-small',
    })
    expect(installMemoryEmbeddingSource).toHaveBeenLastCalledWith(expect.objectContaining({
      fingerprint: 'api:https://emb.example/v1/:text-embedding-3-small:768',
    }))
    expect(useMemoryStore().embeddingError).toBeUndefined()
  })

  it('falls back to the local worker and reports the error when the endpoint is incomplete', async () => {
    localStorage.setItem('settings/memory/enabled', 'true')
    localStorage.setItem('settings/memory/embedding-source', 'api')
    localStorage.setItem('settings/memory/embedding-base-url', 'https://emb.example/v1/')

    const store = useMemoryStore()
    await store.initialize()

    expect(installMemoryEmbeddingSource).toHaveBeenLastCalledWith(undefined)
    expect(store.embeddingError).toContain('required')
  })

  it('re-embeds stored vectors once when the embedding space changes', async () => {
    localStorage.setItem('settings/memory/enabled', 'true')
    localStorage.setItem('settings/memory/embedding-fingerprint', 'old-vector-space')
    repository.list.mockResolvedValue([{
      id: 'fact-1',
      content: 'A stored fact',
      memoryType: 'short_term',
      category: 'chat',
      importance: 5,
      createdAt: 1,
      lastAccessed: 1,
      accessCount: 1,
      valence: 0,
      arousal: 0,
      halfLifeHours: 24,
      sessionIds: [],
      reviewStatus: 'approved',
    }])
    repository.listDreamIdeas.mockResolvedValue([])

    await useMemoryStore().initialize()

    expect(repository.update).toHaveBeenCalledWith('fact-1', expect.objectContaining({ content: 'A stored fact', contentVector: expect.any(Array) }))
    expect(localStorage.getItem('settings/memory/embedding-fingerprint')).toBe('test-vector-space')
  })
})
