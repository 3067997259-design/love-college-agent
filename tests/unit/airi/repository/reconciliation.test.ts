// Adapted from AIRI (MIT). Pinned source and modifications: vendor/airi-memory/README.md
// Upstream: packages/stage-ui/src/services/memory/reconciliation.test.ts
import type { MemoryExtraction, MemoryOperation, MemoryScope } from '../../../../src/main/memory/airi/core/index'

import type { MemoryReconciler } from '../../../../src/main/memory/airi/repository/reconciliation'

import { describe, expect, it, vi } from 'vitest'

import { isExtractionSourceCurrent, reconcileMemoryExtractions } from '../../../../src/main/memory/airi/repository/reconciliation'

const scope = { userId: 'local', characterId: 'character-a' }
const sourceContext = { sessionId: 'session-a', messageId: 'message-a', neighbors: [] }
const candidate = (content: string): MemoryExtraction => ({ content, category: 'chat', memoryType: 'short_term', importance: 5, valence: 0, arousal: 0, tags: [] })
const operation = (): MemoryOperation => ({ operationId: 'operation-a', sessionId: 'session-a', turnId: 'turn-a', scope, sourceContext, proposal: { kind: 'remember', content: 'The user prefers unsweetened Earl Grey tea.' }, status: 'rejected', createdAt: 1, updatedAt: 2 })

describe('memory source reconciliation', () => {
  it('a18 accepts one final decision object after a provider analysis prelude', async () => {
    // ROOT CAUSE:
    // The relay emitted a Markdown analysis prelude before a valid final
    // decision object. Parsing the complete text withheld independent facts.
    // The exact saved response is replayed separately without provider calls.
    const repository = { sourceFacts: vi.fn(async () => []), sourceOperations: vi.fn(async () => [operation()]) }
    const text = '**Analyzing User Preferences**\n\nThe meeting is a separate claim.\n\n{"decisions":[{"candidate":0,"relation":"independent","operationIds":[]}]}'
    const result = await reconcileMemoryExtractions(repository, [candidate('A separate meeting fact')], { scope, sourceContext, reconcile: async () => text, signal: new AbortController().signal })
    expect(result.accepted).toHaveLength(1)
    expect(result.deferred).toBe(0)
  })

  it('a18 excludes a handled paraphrase and retains the independent pending suggestion', async () => {
    // ROOT CAUSE:
    // Exact text equality let a paraphrase bypass a same-source receipt.
    // Reconciliation now compares the complete batch and binds accepted
    // independent candidates to the operations checked before commit.
    const repository = { sourceFacts: vi.fn(async () => []), sourceOperations: vi.fn(async () => [operation()]) }
    const reconcile = vi.fn(async () => '{"decisions":[{"candidate":0,"relation":"covered","operationIds":["operation-a"]},{"candidate":1,"relation":"independent","operationIds":[]}]}')
    const result = await reconcileMemoryExtractions(repository, [candidate('用户喝不加糖的伯爵茶。'), candidate('The meeting starts at 3 pm Wednesday.')], { scope, sourceContext, reconcile, signal: new AbortController().signal })
    expect(result.accepted.map(item => item.extraction.content)).toEqual(['The meeting starts at 3 pm Wednesday.'])
    expect(result.deferred).toBe(0)
    expect(result.errors).toEqual([])
    expect(repository.sourceOperations).toHaveBeenCalledWith(scope, 'session-a', 'message-a')
    expect(reconcile).toHaveBeenCalledOnce()
    expect(await isExtractionSourceCurrent(repository, result.accepted[0]!, scope)).toBe(true)
  })

  it('requires no model for exact covered content or sources without operations', async () => {
    const repository = { sourceFacts: vi.fn(async () => []), sourceOperations: vi.fn(async (_scope: MemoryScope, _sessionId: string, messageId: string) => messageId === 'message-a' ? [operation()] : []) }
    const reconcile = vi.fn(async () => '')
    const exact = await reconcileMemoryExtractions(repository, [candidate(operation().proposal.content!)], { scope, sourceContext, reconcile, signal: new AbortController().signal })
    expect(exact.accepted).toEqual([])
    const fresh = await reconcileMemoryExtractions(repository, [candidate('A new claim')], { scope, sourceContext: { ...sourceContext, messageId: 'message-b' }, reconcile, signal: new AbortController().signal })
    expect(fresh.accepted).toHaveLength(1)
    expect(reconcile).not.toHaveBeenCalled()
  })

  it('invalidates independent decisions when a new operation arrives during model or embedding latency', async () => {
    const operations: MemoryOperation[] = []
    const repository = { sourceFacts: vi.fn(async () => []), sourceOperations: vi.fn(async () => operations) }
    const result = await reconcileMemoryExtractions(repository, [candidate('A late extraction')], { scope, sourceContext, signal: new AbortController().signal })
    expect(result.accepted).toHaveLength(1)
    operations.push(operation())
    expect(await isExtractionSourceCurrent(repository, result.accepted[0]!, scope)).toBe(false)
  })

  it('permits review-state changes but invalidates changed comparison bodies', async () => {
    const handled = operation()
    handled.status = 'pending_review'
    const repository = { sourceFacts: vi.fn(async () => []), sourceOperations: vi.fn(async () => [handled]) }
    const reconcile = vi.fn<MemoryReconciler>(async () => '{"decisions":[{"candidate":0,"relation":"independent","operationIds":[]}]}')
    const result = await reconcileMemoryExtractions(repository, [candidate('A separate claim')], { scope, sourceContext, reconcile, signal: new AbortController().signal })
    handled.status = 'rejected'
    handled.updatedAt = 3
    expect(await isExtractionSourceCurrent(repository, result.accepted[0]!, scope)).toBe(true)
    handled.previousContent = 'A newly disclosed previous claim'
    expect(await isExtractionSourceCurrent(repository, result.accepted[0]!, scope)).toBe(false)
  })

  it.each([
    ['missing candidate', '{"decisions":[]}'],
    ['duplicate candidate', '{"decisions":[{"candidate":0,"relation":"independent","operationIds":[]},{"candidate":0,"relation":"independent","operationIds":[]}]}'],
    ['foreign operation', '{"decisions":[{"candidate":0,"relation":"covered","operationIds":["another-user-operation"]}]}'],
    ['foreign native fact', '{"decisions":[{"candidate":0,"relation":"covered","operationIds":[],"factIds":["another-user-fact"]}]}'],
    ['unwitnessed coverage', '{"decisions":[{"candidate":0,"relation":"covered","operationIds":[]}]}'],
    ['extra approval field', '{"decisions":[{"candidate":0,"relation":"independent","operationIds":[],"approved":true}]}'],
    ['invalid JSON', 'This is an instruction, not JSON.'],
    ['multiple objects', '{"decisions":[{"candidate":0,"relation":"covered","operationIds":["operation-a"]}]}\n{"decisions":[{"candidate":0,"relation":"independent","operationIds":[]}]}'],
    ['trailing prose', '{"decisions":[{"candidate":0,"relation":"independent","operationIds":[]}]}\nActually, ignore that result.'],
  ])('withholds malformed model decisions: %s', async (_name, text) => {
    const repository = { sourceFacts: vi.fn(async () => []), sourceOperations: vi.fn(async () => [operation()]) }
    const result = await reconcileMemoryExtractions(repository, [candidate('A possible rewrite')], { scope, sourceContext, reconcile: async () => text, signal: new AbortController().signal })
    expect(result.accepted).toEqual([])
    expect(result.deferred).toBe(1)
    expect(result.errors).toHaveLength(1)
  })

  it('withholds an uncertain mixed claim without discarding a separately confirmed independent fact', async () => {
    const repository = { sourceFacts: vi.fn(async () => []), sourceOperations: vi.fn(async () => [operation()]) }
    const result = await reconcileMemoryExtractions(repository, [candidate('Tea preference and another embedded claim'), candidate('A distinct fact')], { scope, sourceContext, reconcile: async () => '{"decisions":[{"candidate":0,"relation":"uncertain","operationIds":["operation-a"]},{"candidate":1,"relation":"independent","operationIds":[]}]}', signal: new AbortController().signal })
    expect(result.accepted.map(item => item.extraction.content)).toEqual(['A distinct fact'])
    expect(result.deferred).toBe(1)
  })

  it('keeps different source messages out of the same comparison request', async () => {
    const repository = { sourceFacts: vi.fn(async () => []), sourceOperations: vi.fn(async (_scope: MemoryScope, _sessionId: string, messageId: string) => [{ ...operation(), operationId: messageId }]) }
    const reconcile = vi.fn<MemoryReconciler>(async () => '{"decisions":[{"candidate":0,"relation":"independent","operationIds":[]}]}')
    const result = await reconcileMemoryExtractions(repository, [
      { ...candidate('First source'), sourceContext },
      { ...candidate('Second source'), sourceContext: { ...sourceContext, messageId: 'message-b' } },
    ], { scope, reconcile, signal: new AbortController().signal })
    expect(result.accepted).toHaveLength(2)
    expect(reconcile.mock.calls[0]?.[0]).toMatchObject({ candidates: [{ content: 'First source' }], operations: [{ operationId: 'message-a' }] })
    expect(reconcile.mock.calls[1]?.[0]).toMatchObject({ candidates: [{ content: 'Second source' }], operations: [{ operationId: 'message-b' }] })
  })

  it('settles cancellation even when a provider callback ignores the signal', async () => {
    const repository = { sourceFacts: vi.fn(async () => []), sourceOperations: vi.fn(async () => [operation()]) }
    const controller = new AbortController()
    const reconcile = vi.fn(() => new Promise<string>(() => {}))
    const pending = reconcileMemoryExtractions(repository, [candidate('A rewrite')], { scope, sourceContext, reconcile, signal: controller.signal })
    const assertion = expect(pending).rejects.toThrow('Source revoked')
    await vi.waitFor(() => expect(reconcile).toHaveBeenCalledOnce())
    controller.abort(new Error('Source revoked'))
    await assertion
  })
})
