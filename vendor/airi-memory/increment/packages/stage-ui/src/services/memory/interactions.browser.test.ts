import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { useDuckDb } from '../../composables/use-duck-db'
import { editMemoryPresentation, proposeMemoryOperation, readMemoryBodies, reviewMemoryOperation } from './interactions'
import { createDuckDbMemoryRepository } from './local-memory'
import { reconcileMemoryExtractions } from './reconciliation'

const scope = { userId: 'memory-test', characterId: 'character-a' }
const context = { sessionId: 'session-a', turnId: 'turn-a', scope, sourceContext: { sessionId: 'session-a', messageId: 'turn-a', neighbors: [] }, isCurrent: () => true }
const database = useDuckDb()
let repository: ReturnType<typeof createDuckDbMemoryRepository>

beforeAll(async () => {
  const url = new URL(location.href)
  url.searchParams.set('synced-leader', 'true')
  history.replaceState(null, '', url)
  await database.getDb()
  repository = createDuckDbMemoryRepository(database.db.value!, database.transaction)
}, 60_000)

afterAll(async () => {
  await database.closeDb()
})

describe('memory interaction on real DuckDB', () => {
  // ROOT CAUSE:
  // list() limited the global rows before applying user/character visibility.
  // Newer facts in other scopes consumed the whole page in V3 acceptance.
  // The database must apply visibility before ordering and limiting the page.
  it('fills scoped pages despite newer facts from other users and characters (V3)', async () => {
    const owner = { userId: 'v3-owner\'quoted', characterId: 'v3-character\'quoted' }
    const insert = (scope: typeof owner | undefined, now: number, content: string) => repository.insert({
      content,
      scope,
      now,
      memoryType: 'short_term',
      category: 'chat',
      importance: 5,
      valence: 0,
      arousal: 0,
      tags: [],
      reviewStatus: 'approved',
    })
    const oldest = await insert(owner, 1, 'Older visible fact')
    const newest = await insert(owner, 2, 'Newer visible fact')
    const linked = await insert({ ...owner, userId: 'v3-local' }, 3, 'Linked history')
    await insert({ ...owner, userId: 'v3-stranger' }, 4, 'Other account')
    await insert({ ...owner, characterId: 'v3-other-character' }, 5, 'Other character')
    await insert({ userId: 'v3-local', characterId: 'v3-other-character' }, 6, 'Linked but other character')
    await insert(undefined, 7, 'Unowned fact')
    // Malformed and non-string legacy scope values must not consume a page
    // or become visible through JSON-to-string coercion.
    const malformed = await insert(undefined, 8, 'Malformed scope')
    await database.db.value!.execute(`UPDATE memory_fragments SET scope_json = 'invalid' WHERE id = '${malformed.id}'`)
    const numeric = await insert(undefined, 9, 'Numeric user id')
    await database.db.value!.execute(`UPDATE memory_fragments SET scope_json = '{"userId":123,"characterId":"v3-numeric"}' WHERE id = '${numeric.id}'`)
    try {
      expect((await repository.list({ scope: owner, limit: 2 })).map(row => row.id)).toEqual([newest.id, oldest.id])
      expect((await repository.list({ scope: owner, linkedUserIds: ['v3-local'], limit: 2 })).map(row => row.id)).toEqual([linked.id, newest.id])
      expect((await repository.list({ scope: owner, limit: 1 })).map(row => row.id)).toEqual([newest.id])
      expect(await repository.list({ scope: { ...owner, characterId: 'v3-absent' }, limit: 2 })).toEqual([])
      expect(await repository.list({ scope: { userId: '123', characterId: 'v3-numeric' }, limit: 1 })).toEqual([])
    }
    finally {
      await database.db.value!.execute(`DELETE FROM memory_fragments WHERE id IN ('${malformed.id}', '${numeric.id}')`)
    }
  })

  it('persists pending facts without vectors, replays once, and atomically corrects a pinned fact', async () => {
    const proposal = { kind: 'remember' as const, content: 'I prefer tea.', title: 'Drink', summary: 'Prefers tea.' }
    const pending = await proposeMemoryOperation(repository, context, 'remember-a', proposal)
    expect(pending.status).toBe('pending_review')
    expect(await repository.directory(scope)).toEqual([])
    expect((await proposeMemoryOperation(repository, context, 'remember-a', proposal)).fragmentId).toBe(pending.fragmentId)
    expect((await repository.list({ scope })).length).toBe(1)
    expect((await repository.get(pending.fragmentId!))?.contentVector).toBeUndefined()
    await reviewMemoryOperation(repository, scope, pending.operationId, true, context.isCurrent)
    const approved = (await repository.get(pending.fragmentId!))!
    const pinned = await editMemoryPresentation(repository, scope, { id: approved.id, expectedRevision: approved.revision!, title: 'Drink', summary: 'Prefers tea.', pinned: true, pinOrder: 0 }, context.isCurrent)
    const correction = await proposeMemoryOperation(repository, context, 'correct-a', { kind: 'correct', targetId: pinned.id, expectedRevision: pinned.revision, content: 'I now prefer coffee.', title: 'Drink', summary: 'Now prefers coffee.' })
    expect((await repository.directory(scope)).map(row => row.id)).toEqual([pinned.id])
    await reviewMemoryOperation(repository, scope, correction.operationId, true, context.isCurrent)
    const directory = await repository.directory(scope)
    expect(directory.map(row => row.id)).toEqual([correction.fragmentId])
    expect(directory[0]?.summaryRevision).toBe(directory[0]?.revision)
    expect((await repository.get(pinned.id))?.factStatus).toBe('superseded')
    const stale = await readMemoryBodies(repository, context, [{ id: pinned.id, revision: pinned.revision! }], [{ id: pinned.id, offset: 0 }])
    expect(stale.results[0]?.status).toBe('unavailable_or_changed')
  })

  it('rolls back both fact and receipt on revocation, and refuses another owner', async () => {
    let checks = 0
    await expect(proposeMemoryOperation(repository, { ...context, isCurrent: () => ++checks < 3 }, 'revoked', { kind: 'remember', content: 'Must roll back.' })).rejects.toThrow('revoked')
    expect(await repository.operation('revoked')).toBeUndefined()
    expect((await repository.list({ scope })).some(row => row.content === 'Must roll back.')).toBe(false)
    const current = (await repository.directory(scope))[0]!
    await expect(proposeMemoryOperation(repository, { ...context, scope: { ...scope, userId: 'other' } }, 'cross-user', { kind: 'forget', targetId: current.id, expectedRevision: current.revision })).rejects.toThrow('unavailable')
  })

  it('retains receipt and revision data in a versioned snapshot and after reopening', async () => {
    const entries = await database.exportSnapshot()
    expect(entries.map(entry => entry.path)).toContain('memory/memory_operations.parquet')
    expect(entries.map(entry => entry.path)).toContain('memory/schema.json')
    await expect(database.importSnapshot(entries)).rejects.toThrow('empty profile')
    await database.checkpointDb()
    await database.closeDb()
    await database.getDb()
    repository = createDuckDbMemoryRepository(database.db.value!, database.transaction)
    expect((await repository.operation('correct-a'))?.status).toBe('applied')
    expect((await repository.directory(scope))[0]?.summary).toBe('Now prefers coffee.')
  })

  it('serializes competing corrections and keeps a durable mirror intent until delivery', async () => {
    const target = await repository.insert({ content: 'Old remote fact', memoryType: 'long_term', category: 'chat', importance: 5, valence: 0, arousal: 0, tags: [], scope, reviewStatus: 'approved' })
    const a = await proposeMemoryOperation(repository, context, 'race-a', { kind: 'correct', targetId: target.id, expectedRevision: target.revision, content: 'First correction' })
    const b = await proposeMemoryOperation(repository, context, 'race-b', { kind: 'correct', targetId: target.id, expectedRevision: target.revision, content: 'Second correction' })
    const results = await Promise.all([reviewMemoryOperation(repository, scope, a.operationId, true, context.isCurrent), reviewMemoryOperation(repository, scope, b.operationId, true, context.isCurrent)])
    expect(results.map(result => result.status).sort()).toEqual(['applied', 'conflict'])
    expect((await repository.pendingMirrorOperations()).map(row => row.operationId)).toContain('race-a')
    expect((await reviewMemoryOperation(repository, scope, a.operationId, true, context.isCurrent)).fragmentId).toBe(a.fragmentId)
    const replacement = (await repository.get(a.fragmentId!))!
    const deletion = await proposeMemoryOperation(repository, context, 'forget-race', { kind: 'forget', targetId: replacement.id, expectedRevision: replacement.revision })
    await reviewMemoryOperation(repository, scope, deletion.operationId, true, context.isCurrent)
    expect(await repository.get(replacement.id)).toBeUndefined()
    expect((await repository.operation(deletion.operationId))?.status).toBe('applied')
  })

  it('rejects oversized pin presentation atomically and does not count directory views', async () => {
    const budgetScope = { ...scope, characterId: 'budget' }
    const facts = []
    for (let i = 0; i < 21; i++)
      facts.push(await repository.insert({ content: 'x', memoryType: 'short_term', category: 'chat', importance: 5, valence: 0, arousal: 0, tags: [], scope: budgetScope, reviewStatus: 'approved' }))
    for (const fact of facts.slice(0, 20))
      await editMemoryPresentation(repository, budgetScope, { id: fact.id, expectedRevision: fact.revision!, title: '', summary: '', pinned: true, pinOrder: 0 }, context.isCurrent)
    await expect(editMemoryPresentation(repository, budgetScope, { id: facts[20]!.id, expectedRevision: 1, title: '', summary: '', pinned: true, pinOrder: 0 }, context.isCurrent)).rejects.toThrow('budget')
    expect((await repository.get(facts[20]!.id))?.pinned).toBe(false)
    expect((await repository.directory(budgetScope))).toHaveLength(20)
    expect((await repository.get(facts[0]!.id))?.accessCount).toBe(facts[0]!.accessCount)
  })

  it('reads old long bodies in chunks and refuses unknown, linked-write and stale-version targets', async () => {
    const linkedScope = { ...scope, userId: 'local' }
    const long = await repository.insert({ content: 'long fact '.repeat(1500), memoryType: 'short_term', category: 'chat', importance: 5, valence: 0, arousal: 0, tags: [], scope: linkedScope, reviewStatus: 'approved' })
    const references = [{ id: long.id, revision: long.revision! }]
    expect((await readMemoryBodies(repository, context, references, [{ id: long.id, offset: 0 }])).results[0]?.status).toBe('unavailable_or_changed')
    const first = await readMemoryBodies(repository, context, references, [{ id: long.id, offset: 0 }], ['local'])
    expect(first.results[0]?.complete).toBe(false)
    expect(JSON.stringify(first).length).toBeLessThanOrEqual(8000)
    expect((await readMemoryBodies(repository, context, [], [{ id: long.id, offset: 0 }], ['local'])).results[0]?.status).toBe('unavailable_or_changed')
    await expect(proposeMemoryOperation(repository, context, 'linked-write', { kind: 'forget', targetId: long.id, expectedRevision: long.revision })).rejects.toThrow('unavailable')
    await repository.update(long.id, { content: 'Changed body' })
    expect((await readMemoryBodies(repository, context, references, [{ id: long.id, offset: first.results[0]!.nextOffset! }], ['local'])).results[0]?.status).toBe('unavailable_or_changed')
  })

  it('a18 finds a later-session forget receipt from its deleted target source', async () => {
    // ROOT CAUSE:
    // sourceOperations searched only the mutation message. An old source's
    // delayed extraction missed a later-session forget and requeued its fact.
    const owner = { userId: 'source-owner', characterId: 'source-character' }
    const originalSource = { sessionId: 'original-session', messageId: 'original-message', neighbors: [] }
    const original = await repository.insert({ content: 'I prefer unsweetened Earl Grey.', memoryType: 'short_term', category: 'chat', importance: 5, valence: 0, arousal: 0, tags: [], reviewStatus: 'approved', factStatus: 'active', scope: owner, sourceContext: originalSource })
    const later = { ...context, scope: owner, sessionId: 'later-session', turnId: 'later-turn', sourceContext: { sessionId: 'later-session', messageId: 'forget-message', neighbors: [] } }
    const pending = await proposeMemoryOperation(repository, later, 'a18-forget-source', { kind: 'forget', targetId: original.id, expectedRevision: original.revision! })
    await reviewMemoryOperation(repository, owner, pending.operationId, true, later.isCurrent)
    expect(await repository.get(original.id)).toBeUndefined()
    const operations = await repository.sourceOperations(owner, originalSource.sessionId, originalSource.messageId)
    expect(operations.map(operation => operation.operationId)).toEqual(['a18-forget-source'])
    expect(operations[0]?.previousContent).toBe(original.content)
    expect(await repository.sourceOperations({ ...owner, userId: 'other-user' }, originalSource.sessionId, originalSource.messageId)).toEqual([])
  })

  it('a18 associates a correction with both its authored message and the prior fact source', async () => {
    const owner = { userId: 'correction-owner', characterId: 'source-character' }
    const originalSource = { sessionId: 'first-session', messageId: 'first-message', neighbors: [] }
    const original = await repository.insert({ content: 'I prefer tea.', memoryType: 'short_term', category: 'chat', importance: 5, valence: 0, arousal: 0, tags: [], reviewStatus: 'approved', factStatus: 'active', scope: owner, sourceContext: originalSource })
    const later = { ...context, scope: owner, sessionId: 'correction-session', turnId: 'correction-turn', sourceContext: { sessionId: 'correction-session', messageId: 'correction-message', neighbors: [] } }
    const pending = await proposeMemoryOperation(repository, later, 'a18-correct-source', { kind: 'correct', targetId: original.id, expectedRevision: original.revision!, content: 'I now prefer coffee.' })
    await reviewMemoryOperation(repository, owner, pending.operationId, true, later.isCurrent)
    expect((await repository.sourceOperations(owner, originalSource.sessionId, originalSource.messageId)).map(operation => operation.operationId)).toEqual(['a18-correct-source'])
    expect((await repository.sourceOperations(owner, later.sessionId, later.sourceContext.messageId)).map(operation => operation.operationId)).toEqual(['a18-correct-source'])
  })

  it('a18 suppresses native reviewed facts that have no tool operation receipt', async () => {
    const owner = { userId: 'native-review-owner', characterId: 'source-character' }
    const source = { sessionId: 'native-session', messageId: 'native-message', neighbors: [] }
    const original = await repository.insert({ content: 'I prefer unsweetened Earl Grey.', memoryType: 'short_term', category: 'chat', importance: 5, valence: 0, arousal: 0, tags: [], reviewStatus: 'approved', factStatus: 'active', scope: owner, sourceContext: source })
    const extraction = { content: '用户喝不加糖的伯爵茶。', memoryType: 'short_term' as const, category: 'chat', importance: 5, valence: 0, arousal: 0, tags: [] }
    const reconcile = async () => JSON.stringify({ decisions: [{ candidate: 0, relation: 'covered', operationIds: [], factIds: [original.id] }] })
    expect((await reconcileMemoryExtractions(repository, [extraction], { scope: owner, sourceContext: source, reconcile, signal: new AbortController().signal })).accepted).toEqual([])
    await repository.update(original.id, { reviewStatus: 'rejected' })
    expect((await reconcileMemoryExtractions(repository, [extraction], { scope: owner, sourceContext: source, reconcile, signal: new AbortController().signal })).accepted).toEqual([])
  })

  it('a18 retains deleted native source facts as suppression evidence', async () => {
    const owner = { userId: 'native-delete-owner', characterId: 'source-character' }
    const source = { sessionId: 'deleted-session', messageId: 'deleted-message', neighbors: [] }
    const original = await repository.insert({ content: 'I prefer unsweetened Earl Grey.', memoryType: 'short_term', category: 'chat', importance: 5, valence: 0, arousal: 0, tags: [], reviewStatus: 'approved', factStatus: 'active', scope: owner, sourceContext: source })
    await repository.remove(original.id)
    const extraction = { content: '用户喝不加糖的伯爵茶。', memoryType: 'short_term' as const, category: 'chat', importance: 5, valence: 0, arousal: 0, tags: [] }
    const reconcile = async () => JSON.stringify({ decisions: [{ candidate: 0, relation: 'covered', operationIds: [], factIds: [original.id] }] })
    expect((await reconcileMemoryExtractions(repository, [extraction], { scope: owner, sourceContext: source, reconcile, signal: new AbortController().signal })).accepted).toEqual([])
  })

  it('restores version 2, migrates a five-table snapshot and rolls back malformed receipts', async () => {
    const snapshot = await database.exportSnapshot()
    const tables = snapshot.filter(entry => entry.path.endsWith('.parquet')).map(entry => entry.path.slice(7, -8))
    const clear = async () => {
      for (const table of tables)
        await database.db.value!.execute(`DELETE FROM ${table}`)
    }
    await clear()
    await database.importSnapshot(snapshot)
    expect((await repository.operation('correct-a'))?.status).toBe('applied')
    expect((await repository.directory(scope))[0]?.summary).toBe('Now prefers coffee.')
    const old = snapshot.filter(entry => entry.path !== 'memory/schema.json' && entry.path !== 'memory/memory_operations.parquet')
    const client = await database.db.value!.$client
    const connection = await client.db.connect()
    const file = 'legacy-memory-test.parquet'
    try {
      await connection.query(`COPY (SELECT * EXCLUDE(title, summary, revision, summary_revision, pinned, pin_order) FROM memory_fragments) TO '${file}' (FORMAT PARQUET)`)
      old.find(entry => entry.path === 'memory/memory_fragments.parquet')!.data = await client.db.copyFileToBuffer(file)
    }
    finally {
      await connection.close()
      await client.db.dropFile(file)
    }
    await clear()
    await database.importSnapshot(old)
    expect(await repository.operation('correct-a')).toBeUndefined()
    expect(await repository.directory(scope)).toEqual([])
    expect((await repository.list({ scope })).map(fact => ({ content: fact.content, scope: fact.scope }))).toContainEqual({ content: 'I now prefer coffee.', scope })
    await database.db.value!.execute(`INSERT INTO memory_operations VALUES ('malformed', 'u', 'c', 's', 1, '{}')`)
    const invalid = await database.exportSnapshot()
    await clear()
    await expect(database.importSnapshot(invalid)).rejects.toThrow()
    expect(await repository.list({ scope })).toEqual([])
    expect(await repository.operation('malformed')).toBeUndefined()
  })
})
