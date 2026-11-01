import assert from 'node:assert/strict'
import { createManualClock } from '../../src/main/clock'
import { createDuckDbMemoryRepository } from '../../src/main/memory/airi/repository/local-memory'
import { editMemoryPresentation, proposeMemoryOperation, reviewMemoryOperation } from '../../src/main/memory/airi/repository/interactions'
import type { MemoryDatabaseClient } from '../../src/main/memory/storage/client'

function barrier() {
  let release!: () => void
  const promise = new Promise<void>(resolve => { release = resolve })
  return { promise, release }
}

/** The same real-file contract runs under native Node and Electron utilityProcess.
 * Vectors and authored facts are fixed synthetic data; no service connections. */
export async function runMemoryStorageContract(open: () => Promise<MemoryDatabaseClient>) {
  const clock = createManualClock(1_790_000_000_000)
  const scope = { userId: 'storage-owner', characterId: 'taozi' }
  const context = { scope, sessionId: 'day-1', turnId: 'turn-1', sourceContext: { sessionId: 'day-1', messageId: 'original-1', neighbors: [] }, isCurrent: () => true }
  const vector = Array.from({ length: 768 }, (_, i) => i === 0 ? 1 : 0)
  const metadata = { embeddingProvider: 'fixture', embeddingModel: 'fixed-768', embeddingDimensions: 768, embeddingInputType: 'document' as const,
    embeddingSourceFingerprint: 'fixture-space-a', embeddedAt: clock.nowMs(), embeddingStatus: 'active' as const }
  const queryMetadata = { ...metadata, embeddingInputType: 'query' as const }
  let db = await open()
  let repo = createDuckDbMemoryRepository(db, db.transaction, clock)
  const checks: string[] = []
  try {
    const proposal = { kind: 'remember' as const, content: 'I prefer tea.', title: 'Drink', summary: 'Tea preference' }
    const pending = await proposeMemoryOperation(repo, context, 'remember-1', proposal, clock)
    assert.equal(pending.status, 'pending_review')
    assert.equal((await proposeMemoryOperation(repo, context, 'remember-1', proposal, clock)).fragmentId, pending.fragmentId)
    await assert.rejects(proposeMemoryOperation(repo, context, 'remember-1', { ...proposal, content: 'different' }, clock))
    const approved = await reviewMemoryOperation(repo, scope, 'remember-1', true, () => true, clock)
    const id = approved.fragmentId!
    const approvedFact = (await repo.get(id))!
    assert.equal(approvedFact.createdAt, clock.nowMs())
    // Approval advances revision. A vector computed for the pending version must be refused.
    await repo.updateEmbedding(id, 1, vector, metadata)
    assert.equal((await repo.get(id))?.contentVector, undefined)
    await repo.updateEmbedding(id, approvedFact.revision!, vector, metadata)
    assert.equal((await repo.search({ scope, embedding: vector, embeddingMetadata: queryMetadata, now: clock.nowMs() }))[0]?.id, id)
    assert.deepEqual(await repo.search({ scope: { ...scope, characterId: 'other' }, embedding: vector, now: clock.nowMs() }), [])
    assert.deepEqual(await repo.search({ scope, embedding: vector, embeddingMetadata: { ...queryMetadata, embeddingSourceFingerprint: 'other' }, now: clock.nowMs() }), [])
    assert.deepEqual(await repo.search({ scope, embedding: [1, 0], now: clock.nowMs() }), [])
    checks.push('native vector write/search, scope and embedding-space isolation, operation replay')

    // Rollback covers the original fact, tags, and operation receipt together.
    await assert.rejects(repo.transaction(async tx => {
      await tx.insert({ content: 'rollback only', category: 'chat', memoryType: 'short_term', importance: 5, valence: 0, arousal: 0, tags: ['rollback-tag'], scope, now: clock.nowMs() })
      await tx.saveOperation({ ...pending, operationId: 'must-rollback' })
      throw new Error('INJECTED_BEFORE_COMMIT')
    }), /INJECTED_BEFORE_COMMIT/)
    assert.equal(await repo.operation('must-rollback'), undefined)
    assert.deepEqual(await db.execute("SELECT tag FROM memory_tags WHERE tag = 'rollback-tag'"), [])
    checks.push('transaction rollback includes facts, tags and operation receipts')

    const entered = barrier(); const release = barrier()
    let otherSettled = false; let checkpointSettled = false
    const transaction = db.transaction(async tx => {
      await tx.execute("CREATE TABLE IF NOT EXISTS gate_isolation (id INTEGER)")
      await tx.execute('INSERT INTO gate_isolation VALUES (1)')
      entered.release(); await release.promise
    })
    await entered.promise
    const outside = db.execute('INSERT INTO gate_isolation VALUES (2)').then(() => { otherSettled = true })
    const checkpoint = db.checkpoint().then(() => { checkpointSettled = true })
    assert.equal(otherSettled, false); assert.equal(checkpointSettled, false)
    release.release()
    await Promise.all([transaction, outside, checkpoint])
    assert.deepEqual(await db.execute('SELECT id FROM gate_isolation ORDER BY id'), [{ id: 1 }, { id: 2 }])
    checks.push('transaction owns connection until commit; unrelated writes and checkpoint wait')

    const pinned = await editMemoryPresentation(repo, scope, { id, expectedRevision: approvedFact.revision!, title: 'Drink', summary: 'Tea preference', pinned: true, pinOrder: 1 }, () => true)
    const correction = await proposeMemoryOperation(repo, { ...context, turnId: 'turn-2' }, 'correct-1', { kind: 'correct', targetId: id, expectedRevision: pinned.revision, content: 'I now prefer coffee.', title: 'Drink', summary: 'Coffee preference' }, clock)
    await reviewMemoryOperation(repo, scope, 'correct-1', true, () => true, clock)
    assert.equal((await repo.get(id))?.factStatus, 'superseded')
    assert.equal((await repo.directory(scope))[0]?.id, correction.fragmentId)
    await repo.updateEmbedding(correction.fragmentId!, (await repo.get(correction.fragmentId!))!.revision!, vector, metadata)
    await db.checkpoint()
    await db.close()

    db = await open()
    repo = createDuckDbMemoryRepository(db, db.transaction, clock)
    assert.equal((await repo.operation('correct-1'))?.status, 'applied')
    assert.equal((await repo.get(correction.fragmentId!))?.content, 'I now prefer coffee.')
    assert.deepEqual((await repo.get(correction.fragmentId!))?.contentVector, vector)
    assert.equal((await repo.directory(scope))[0]?.id, correction.fragmentId)
    assert.equal((await repo.search({ scope, embedding: vector, embeddingMetadata: queryMetadata, now: clock.nowMs() }))[0]?.id, correction.fragmentId)
    checks.push('checkpoint/close/reopen preserves correction, directory, receipt and vector bytes')

    const current = (await repo.get(correction.fragmentId!))!
    await proposeMemoryOperation(repo, { ...context, turnId: 'turn-3' }, 'forget-1', { kind: 'forget', targetId: current.id, expectedRevision: current.revision }, clock)
    await reviewMemoryOperation(repo, scope, 'forget-1', true, () => true, clock)
    await repo.updateEmbedding(current.id, current.revision!, vector, metadata)
    assert.equal(await repo.get(current.id), undefined)
    assert.deepEqual(await repo.directory(scope), [])
    assert.deepEqual(await repo.search({ scope, embedding: vector, now: clock.nowMs() }), [])
    assert.equal((await repo.sourceOperations(scope, context.sessionId, 'original-1')).some(op => op.operationId === 'forget-1'), true)
    checks.push('forget tombstone rejects late embedding and retains source suppression')
    await db.close()
    db = await open(); repo = createDuckDbMemoryRepository(db, db.transaction, clock)
    assert.equal(await repo.get(current.id), undefined)
    assert.equal((await repo.operation('forget-1'))?.status, 'applied')
    checks.push('second reopen does not resurrect deleted fact')
    return { ok: true, checks, vectorDimensions: vector.length, serviceCalls: 0 }
  } finally { await db.close() }
}
