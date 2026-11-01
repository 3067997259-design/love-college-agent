import { join } from 'node:path'
import type { Clock } from '../clock'
import type { SessionStore } from '../store/session'
import type { ContinuityOwner, MemoryEngineStatus, MemoryFactView, MemoryReviewView } from '../../shared/continuity'
import { createMemoryEngine } from './engine'
import { createMemoryRuntimeState } from './storage/state'
import type { MemoryDatabaseClient } from './storage/client'
import type { MemoryEmbeddingSource } from './airi/embedding'
import type { MemoryTurnExtractor, MemoryHostPort } from './airi/runtime'
import type { MemoryReconciler } from './airi/repository/reconciliation'
import type { MemoryInteractionContext, MemoryReadReference } from './airi/repository/interactions'
import { buildMemoryDirectory, isSameMemoryScope, type MemoryFragment, type MemoryProposal } from './airi/core'
import { seenFragments, memoryDigest, type SeenFragment } from './seen'
import { MemoryFailure } from './model'

export interface MemoryCaptureModel { extract: MemoryTurnExtractor; reconcile?: MemoryReconciler }

/** LCA owns successful-input provenance and the product scope. AIRI owns every
 * fact, vector, review, retrieval, promotion and mirror lifecycle underneath. */
export function createMemoryFacts(options: {
  root: string; owner: ContinuityOwner; clock: Clock; store: SessionStore
  embedding(): MemoryEmbeddingSource | undefined; mirror?: MemoryHostPort
  held(): boolean; waitForRestore(): Promise<void>; changed(): void
  openDatabase?(path: string): Promise<MemoryDatabaseClient>
}) {
  const scope = { userId: options.owner.userId, characterId: options.owner.characterId }
  const state = createMemoryRuntimeState(join(options.root, 'capture.json'))
  const handled = state.cell<Record<string, number>>('captured-sources', {})
  const extractedAt = state.cell<number | null>('last-extracted-at', null)
  const engine = createMemoryEngine({ ...options, journal: () => options.changed() })
  const { runtime } = engine
  let fragments: MemoryFragment[] = []
  let operations: MemoryReviewView[] = []
  let proposalFacts = new Set<string>()
  let experiencePolicy = { revision: 'initial', excludedSourceIds: [] as string[], historicalSourceIds: [] as string[], legacyCutoff: 0 }
  let closed = false
  const history = () => options.store.history?.() ?? options.store.records()
  const sourceId = (source: SeenFragment) => source.sourceEventId ? `event:${source.sourceEventId}` : source.id
  const retired = () => {
    const rows = history(); const allowed = new Set(seenFragments(rows, true, true).map(sourceId))
    return new Set(seenFragments(rows, false, true).filter(item => !allowed.has(sourceId(item))).map(sourceId))
  }
  const visible = (fact: MemoryFragment, retiredIds = retired()) => isSameMemoryScope(fact.scope, scope)
    && !retiredIds.has(fact.sourceContext?.messageId ?? '')
  const refresh = async () => {
    const repository = await runtime.initialize()
    if (!repository) throw new MemoryFailure('unavailable')
    fragments = await repository.list({ scope, limit: 10_000 })
    const reviews = await runtime.listOperations(scope)
    const changes = reviews.filter(item => item.status === 'applied' && item.proposal.kind !== 'remember')
    const retiredFacts = fragments.filter(fact => fact.factStatus === 'superseded')
    const excludedSourceIds = [...new Set([...changes.map(item => item.previousSourceContext?.messageId), ...retiredFacts.map(fact => fact.sourceContext?.messageId)].filter((id): id is string => !!id))].sort()
    const forgotten = new Set(changes.filter(item => item.proposal.kind === 'forget').map(item => item.proposal.targetId!))
    // Forgetting the latest revision also prevents historical expansion from
    // bringing back earlier revisions of that same claim.
    for (let count = -1; count !== forgotten.size;) { count = forgotten.size; for (const item of changes) if (item.fragmentId && forgotten.has(item.fragmentId) && item.proposal.targetId) forgotten.add(item.proposal.targetId) }
    const forbidden = new Set(changes.filter(item => forgotten.has(item.proposal.targetId!)).map(item => item.previousSourceContext?.messageId))
    const historicalSourceIds = [...new Set([...changes.filter(item => item.proposal.kind === 'correct').map(item => item.previousSourceContext?.messageId),
      ...retiredFacts.filter(fact => !forgotten.has(fact.id)).map(fact => fact.sourceContext?.messageId)].filter((id): id is string => !!id && !forbidden.has(id)))].sort()
    // Old receipts did not preserve the deleted grounding identity. Their older
    // summaries remain archives, but cannot silently present old claims as current.
    const knownSources = new Set(seenFragments(history(), true, true).map(sourceId))
    const legacyCutoff = changes.reduce((at, item) => item.previousSourceContext?.messageId && knownSources.has(item.previousSourceContext.messageId) ? at : Math.max(at, item.updatedAt), 0)
    experiencePolicy = { revision: changes.length || retiredFacts.length ? memoryDigest(JSON.stringify([changes.map(item => item.operationId).sort(), excludedSourceIds, legacyCutoff])) : 'initial', excludedSourceIds, historicalSourceIds, legacyCutoff }
    proposalFacts = new Set(reviews.filter(item => item.status === 'pending_review' && item.fragmentId).map(item => item.fragmentId!))
    operations = reviews.toSorted((a, b) => Number(b.status === 'pending_review' || b.status === 'conflict') - Number(a.status === 'pending_review' || a.status === 'conflict') || b.updatedAt - a.updatedAt).slice(0, 40).map(item => ({ operationId: item.operationId, kind: item.proposal.kind,
      title: item.proposal.title ?? '', content: item.proposal.content ?? '', previousContent: item.previousContent ?? null, status: item.status, updatedAtMs: item.updatedAt }))
    options.changed()
  }
  const sourceStillAllowed = (source: SeenFragment) => !closed && !options.held() && seenFragments(history(), true, true).some(current => current.key === source.key && current.text === source.text)
  const factViews = (): MemoryFactView[] => fragments.filter(fact => visible(fact) && !proposalFacts.has(fact.id)).slice(0, 200).map(fact => ({ id: fact.id, revision: fact.revision ?? 1,
    title: fact.title ?? '', summary: fact.summary ?? '', content: fact.content.slice(0, 2000), pinned: fact.pinned === true, pinOrder: fact.pinOrder ?? 0,
    memoryType: fact.memoryType === 'working' ? 'short_term' : fact.memoryType, reviewStatus: fact.reviewStatus ?? 'pending', factStatus: fact.factStatus ?? 'active', createdAtMs: fact.createdAt }))
  const context = (turnId: string, messageId: string, signal: AbortSignal): MemoryInteractionContext => {
    const sessionId = options.store.scope.sessionId
    return { scope, sessionId, turnId, sourceContext: { sessionId, messageId, neighbors: [] },
      isCurrent: () => !closed && !options.held() && !signal.aborted && options.store.scope.sessionId === sessionId }
  }
  const rememberedByTurn = new Map<string, MemoryReadReference[]>()
  return {
    runtime, refresh, factViews,
    experiencePolicy: () => structuredClone(experiencePolicy),
    operations: () => structuredClone(operations),
    bind: (requestId: string, turnId: string) => { const references = rememberedByTurn.get(requestId); if (references) { rememberedByTurn.set(turnId, references); rememberedByTurn.delete(requestId) } },
    disclose: (requestId: string, references: readonly MemoryReadReference[]) => {
      rememberedByTurn.set(requestId, references.filter(ref => fragments.some(fact => fact.id === ref.id && fact.revision === ref.revision && visible(fact))).slice(0, 32))
      if (rememberedByTurn.size > 64) rememberedByTurn.delete(rememberedByTurn.keys().next().value!)
    },
    pendingSources: () => seenFragments(history(), true, true).filter(source => !Object.hasOwn(handled.value, source.key)
      && source.origin !== 'tool' && source.origin !== 'mail' && source.origin !== 'document'),
    lastExtractedAt: () => extractedAt.value,
    /** One original successful input is captured once, regardless of subsequent
     * recall, compaction, checkpoints or other derived references. */
    async capture(sources: readonly SeenFragment[], model: MemoryCaptureModel, signal: AbortSignal) {
      for (const source of sources) {
        signal.throwIfAborted()
        if (Object.hasOwn(handled.value, source.key) || !sourceStillAllowed(source)) continue
        const stop = () => runtime.revoke()
        signal.addEventListener('abort', stop, { once: true })
        try {
          let modelError: unknown
          await runtime.captureTurn({ scope, sessionId: source.sessionId, userText: source.role === 'user' ? source.text : '',
            assistantText: source.role === 'assistant' ? source.text : '', sourceContext: { sessionId: source.sessionId, messageId: sourceId(source), neighbors: [], sourceType: 'successful-input' } },
          async (input, inner) => {
            const combined = AbortSignal.any([signal, inner ?? signal])
            try { return await cancellable(() => model.extract(input, combined), combined) }
            catch (error) { modelError = error; throw error }
          }, () => !signal.aborted && sourceStillAllowed(source), model.reconcile)
          signal.throwIfAborted()
          if (modelError) throw modelError instanceof MemoryFailure ? modelError : new MemoryFailure('connection-failed')
          if (runtime.databaseStatus.value !== 'ready') throw new MemoryFailure('unavailable')
          if (runtime.captureError.value) throw new MemoryFailure('memory-invalid-output')
          if (!sourceStillAllowed(source)) throw new MemoryFailure('unavailable')
          handled.value = { ...handled.value, [source.key]: options.clock.nowMs() }
          extractedAt.value = options.clock.nowMs()
        } finally { signal.removeEventListener('abort', stop) }
      }
      await refresh()
    },
    async directory() {
      await refresh()
      return buildMemoryDirectory(runtime.directoryEnabled.value ? fragments.filter(fact => visible(fact)) : [])
    },
    async search(query: string, requestId: string) {
      const matches = (await runtime.retrieve(query, options.store.scope.sessionId, { scope })).filter(fact => visible(fact))
      rememberedByTurn.set(requestId, matches.map(fact => ({ id: fact.id, revision: fact.revision ?? 1 })))
      if (rememberedByTurn.size > 64) rememberedByTurn.delete(rememberedByTurn.keys().next().value!)
      await refresh()
      return matches.map(fact => ({ id: fact.id, revision: fact.revision ?? 1, text: fact.content.slice(0, 2000), title: fact.title ?? '', summary: fact.summary ?? '',
        tier: fact.memoryType, reviewStatus: fact.reviewStatus, factStatus: fact.factStatus, atMs: fact.lastAccessed,
        source: fact.sourceContext ? { sessionId: fact.sourceContext.sessionId, messageId: fact.sourceContext.messageId } : null }))
    },
    async read(turnId: string, messageId: string, requests: readonly { id: string; offset: number }[], signal: AbortSignal) {
      await refresh()
      const references = [...(rememberedByTurn.get(turnId) ?? []), ...await runtime.confirmedReferences(scope, options.store.scope.sessionId)]
        .filter(ref => fragments.some(fact => fact.id === ref.id && visible(fact)))
      return runtime.readBodies(context(turnId, messageId, signal), references, requests)
    },
    async propose(turnId: string, messageId: string, operationId: string, proposal: MemoryProposal, signal: AbortSignal) {
      const result = await runtime.proposeOperation(context(turnId, messageId, signal), operationId, proposal)
      await refresh(); return result
    },
    async review(operationId: string, approve: boolean) { const result = await runtime.confirmOperation(scope, operationId, approve); await refresh(); return result },
    async reviewFact(id: string, expectedRevision: number, approve: boolean) {
      await refresh()
      const fact = fragments.find(item => item.id === id && visible(item))
      if (!fact || fact.revision !== expectedRevision) throw new Error('MEMORY_REVISION_CHANGED')
      await runtime.setReviewStatus(id, approve ? 'approved' : 'rejected', { scope, revision: expectedRevision }); await refresh()
    },
    async presentation(input: Parameters<typeof runtime.editPresentation>[1]) { const result = await runtime.editPresentation(scope, input); await refresh(); return result },
    status: (): MemoryEngineStatus => ({ engine: 'airi-duckdb', state: closed ? 'closed' : runtime.databaseStatus.value === 'ready' ? 'ready' : runtime.databaseStatus.value === 'error' ? 'failed' : 'opening',
      checkpointAt: runtime.databasePersistenceStatus.value.lastCheckpointAt ?? null, pendingOperations: operations.filter(item => item.status === 'pending_review').length,
      embedding: { state: !options.embedding() ? 'unconfigured' : runtime.embeddingMigration.value.state === 'running' ? 'migrating' : runtime.embeddingError.value || runtime.embeddingMigration.value.state === 'error' ? 'failed' : runtime.embeddingMigration.value.state === 'complete' ? 'ready' : 'unconfigured',
        remaining: Math.max(0, runtime.embeddingMigration.value.total - runtime.embeddingMigration.value.nextIndex) },
      mirror: { state: options.held() ? 'held' : runtime.remoteStatus.value === 'ready' ? 'ready' : runtime.remoteStatus.value === 'error' ? 'offline' : 'unconfigured', pending: runtime.longTermSyncOutbox.value.length },
      failure: runtime.databaseStatus.value === 'error' ? 'storage' : runtime.captureError.value ? 'reconciliation' : runtime.embeddingError.value ? 'embedding' : runtime.remoteStatus.value === 'error' ? 'mirror' : null }),
    foreground: () => runtime.revoke(),
    async close() { closed = true; rememberedByTurn.clear(); await engine.dispose() },
  }
}

export type MemoryFacts = ReturnType<typeof createMemoryFacts>

async function cancellable<T>(action: () => Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted()
  let remove = () => {}
  try {
    return await Promise.race([action(), new Promise<never>((_resolve, reject) => {
      const stop = () => reject(new MemoryFailure('unavailable'))
      signal.addEventListener('abort', stop, { once: true }); remove = () => signal.removeEventListener('abort', stop)
      if (signal.aborted) stop()
    })])
  } finally { remove() }
}
