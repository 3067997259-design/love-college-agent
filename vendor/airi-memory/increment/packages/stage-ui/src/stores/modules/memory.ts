import type { MemoryDreamIdea, MemoryDreamIdeaStatus, MemoryEmbeddingMetadata, MemoryEmbeddingQueryMetadata, MemoryExtraction, MemoryFragment, MemoryMood, MemoryOperation, MemoryPresentation, MemoryProposal, MemoryRepository, MemoryScope, MemoryScoreWeights, MemorySourceContext, MemorySubscriptionEvent, ScoredMemoryFragment } from '@proj-airi/memory-core'

import type { MemoryInteractionRepository } from '../../services/memory/interaction-repository'
import type { MemoryInteractionContext, MemoryReadReference } from '../../services/memory/interactions'
import type { MemoryReconciler, ReconciledMemoryExtraction } from '../../services/memory/reconciliation'

import { errorMessageFrom } from '@moeru/std'
import { buildMemoryDirectory, canTransitionDreamIdea, emotionToMood, isActionableMemoryFragment, isInteractiveFact, isSameMemoryScope, matchesMuscleMemory, memoryEventToExtraction, memoryPresentationOf, normalizeMemoryRetrievalQuery, scoreMemoryFragment, selectDreamSourceFragments, selectIntrusiveMemory } from '@proj-airi/memory-core'
import { useLocalStorageManualReset } from '@proj-airi/stage-shared/composables'
import { defineStore } from 'pinia'
import { computed, onScopeDispose, shallowRef, watch } from 'vue'

import { editMemoryPresentation, proposeMemoryOperation, readMemoryBodies, reviewMemoryOperation } from '../../services/memory/interactions'
import { isExtractionSourceCurrent, reconcileMemoryExtractions } from '../../services/memory/reconciliation'
import { resolveMemoryWriteAccess } from '../../services/memory/write-access'
import { areRestoreEffectsHeld, waitForRestore } from '../../services/restore-gate'
import { useAuthStore } from '../auth'
import { useJournalStore } from '../journal'

export interface MemoryTurnInput {
  sessionId: string
  userText: string
  assistantText: string
  scope: MemoryScope
  sourceContext?: MemorySourceContext
  /** Already handled facts from this exact source message, including rejected proposals. */
  handledOperations?: MemoryOperation[]
}

export type MemoryTurnExtractor = (input: MemoryTurnInput & { mood: MemoryMood }, signal?: AbortSignal) => Promise<MemoryExtraction[]>

export interface MemoryDreamAgentInput {
  fragments: MemoryFragment[]
  ideas: MemoryDreamIdea[]
}

/** Identity that owns one production retrieval evaluation run. */
export interface MemoryProductionEvaluationContext {
  profileId: string
  sessionId: string
  scope: MemoryScope
}

/** Mutable capture boundary for MQ-0's production retrieval evaluation. */
interface MemoryRetrievalTraceCapture {
  originalQuery?: string
  normalizedQuery?: string
  originalCandidateIds?: string[]
  normalizedCandidateIds?: string[]
  normalizedQueryCalled?: boolean
  queryTokenCount?: number
  normalizedQueryTokenCount?: number
}

function evaluationMemoryId(fragment: Pick<MemoryFragment, 'id' | 'originId'>): string {
  return fragment.originId ?? fragment.id
}

export interface MemoryDreamProposal {
  content: string
  sourceId?: string
  excitement?: number
}

export type MemoryFactRevisionRelation = 'supersedes' | 'disputes'

export type MemoryDreamAgent = (input: MemoryDreamAgentInput) => Promise<MemoryDreamProposal[]>

export type AutomaticDreamSkipReason
  = | 'disabled'
    | 'not-leader'
    | 'already-running'
    | 'budget'
    | 'cooldown'
    | 'insufficient-new-memory'
    | 'database-unavailable'

export interface AutomaticDreamResult {
  /** Whether the pass ran or was stopped by a structural gate. */
  status: 'ran' | 'skipped'
  /** Gate reason when the pass did not run. */
  reason?: AutomaticDreamSkipReason
  /** Number of newly persisted ideas, when the pass ran. */
  addedCount?: number
}

let dreamAgent: MemoryDreamAgent | undefined

/** Installs the optional model-backed dreaming callback without coupling memory to a provider. */
export function installMemoryDreamAgent(next: MemoryDreamAgent | undefined): void {
  dreamAgent = next
}

/** Shape of the main-process long-term store status (MAINTENANCE-PLAN P2.4). */
export interface MemoryHostStatusLike {
  status: 'unconfigured' | 'ready' | 'error'
  error?: string
}

export interface MemoryDatabasePersistenceStatus {
  state: 'idle' | 'checkpointing' | 'complete' | 'error'
  pendingWrites: number
  lastCheckpointAt?: number
  error?: string
}

export interface MemoryEmbeddingMigrationState {
  sourceFingerprint: string
  ids: string[]
  nextIndex: number
  total: number
  state: 'idle' | 'running' | 'complete' | 'error'
  lastError?: string
  updatedAt: number
}

/**
 * Renderer-side port to the long-term Postgres store owned by the Electron
 * main process. Embeddings are computed in the renderer (the embed worker is
 * browser-only) and shipped alongside the fragment.
 */
export interface MemoryHostPort {
  configure: (params: { connectionString?: string }) => Promise<MemoryHostStatusLike>
  getStatus: () => Promise<MemoryHostStatusLike>
  list: (params?: { memoryType?: string, reviewStatus?: string, limit?: number, scope?: MemoryScope }) => Promise<Array<{ id: string, content: string, memoryType: string, category: string, importance: number, createdAt: number, lastAccessed: number, accessCount: number, reviewStatus?: string, sessionIds?: string[], scope?: MemoryScope, sourceContext?: MemorySourceContext, score?: number }>>
  search: (params: { embedding: number[], limit?: number, weights?: { similarity?: number, timeRelevance?: number, arousal?: number, accessCount?: number, moodCongruence?: number }, embeddingMetadata?: MemoryEmbeddingQueryMetadata, scope?: MemoryScope }) => Promise<Array<{ id: string, content: string, memoryType: string, category: string, importance: number, createdAt: number, lastAccessed: number, accessCount: number, reviewStatus?: string, sessionIds?: string[], scope?: MemoryScope, sourceContext?: MemorySourceContext, score?: number }>>
  insert: (params: MemoryPresentation & { content: string, memoryType: string, category: string, importance?: number, valence?: number, arousal?: number, halfLifeHours?: number, sessionId?: string, scope?: MemoryScope, sourceContext?: MemorySourceContext, reviewStatus?: string, factStatus?: string, supersedesId?: string, conflictGroup?: string, embedding?: number[], embeddingMetadata?: MemoryEmbeddingMetadata, now?: number, originId?: string }) => Promise<{ id: string, originId?: string }>
  update: (params: { originId: string, patch: MemoryPresentation & { content?: string, category?: string, importance?: number, reviewStatus?: string, factStatus?: string, supersedesId?: string, conflictGroup?: string, embedding?: number[], embeddingMetadata?: MemoryEmbeddingMetadata } }) => Promise<unknown>
  remove: (params: { originId: string }) => Promise<unknown>
}

/**
 * One pending mirroring operation. The local layer is authoritative and the
 * remote store is a mirror, so ops carry absolute state patches from the
 * local fact, never deltas: redelivering the same op is idempotent, and the
 * FIFO order of this persisted queue is what keeps remote state converging.
 */
export type LongTermSyncKind = 'insert' | 'update' | 'delete'

export interface LongTermSyncItem extends MemoryPresentation {
  kind: LongTermSyncKind
  originId: string
  /** Receipt acknowledged only after the existing outbox confirms remote invalidation. */
  operationId?: string
  /** Fact body; only meaningful for `insert` ops. */
  content?: string
  memoryType?: string
  category?: string
  importance?: number
  valence?: number
  arousal?: number
  halfLifeHours?: number
  sessionId?: string
  scope?: MemoryScope
  sourceContext?: MemorySourceContext
  reviewStatus?: string
  factStatus?: string
  supersedesId?: string
  conflictGroup?: string
  embedding?: number[]
  embeddingMetadata?: MemoryEmbeddingMetadata
  /** Absolute state patch for `update` ops; fields absent from it stay untouched remotely. */
  patch?: MemoryPresentation & {
    content?: string
    category?: string
    importance?: number
    reviewStatus?: string
    factStatus?: string
    supersedesId?: string
    conflictGroup?: string
    embedding?: number[]
    embeddingMetadata?: MemoryEmbeddingMetadata
  }
  attempts: number
  nextAttemptAt: number
  lastError?: string
  createdAt: number
}

let memoryHostPort: MemoryHostPort | undefined

/** Installs the Eventa-backed memory host client for this renderer process. */
export function installMemoryHostPort(next: MemoryHostPort | undefined): void {
  memoryHostPort = next
}

/**
 * Journal session that owns memory-browser operations (retrieval simulation
 * and manual migrations), so review actions stay auditable outside chat.
 */
export const MEMORY_BROWSER_SESSION_ID = 'settings-memory-browser'

/**
 * Whether a vector can ride along to the long-term mirror. Producers already
 * validate their dimension, so this only rejects shapes the stores cannot hold.
 */
function hasStorableVector(vector: number[] | undefined): boolean {
  return !!vector && (vector.length === 768 || vector.length === 1024 || vector.length === 1536)
}

function copyMemoryScope(scope: MemoryScope | undefined): MemoryScope | undefined {
  return scope ? { userId: scope.userId, characterId: scope.characterId } : undefined
}

function copyMemorySourceContext(sourceContext: MemorySourceContext | undefined): MemorySourceContext | undefined {
  if (!sourceContext)
    return undefined

  return {
    sessionId: sourceContext.sessionId,
    ...(sourceContext.messageId ? { messageId: sourceContext.messageId } : {}),
    ...(sourceContext.sourceEventId ? { sourceEventId: sourceContext.sourceEventId } : {}),
    ...(sourceContext.sourceType ? { sourceType: sourceContext.sourceType } : {}),
    ...(sourceContext.gameWorld ? { gameWorld: { ...sourceContext.gameWorld } } : {}),
    neighbors: [...sourceContext.neighbors],
  }
}

function copyMemoryEmbeddingMetadata(metadata: MemoryEmbeddingMetadata | undefined): MemoryEmbeddingMetadata | undefined {
  return metadata
    ? {
        embeddingProvider: metadata.embeddingProvider,
        embeddingModel: metadata.embeddingModel,
        embeddingDimensions: metadata.embeddingDimensions,
        embeddingInputType: metadata.embeddingInputType,
        embeddingSourceFingerprint: metadata.embeddingSourceFingerprint,
        embeddedAt: metadata.embeddedAt,
        embeddingStatus: metadata.embeddingStatus,
      }
    : undefined
}

/**
 * Upper bound on eligible rows one social-consideration scan may hold.
 *
 * Eligibility runs in the repository query, so this is a memory bound rather
 * than the candidate window it used to be (ACC-20260911 #12).
 */
const SHAREABLE_FACT_SCAN_LIMIT = 1_000

/** Stores memory settings and provides a local DuckDB repository to stage. */
export const useMemoryStore = defineStore('memory', () => {
  const authStore = useAuthStore()
  const repository = shallowRef<MemoryInteractionRepository>()
  // Shared health describes the leader's database. Settings windows need its
  // readiness for leader-routed actions; they must never publish local handle
  // status over it. Per-window ownership comes from isLeader below.
  const databaseStatus = shallowRef<'idle' | 'ready' | 'error'>('idle')
  const databaseError = shallowRef<string>()
  const currentMood = shallowRef<MemoryMood>({ valence: 0, arousal: 0 })
  // Per-window identity: NEVER part of synced state. When writeAccess was a
  // returned ref, the leader broadcast its 'leader' value into follower
  // windows, whose live location check then correctly refused the open —
  // surfacing the guard error in every memory layer of every window.
  const isLeader = computed(() => resolveMemoryWriteAccess() === 'leader')

  const enabled = useLocalStorageManualReset('settings/memory/enabled', false, { listenToStorageChanges: false })
  const captureEnabled = useLocalStorageManualReset('settings/memory/capture-enabled', false, { listenToStorageChanges: false })
  const directoryEnabled = shallowRef(isLeader.value && localStorage.getItem('settings/memory/directory-enabled') === 'true')
  const toolsEnabled = shallowRef(isLeader.value && localStorage.getItem('settings/memory/tools-enabled') === 'true')
  const factsRevision = shallowRef(0)
  let authorityEpoch = 0
  const captures = new Set<AbortController>()
  onScopeDispose(() => {
    for (const capture of captures)
      capture.abort(new Error('Memory store disposed'))
  })
  watch(() => authStore.userId, () => {
    authorityEpoch += 1
  }, { flush: 'sync' })

  /** Only the leader persists these settings. Remote snapshots never write localStorage. */
  async function setInteractionSettings(input: { directoryEnabled: boolean, toolsEnabled: boolean }): Promise<void> {
    if (!isLeader.value)
      throw new Error('Only the memory leader can persist interaction settings')
    localStorage.setItem('settings/memory/directory-enabled', String(input.directoryEnabled))
    localStorage.setItem('settings/memory/tools-enabled', String(input.toolsEnabled))
    directoryEnabled.value = input.directoryEnabled
    toolsEnabled.value = input.toolsEnabled
  }
  const compactionEnabled = useLocalStorageManualReset('settings/memory/compaction-enabled', true, { listenToStorageChanges: false })
  const activeProvider = useLocalStorageManualReset('settings/memory/active-provider', '', { listenToStorageChanges: false })
  const activeModel = useLocalStorageManualReset('settings/memory/active-model', '', { listenToStorageChanges: false })
  const compactionThreshold = useLocalStorageManualReset('settings/memory/compaction-threshold', 0.7, { listenToStorageChanges: false })
  const contextLengthOverride = useLocalStorageManualReset('settings/memory/context-length-override', 0, { listenToStorageChanges: false })
  const compactionRecentTurnLimit = useLocalStorageManualReset('settings/memory/compaction-recent-turn-limit', 4, { listenToStorageChanges: false })
  const shortTermHalfLifeHours = useLocalStorageManualReset('settings/memory/short-term-half-life-hours', 24, { listenToStorageChanges: false })
  const longTermHalfLifeHours = useLocalStorageManualReset('settings/memory/long-term-half-life-hours', 4_320, { listenToStorageChanges: false })
  const promotionAccessCount = useLocalStorageManualReset('settings/memory/promotion-access-count', 3, { listenToStorageChanges: false })
  const promotionSessionCount = useLocalStorageManualReset('settings/memory/promotion-session-count', 2, { listenToStorageChanges: false })
  const weightSimilarity = useLocalStorageManualReset('settings/memory/weight-similarity', 1.2, { listenToStorageChanges: false })
  const weightTimeRelevance = useLocalStorageManualReset('settings/memory/weight-time-relevance', 0.2, { listenToStorageChanges: false })
  const weightArousal = useLocalStorageManualReset('settings/memory/weight-arousal', 0.3, { listenToStorageChanges: false })
  const weightAccessCount = useLocalStorageManualReset('settings/memory/weight-access-count', 0.15, { listenToStorageChanges: false })
  const weightMoodCongruence = useLocalStorageManualReset('settings/memory/weight-mood-congruence', 0.25, { listenToStorageChanges: false })
  const intrusionEnabled = useLocalStorageManualReset('settings/memory/intrusion-enabled', false, { listenToStorageChanges: false })
  const intrusionBaseRate = useLocalStorageManualReset('settings/memory/intrusion-base-rate', 0.02, { listenToStorageChanges: false })
  const intrusionCooldownMs = useLocalStorageManualReset('settings/memory/intrusion-cooldown-ms', 30_000, { listenToStorageChanges: false })
  const dreamingEnabled = useLocalStorageManualReset('settings/memory/dreaming-enabled', false, { listenToStorageChanges: false })
  const automaticDreamingEnabled = useLocalStorageManualReset('settings/memory/automatic-dreaming-enabled', false, { listenToStorageChanges: false })
  const dreamingIntervalHours = useLocalStorageManualReset('settings/memory/dreaming-interval-hours', 24, { listenToStorageChanges: false })
  const dreamingDailyBudget = useLocalStorageManualReset('settings/memory/dreaming-daily-budget', 1, { listenToStorageChanges: false })
  const dreamingMinNewMemoryCount = useLocalStorageManualReset('settings/memory/dreaming-min-new-memory-count', 3, { listenToStorageChanges: false })
  const lastDreamAt = useLocalStorageManualReset('settings/memory/last-dream-at', 0, { listenToStorageChanges: false })
  const dreamingBudgetUsed = useLocalStorageManualReset('settings/memory/dreaming-budget-used', 0, { listenToStorageChanges: false })
  const dreamingBudgetDateKey = useLocalStorageManualReset('settings/memory/dreaming-budget-date-key', '', { listenToStorageChanges: false })
  const longTermSyncEnabled = useLocalStorageManualReset('settings/memory/long-term-sync-enabled', false, { listenToStorageChanges: false })
  const embeddingSource = useLocalStorageManualReset<'local' | 'api'>('settings/memory/embedding-source', 'local', { listenToStorageChanges: false })
  const embeddingBaseUrl = useLocalStorageManualReset('settings/memory/embedding-base-url', '', { listenToStorageChanges: false })
  const embeddingApiKey = useLocalStorageManualReset('settings/memory/embedding-api-key', '', { listenToStorageChanges: false })
  const embeddingModel = useLocalStorageManualReset('settings/memory/embedding-model', 'text-embedding-3-small', { listenToStorageChanges: false })
  // Fingerprint of the vector space the stored embeddings were produced in.
  // Empty means "legacy local worker", which every pre-config database used.
  const embeddingFingerprint = useLocalStorageManualReset('settings/memory/embedding-fingerprint', '', { listenToStorageChanges: false })
  const embeddingMigration = useLocalStorageManualReset<MemoryEmbeddingMigrationState>('settings/memory/embedding-migration', {
    sourceFingerprint: '',
    ids: [],
    nextIndex: 0,
    total: 0,
    state: 'idle',
    updatedAt: 0,
  }, { listenToStorageChanges: false })
  const embeddingError = shallowRef<string>()
  // This renderer owns capture failures. The computed return value keeps
  // transient model status outside the synchronized settings snapshot.
  const captureFailure = shallowRef<string>()
  const longTermSyncOutbox = useLocalStorageManualReset<LongTermSyncItem[]>('settings/memory/long-term-sync-outbox', [], { listenToStorageChanges: false })
  const lastLongTermSyncAt = useLocalStorageManualReset('settings/memory/last-long-term-sync-at', 0, { listenToStorageChanges: false })
  const lastLongTermSyncError = useLocalStorageManualReset('settings/memory/last-long-term-sync-error', '', { listenToStorageChanges: false })
  const pgConnectionString = useLocalStorageManualReset('settings/memory/pg-connection-string', '', { listenToStorageChanges: false })
  // MQ-2 D1c: the anonymous `local` history stays visible after sign-in unless
  // the user unlinks it. Character identity is still enforced by the scope
  // filter; this only widens the user dimension for retrieval.
  const linkLocalHistory = useLocalStorageManualReset('settings/memory/link-local-history', true, { listenToStorageChanges: false })
  const remoteStatus = shallowRef<'unconfigured' | 'ready' | 'error'>('unconfigured')
  const remoteError = shallowRef<string>()
  const databasePersistenceStatus = shallowRef<MemoryDatabasePersistenceStatus>({ state: 'idle', pendingWrites: 0 })
  const dreamIdeas = shallowRef<MemoryDreamIdea[]>([])
  const dreaming = shallowRef(false)
  let databaseControl: { persistenceStatus?: { value: MemoryDatabasePersistenceStatus }, checkpointDb?: () => Promise<MemoryDatabasePersistenceStatus>, closeDb?: () => Promise<unknown> } | undefined

  /**
   * Marks the database unavailable and drops the cached connection.
   *
   * A failed query can leave the WASM connection broken (`'peek' of
   * undefined`), and every later call reused the same broken instance until
   * the app restarted (ACC-20260911 #16). Closing and forgetting it makes the
   * next operation reopen the OPFS-backed database; the status stays 'error'
   * until one succeeds.
   */
  async function resetDatabaseAfterError(error: unknown, fallback: string): Promise<void> {
    databaseStatus.value = 'error'
    databaseError.value = errorMessageFrom(error) ?? fallback
    repository.value = undefined
    try {
      await databaseControl?.closeDb?.()
    }
    catch {
      // closeDb nulls its own reference even when the checkpoint fails; the
      // next open is the recovery.
    }
  }

  const configured = computed(() => enabled.value)

  /**
   * Installs the embedding backend matching the current settings; local
   * worker is the fallback. The endpoint credentials live here rather than in
   * the provider system: the providers page allows only one openai-compatible
   * instance, and the chat relay usually cannot serve embeddings.
   *
   * Returns whether a usable source is installed — a failed API install must
   * NOT trigger the vector-space migration, or a typo while typing the key
   * would re-embed every stored vector into the local space.
   */
  async function applyEmbeddingSource(): Promise<boolean> {
    embeddingError.value = undefined
    // Dynamic import keeps the browser-only embedding worker out of the
    // module graph of Node consumers that only need the memory settings.
    const { createApiMemoryEmbeddingSource, installMemoryEmbeddingSource } = await import('../../services/memory/local-memory-embedding')
    if (embeddingSource.value !== 'api') {
      installMemoryEmbeddingSource(undefined)
      return true
    }

    try {
      if (!embeddingBaseUrl.value.trim() || !embeddingApiKey.value.trim())
        throw new Error('Embedding base URL and API key are required')
      installMemoryEmbeddingSource(createApiMemoryEmbeddingSource({
        baseUrl: embeddingBaseUrl.value.trim(),
        apiKey: embeddingApiKey.value.trim(),
        model: embeddingModel.value,
      }))
      return true
    }
    catch (error) {
      installMemoryEmbeddingSource(undefined)
      embeddingError.value = errorMessageFrom(error) ?? 'Unknown embedding configuration error'
      return false
    }
  }

  /**
   * Re-embeds every stored vector when the embedding space changed.
   *
   * Vectors from different spaces cannot be compared by cosine similarity, so
   * a model switch without this migration would silently break recall. An
   * empty fingerprint marks a pre-config database whose vectors all came from
   * the legacy local worker; recording the space is enough there. Skipped
   * entirely when the configured source failed to install, keeping the old
   * vectors intact until the configuration works again.
   */
  async function checkpointMemoryDb(): Promise<void> {
    if (!databaseControl?.checkpointDb)
      return
    try {
      databasePersistenceStatus.value = await databaseControl.checkpointDb()
    }
    catch (error) {
      databasePersistenceStatus.value = {
        state: 'error',
        pendingWrites: 1,
        error: errorMessageFrom(error) ?? 'Memory database checkpoint failed',
      }
      throw error
    }
  }

  function embeddingMatches(fragment: MemoryFragment, metadata: MemoryEmbeddingMetadata): boolean {
    return fragment.contentVector?.length === metadata.embeddingDimensions
      && fragment.embeddingProvider === metadata.embeddingProvider
      && fragment.embeddingModel === metadata.embeddingModel
      && fragment.embeddingDimensions === metadata.embeddingDimensions
      && fragment.embeddingInputType === 'document'
      && fragment.embeddingSourceFingerprint === metadata.embeddingSourceFingerprint
      && fragment.embeddingStatus === 'active'
  }

  async function migrateEmbeddingSpace(memoryRepository: MemoryInteractionRepository, sourceReady: boolean, force = false): Promise<void> {
    if (!sourceReady)
      return

    const { activeMemoryEmbeddingFingerprint, activeMemoryEmbeddingMetadata, embedMemoryText } = await import('../../services/memory/local-memory-embedding')
    const currentFingerprint = activeMemoryEmbeddingFingerprint()
    const fragments = await memoryRepository.list({ limit: 10_000 })
    const existingState = embeddingMigration.value
    const currentDimensions = fragments.find(fragment => fragment.contentVector)?.contentVector?.length ?? 768
    const currentMetadata = activeMemoryEmbeddingMetadata({ kind: 'document', dimensions: currentDimensions })
    const needsMigration = fragments.filter(fragment => (force && fragment.content.trim().length > 0)
      || (fragment.contentVector && !embeddingMatches(fragment, currentMetadata))
      || (!fragment.contentVector && fragment.content.trim().length > 0))

    let state = existingState
    if (state.sourceFingerprint !== currentFingerprint || state.total !== needsMigration.length || state.ids.some(id => !needsMigration.some(fragment => fragment.id === id))) {
      state = {
        sourceFingerprint: currentFingerprint,
        ids: needsMigration.map(fragment => fragment.id),
        nextIndex: 0,
        total: needsMigration.length,
        state: needsMigration.length > 0 ? 'idle' : 'complete',
        updatedAt: Date.now(),
      }
      embeddingMigration.value = state
    }

    if (state.total === 0) {
      embeddingFingerprint.value = currentFingerprint
      return
    }

    const byId = new Map(fragments.map(fragment => [fragment.id, fragment]))
    state = { ...state, state: 'running', lastError: undefined, updatedAt: Date.now() }
    embeddingMigration.value = state

    try {
      for (let start = state.nextIndex; start < state.ids.length; start += 20) {
        const batch = state.ids.slice(start, start + 20)
        // Mark the batch stale before embedding. If the renderer stops during
        // this loop, the next boot cannot use a half-migrated vector space.
        for (const id of batch) {
          if (byId.has(id))
            await memoryRepository.update(id, { embeddingStatus: 'stale' })
        }
        for (const id of batch) {
          const fragment = byId.get(id)
          if (!fragment)
            continue
          const vector = await embedMemoryText(fragment.content, 'document')
          await memoryRepository.updateEmbedding(id, fragment.revision ?? 1, vector, activeMemoryEmbeddingMetadata({ kind: 'document', dimensions: vector.length }))
        }
        await checkpointMemoryDb()
        state = { ...state, nextIndex: start + batch.length, updatedAt: Date.now() }
        embeddingMigration.value = state
      }
      state = { ...state, state: 'complete', updatedAt: Date.now() }
      embeddingMigration.value = state
      embeddingFingerprint.value = currentFingerprint
    }
    catch (error) {
      state = {
        ...state,
        state: 'error',
        lastError: errorMessageFrom(error) ?? 'Embedding migration failed',
        updatedAt: Date.now(),
      }
      embeddingMigration.value = state
      throw error
    }
  }

  /** Re-embeds every local memory in bounded batches using the active source. */
  async function reembedMemoryVectors(): Promise<void> {
    const memoryRepository = await initialize()
    if (!memoryRepository)
      return

    const sourceReady = await applyEmbeddingSource()
    if (!sourceReady)
      return

    const { activeMemoryEmbeddingFingerprint } = await import('../../services/memory/local-memory-embedding')
    embeddingMigration.value = {
      sourceFingerprint: activeMemoryEmbeddingFingerprint(),
      ids: [],
      nextIndex: 0,
      total: 0,
      state: 'idle',
      updatedAt: Date.now(),
    }
    await migrateEmbeddingSpace(memoryRepository, true, true)
  }

  async function initialize() {
    await waitForRestore()
    if (repository.value)
      return repository.value

    // Single-writer rule: the DuckDB OPFS store permits exactly one
    // synchronous access handle per file. Follower renderers must not open
    // the database read-write, or the leader's handle fails with
    // createSyncAccessHandle conflicts (MEMORY-DESIGN §1.4 fix).
    if (!isLeader.value) {
      // This window owns no database handle. A local status mutation here
      // would propose the whole store before its first remote snapshot,
      // overwriting restored settings with this follower's defaults.
      return undefined
    }

    try {
      // Keep the browser-only DuckDB worker out of Node consumers that only
      // need the memory settings or subscription boundary. The database is
      // loaded only when a memory operation is explicitly initialized.
      const [{ useDuckDb }, { createDuckDbMemoryRepository }] = await Promise.all([
        import('../../composables/use-duck-db'),
        import('../../services/memory/local-memory'),
      ])
      const database = useDuckDb()
      databaseControl = database
      if (database.persistenceStatus?.value)
        databasePersistenceStatus.value = database.persistenceStatus.value
      await database.getDb()
      if (!database.db.value)
        throw new Error('DuckDB did not return a database instance')

      repository.value = createDuckDbMemoryRepository(database.db.value, database.transaction)
      // Startup validation runs after the restore gate and database ownership
      // are settled. Installation checks settings only; it makes no requests.
      // A missing embedding credential does not make fact storage unhealthy.
      try {
        await applyEmbeddingSource()
      }
      catch (error) {
        // A failed optional module import must not close the fact database.
        embeddingError.value = errorMessageFrom(error) ?? 'Memory embedding is unavailable'
      }
      databaseStatus.value = 'ready'
      databaseError.value = undefined
      return repository.value
    }
    catch (error) {
      await resetDatabaseAfterError(error, 'Unknown memory database error')
      return undefined
    }
  }

  let vectorInitialization: Promise<boolean> | undefined
  let backgroundVectorsReady = false
  /** Vector failures leave the fact database available for review and exact-ID reads. */
  async function initializeVectors(memoryRepository: MemoryInteractionRepository): Promise<boolean> {
    if (vectorInitialization)
      return vectorInitialization
    vectorInitialization = (async () => {
      try {
        const ready = await applyEmbeddingSource()
        await migrateEmbeddingSpace(memoryRepository, ready)
        await refreshRemoteHostStatus()
        return ready && embeddingMigration.value.state !== 'error'
      }
      catch (error) {
        embeddingError.value = errorMessageFrom(error) ?? 'Memory vectors are unavailable'
        return false
      }
    })()
    try {
      return await vectorInitialization
    }
    finally {
      vectorInitialization = undefined
    }
  }

  /** Reads the bounded directory without starting an embedding provider or recording access. */
  async function directory(scope: MemoryScope, budget?: number) {
    if (!enabled.value || !directoryEnabled.value)
      return buildMemoryDirectory([])
    const memoryRepository = await initialize()
    if (!memoryRepository)
      return buildMemoryDirectory([])
    const fragments = await memoryRepository.directory(scope, linkedUserIdsForScope(scope))
    return buildMemoryDirectory(enabled.value && directoryEnabled.value ? fragments : [], budget)
  }

  /** Revalidates IDs disclosed by this session's durable, approved operation receipts. */
  async function confirmedReferences(scope: MemoryScope, sessionId: string): Promise<MemoryReadReference[]> {
    if (!enabled.value || !toolsEnabled.value || authStore.userId !== scope.userId)
      return []
    const memoryRepository = await initialize()
    if (!memoryRepository)
      return []
    const references: MemoryReadReference[] = []
    for (const operation of await memoryRepository.operations(scope, sessionId)) {
      if (operation.status !== 'applied' || !operation.fragmentId)
        continue
      const fragment = await memoryRepository.get(operation.fragmentId)
      if (fragment && isInteractiveFact(fragment) && isSameMemoryScope(fragment.scope, scope))
        references.push({ id: fragment.id, revision: fragment.revision ?? 1 })
    }
    return references
  }

  async function proposeOperation(context: MemoryInteractionContext, operationId: string, proposal: MemoryProposal): Promise<MemoryOperation> {
    if (!enabled.value || !toolsEnabled.value)
      throw new Error('Memory interaction is disabled')
    const memoryRepository = await initialize()
    if (!memoryRepository)
      throw new Error('Memory database is unavailable')
    const result = await proposeMemoryOperation(memoryRepository, context, operationId, proposal)
    // A checkpoint failure leaves a queryable receipt. The caller must report
    // outcome_unknown, then reconcile by operationId rather than repeat writes.
    await checkpointMemoryDb()
    return result
  }

  async function operationStatus(operationId: string, scope: MemoryScope) {
    const result = await (await initialize())?.operation(operationId)
    return result && isSameMemoryScope(result.scope, scope) ? result : undefined
  }

  async function listOperations(scope: MemoryScope, sessionId?: string) {
    if (authStore.userId !== scope.userId)
      return []
    return (await initialize())?.operations(scope, sessionId) ?? []
  }

  async function confirmOperation(scope: MemoryScope, operationId: string, approve: boolean) {
    const epoch = authorityEpoch
    const isCurrent = () => authorityEpoch === epoch && enabled.value && toolsEnabled.value && authStore.userId === scope.userId
    if (!isCurrent())
      throw new Error('Memory interaction is unavailable in this scope')
    const memoryRepository = await initialize()
    if (!memoryRepository)
      throw new Error('Memory database is unavailable')
    const result = await reviewMemoryOperation(memoryRepository, scope, operationId, approve, isCurrent)
    factsRevision.value += 1
    await recoverOperationMirrors(memoryRepository)
    await checkpointMemoryDb()
    return result
  }

  async function editPresentation(scope: MemoryScope, input: Parameters<typeof editMemoryPresentation>[2]) {
    const epoch = authorityEpoch
    const isCurrent = () => authorityEpoch === epoch && enabled.value && directoryEnabled.value && authStore.userId === scope.userId
    if (!isCurrent())
      throw new Error('Memory directory is unavailable in this scope')
    const memoryRepository = await initialize()
    if (!memoryRepository)
      throw new Error('Memory database is unavailable')
    const result = await editMemoryPresentation(memoryRepository, scope, input, isCurrent)
    factsRevision.value += 1
    if (result.memoryType === 'long_term')
      enqueueLongTermSyncUpdate(result.id, memoryPresentationOf(result))
    await checkpointMemoryDb()
    return result
  }

  async function readBodies(context: MemoryInteractionContext, references: readonly MemoryReadReference[], requests: readonly { id: string, offset: number }[]) {
    if (!enabled.value || !toolsEnabled.value)
      throw new Error('Memory interaction is disabled')
    const memoryRepository = await initialize()
    if (!memoryRepository)
      throw new Error('Memory database is unavailable')
    return readMemoryBodies(memoryRepository, context, references, requests, linkedUserIdsForScope(context.scope))
  }

  /** Counts only bodies that fit the final tool response, once per originating turn. */
  async function recordBodyReads(context: MemoryInteractionContext, readIds: string[], accessed: Set<string>) {
    const ids = [...new Set(readIds.filter(id => !accessed.has(id)))]
    if (!ids.length || !context.isCurrent())
      return
    const memoryRepository = await initialize()
    if (!memoryRepository)
      return
    await memoryRepository.transaction(async (tx) => {
      if (!context.isCurrent())
        throw new Error('Memory access revoked')
      await tx.recordAccess({ memoryIds: ids, sessionId: context.sessionId })
      if (!context.isCurrent())
        throw new Error('Memory access revoked')
    })
    ids.forEach(id => accessed.add(id))
    await checkpointMemoryDb()
  }

  function getScoreWeights(): MemoryScoreWeights {
    return {
      similarity: weightSimilarity.value,
      timeRelevance: weightTimeRelevance.value,
      arousal: weightArousal.value,
      accessCount: weightAccessCount.value,
      moodCongruence: weightMoodCongruence.value,
    }
  }

  /**
   * Extra user identities visible for retrieval in this installation (MQ-2 D1c).
   *
   * The anonymous `local` profile keeps its history after sign-in; the link is
   * a user setting and can be revoked. Character identity is never widened.
   */
  function linkedUserIdsForScope(scope: MemoryScope): string[] {
    if (!linkLocalHistory.value || scope.userId === 'local')
      return []
    return ['local']
  }

  async function retrieve(query: string, sessionId: string, options: { recordAccess?: boolean, scope: MemoryScope, trace?: MemoryRetrievalTraceCapture, similarityThreshold?: number }): Promise<ScoredMemoryFragment[]> {
    if (!enabled.value || !query.trim())
      return []

    const memoryRepository = await initialize()
    if (!memoryRepository)
      return []
    if (directoryEnabled.value || toolsEnabled.value) {
      // Ready persisted vectors must participate in the first turn. Bound
      // initialization separately so a worker download or bulk migration
      // cannot block the directory and exact-ID tools indefinitely.
      const initialization = initializeVectors(memoryRepository).then((ready) => {
        backgroundVectorsReady = ready
        return ready
      })
      if (!backgroundVectorsReady) {
        let timeout: ReturnType<typeof setTimeout> | undefined
        try {
          const ready = await Promise.race([
            initialization,
            new Promise<boolean>((resolve) => {
              timeout = setTimeout(() => {
                embeddingError.value = 'Memory vector initialization exceeded 3000 ms; directory remains available'
                resolve(false)
              }, 3000)
            }),
          ])
          if (!ready)
            return []
        }
        finally {
          clearTimeout(timeout)
        }
      }
    }
    else if (!await initializeVectors(memoryRepository)) {
      return []
    }

    try {
      const { activeMemoryEmbeddingMetadata, activeMemoryEmbeddingUsage, embedMemoryText } = await import('../../services/memory/local-memory-embedding')
      if (options.trace)
        options.trace.originalQuery = query
      const originalEmbedding = await embedWithInteractionBudget(query, 'query', embedMemoryText)
      if (!originalEmbedding)
        return []
      if (options.trace)
        options.trace.queryTokenCount = activeMemoryEmbeddingUsage()?.promptTokens
      const originalResults = await memoryRepository.search({
        embedding: originalEmbedding,
        embeddingMetadata: activeMemoryEmbeddingMetadata({ kind: 'query', dimensions: originalEmbedding.length }),
        mood: currentMood.value,
        weights: getScoreWeights(),
        limit: 3,
        scope: options.scope,
        linkedUserIds: linkedUserIdsForScope(options.scope),
        ...(options.similarityThreshold !== undefined ? { similarityThreshold: options.similarityThreshold } : {}),
      })
      if (options.trace)
        options.trace.originalCandidateIds = originalResults.map(evaluationMemoryId)
      const normalizedQuery = normalizeMemoryRetrievalQuery(query)
      if (options.trace)
        options.trace.normalizedQuery = normalizedQuery || undefined
      const normalizedResults = normalizedQuery && normalizedQuery !== query.trim()
        ? await (async () => {
            if (options.trace)
              options.trace.normalizedQueryCalled = true
            const embedding = await embedWithInteractionBudget(normalizedQuery, 'query', embedMemoryText)
            if (!embedding)
              return []
            if (options.trace)
              options.trace.normalizedQueryTokenCount = activeMemoryEmbeddingUsage()?.promptTokens
            return memoryRepository.search({
              embedding,
              embeddingMetadata: activeMemoryEmbeddingMetadata({ kind: 'query', dimensions: embedding.length }),
              mood: currentMood.value,
              weights: getScoreWeights(),
              limit: 3,
              scope: options.scope,
              linkedUserIds: linkedUserIdsForScope(options.scope),
              ...(options.similarityThreshold !== undefined ? { similarityThreshold: options.similarityThreshold } : {}),
            })
          })()
        : []
      if (options.trace && (!normalizedQuery || normalizedQuery === query.trim()))
        options.trace.normalizedQueryCalled = false
      if (options.trace && normalizedResults.length === 0 && normalizedQuery === query.trim())
        options.trace.normalizedQueryTokenCount = options.trace.queryTokenCount
      if (options.trace)
        options.trace.normalizedCandidateIds = normalizedResults.map(evaluationMemoryId)
      const mergedResults = new Map<string, ScoredMemoryFragment>()
      for (const result of originalResults) {
        mergedResults.set(result.id, {
          ...result,
          originalSimilarity: result.similarity,
          retrievalQuery: 'original',
        })
      }
      for (const result of normalizedResults) {
        const previous = mergedResults.get(result.id)
        if (!previous) {
          mergedResults.set(result.id, {
            ...result,
            normalizedSimilarity: result.similarity,
            retrievalQuery: 'normalized',
          })
          continue
        }
        const originalSimilarity = previous.originalSimilarity ?? previous.similarity
        const normalizedSimilarity = result.similarity
        const similarity = Math.max(originalSimilarity, normalizedSimilarity)
        const best = scoreMemoryFragment({
          fragment: previous,
          similarity,
          now: Date.now(),
          mood: currentMood.value,
          weights: getScoreWeights(),
        })
        mergedResults.set(result.id, {
          ...best,
          originalSimilarity,
          normalizedSimilarity,
          retrievalQuery: 'both',
        })
      }
      const results = [...mergedResults.values()]
        .sort((left, right) => right.score - left.score)
        .slice(0, 3)
      const reflexResults = [] as ScoredMemoryFragment[]
      // A muscle reflex fires only for an approved, still-active claim whose
      // own trigger pattern matches; matchesMuscleMemory gates the rest.
      const muscleMemory = (await memoryRepository.list({ memoryType: 'muscle', limit: 100, scope: options.scope }))
        .find(fragment => matchesMuscleMemory(fragment, query))
      if (muscleMemory) {
        reflexResults.push(scoreMemoryFragment({
          fragment: muscleMemory,
          similarity: 1,
          now: Date.now(),
          mood: currentMood.value,
          weights: getScoreWeights(),
        }))
      }

      if (intrusionEnabled.value) {
        // Unconfirmed and dethroned claims must not intrude either: the
        // intrusion channel reaches the behavior prompt like any other.
        const intrusiveMemory = selectIntrusiveMemory({
          fragments: (await memoryRepository.list({ limit: 10_000, scope: options.scope })).filter(fragment => isActionableMemoryFragment(fragment)),
          now: Date.now(),
          baseRate: intrusionBaseRate.value,
          cooldownMs: intrusionCooldownMs.value,
        })
        if (intrusiveMemory && !reflexResults.some(result => result.id === intrusiveMemory.id)) {
          await memoryRepository.update(intrusiveMemory.id, { lastIntrudedAt: Date.now() })
          reflexResults.push(scoreMemoryFragment({
            fragment: intrusiveMemory,
            similarity: 0,
            now: Date.now(),
            mood: currentMood.value,
            weights: getScoreWeights(),
          }))
        }
      }
      const seen = new Set<string>()
      const returnedResults = [...reflexResults, ...results]
        .filter((result) => {
          if (seen.has(result.id))
            return false
          seen.add(result.id)
          return true
        })
        .slice(0, 3)
      if (options.recordAccess !== false) {
        await memoryRepository.recordAccess({
          memoryIds: returnedResults.map(result => result.id),
          sessionId,
        })
        try {
          await promoteEligibleAndMirror(memoryRepository, embedMemoryText, options.scope)
        }
        catch (error) {
          databaseError.value = errorMessageFrom(error) ?? 'Unknown memory promotion error'
        }
        try {
          await checkpointMemoryDb()
        }
        catch (error) {
          databaseError.value = errorMessageFrom(error) ?? 'Unknown memory checkpoint error'
        }
      }
      return returnedResults
    }
    catch (error) {
      await resetDatabaseAfterError(error, 'Unknown memory retrieval error')
      return []
    }
  }

  /** Bounds optional vector work; an unavailable worker does not close the fact database. */
  async function embedWithInteractionBudget(text: string, kind: 'query' | 'document', embed: (text: string, kind: 'query' | 'document') => Promise<number[]>): Promise<number[] | undefined> {
    if (!directoryEnabled.value && !toolsEnabled.value)
      return embed(text, kind)
    let timeout: ReturnType<typeof setTimeout> | undefined
    try {
      // A failed worker can leave its request pending forever. Its late vector
      // has no persistence side effect and cannot enter this expired retrieval.
      return await Promise.race([
        embed(text, kind),
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => reject(new Error('Memory embedding exceeded 3000 ms; directory remains available')), 3000)
        }),
      ])
    }
    catch (error) {
      embeddingError.value = errorMessageFrom(error) ?? 'Memory embedding is pending'
      return undefined
    }
    finally {
      clearTimeout(timeout)
    }
  }

  /** Returns production retrieval ids for evaluation without changing state. */
  async function retrieveForEvaluation(query: string, sessionId: string, scope: MemoryScope): Promise<string[]> {
    return (await retrieve(query, sessionId, { recordAccess: false, scope })).map(fragment => fragment.id)
  }

  /** Captures the production result boundary without access-count side effects. */
  async function retrieveEvaluationTrace(query: string, sessionId: string, scope: MemoryScope, options: { similarityThreshold?: number } = {}) {
    const startedAt = performance.now()
    const trace: MemoryRetrievalTraceCapture = {}
    // `similarityThreshold` is an evaluation seam (MQ-2 step 5): the default
    // retrieval behavior always uses the repository threshold.
    const results = await retrieve(query, sessionId, { recordAccess: false, scope, trace, ...(options.similarityThreshold !== undefined ? { similarityThreshold: options.similarityThreshold } : {}) })
    return {
      originalQuery: trace.originalQuery ?? query,
      normalizedQuery: trace.normalizedQuery,
      retrievedIds: results.map(evaluationMemoryId),
      originalCandidateIds: trace.originalCandidateIds ?? [],
      normalizedCandidateIds: trace.normalizedCandidateIds ?? [],
      normalizedQueryCalled: trace.normalizedQueryCalled,
      queryTokenCount: trace.queryTokenCount,
      normalizedQueryTokenCount: trace.normalizedQueryTokenCount,
      retrievalLatencyMs: performance.now() - startedAt,
    }
  }

  /** Runs the 90-case evaluation through this store's production retrieval. */
  async function evaluateProductionRetrieval(context: MemoryProductionEvaluationContext, options: { costPerMillionTokens?: number, similarityThreshold?: number } = {}) {
    const { evaluateProductionMemoryRetrievalTrace } = await import('../../services/memory/evaluate-chinese-memory')
    const result = await evaluateProductionMemoryRetrievalTrace(
      query => retrieveEvaluationTrace(query, context.sessionId, context.scope, options.similarityThreshold !== undefined ? { similarityThreshold: options.similarityThreshold } : {}),
      options,
    )
    return { ...result, context }
  }

  /** Captures reviewed-source-safe suggestions within one cancellable 180-second model budget. */
  async function captureTurn(input: MemoryTurnInput, extractor: MemoryTurnExtractor, isCurrent?: () => boolean, reconcile?: MemoryReconciler): Promise<MemoryFragment[]> {
    const epoch = authorityEpoch
    const controller = new AbortController()
    const canCapture = () => !controller.signal.aborted && captureEnabled.value && authorityEpoch === epoch && (!isCurrent || isCurrent())
    if (!canCapture())
      return []

    const memoryRepository = await initialize()
    if (!memoryRepository || !canCapture())
      return []

    captureFailure.value = undefined
    captures.add(controller)
    const stop = watch(canCapture, (current) => {
      if (!current)
        controller.abort(new Error('Memory capture revoked'))
    }, { flush: 'sync' })
    // Extraction and reconciliation share the existing whole-request limit;
    // a second model pass does not receive a second 180-second allowance.
    const deadline = setTimeout(() => controller.abort(new Error('Memory capture exceeded 180000 ms')), 180_000)
    try {
      const handledOperations = input.sourceContext?.messageId
        ? await memoryRepository.sourceOperations(input.scope, input.sessionId, input.sourceContext.messageId)
        : []
      const extractions = await extractor({ ...input, handledOperations, mood: currentMood.value }, controller.signal)
      if (extractions.length === 0 || !canCapture())
        return []

      return await persistExtractions(memoryRepository, extractions, input.sourceContext, input.scope, canCapture, { reconcile, signal: controller.signal })
    }
    catch (error) {
      if (!canCapture()) {
        captureFailure.value = errorMessageFrom(error) ?? 'Memory capture revoked'
        return []
      }
      await resetDatabaseAfterError(error, 'Unknown memory capture error')
      return []
    }
    finally {
      clearTimeout(deadline)
      stop()
      captures.delete(controller)
    }
  }

  async function captureEvent(event: MemorySubscriptionEvent, scope: MemoryScope): Promise<MemoryFragment[]> {
    if (!captureEnabled.value)
      return []

    const extraction = memoryEventToExtraction(event)
    if (!extraction)
      return []

    const memoryRepository = await initialize()
    if (!memoryRepository)
      return []

    try {
      return await persistExtractions(memoryRepository, [extraction], undefined, scope)
    }
    catch (error) {
      await resetDatabaseAfterError(error, 'Unknown memory event capture error')
      return []
    }
  }

  async function list(memoryType?: MemoryFragment['memoryType']) {
    return (await initialize())?.list({ memoryType }) ?? []
  }

  /**
   * Lists facts that the social consideration boundary may share.
   *
   * A fact must belong to the active user and character, be actionable, and
   * retain source context. Pending or rejected claims never cross into an
   * unsolicited social turn, and source context lets the caller explain the
   * origin without exposing a raw database row.
   */
  async function listShareableFacts(scope: MemoryScope, limit = 5): Promise<MemoryFragment[]> {
    if (!enabled.value || limit <= 0)
      return []

    const memoryRepository = await initialize()
    if (!memoryRepository)
      return []

    try {
      // Eligibility is pushed into the query; a top-N page ordered by last
      // access used to hide an eligible fact that had not been read recently
      // (ACC-20260911 #12). The bound only caps how many eligible rows this
      // scan may hold, not who is eligible.
      const linkedUserIds = linkedUserIdsForScope(scope)
      const fragments = await memoryRepository.list({
        limit: SHAREABLE_FACT_SCAN_LIMIT,
        scope,
        linkedUserIds,
        shareable: true,
      })
      return fragments
        .filter((fragment) => {
          const fragmentScope = fragment.scope
          if (!fragmentScope || fragmentScope.characterId !== scope.characterId)
            return false
          if (fragmentScope.userId !== scope.userId && !linkedUserIds.includes(fragmentScope.userId))
            return false
          return isActionableMemoryFragment(fragment)
            && fragment.reviewStatus !== 'pending'
            && fragment.reviewStatus !== 'rejected'
            && (fragment.factStatus ?? 'active') === 'active'
            && !!fragment.sourceContext?.sourceType
            && !!(fragment.sourceContext.sourceEventId || fragment.sourceContext.messageId)
        })
        .sort((left, right) => right.createdAt - left.createdAt)
        .slice(0, limit)
    }
    catch (error) {
      await resetDatabaseAfterError(error, 'Unknown shareable memory list error')
      return []
    }
  }

  async function update(id: string, patch: Parameters<MemoryRepository['update']>[1]) {
    const memoryRepository = await initialize()
    if (!memoryRepository)
      return undefined
    if (await memoryRepository.operationForFragment(id))
      throw new Error('This reviewed proposal is immutable. Submit a revision to change its content.')

    if (patch.content === undefined) {
      const result = await memoryRepository.update(id, patch)
      factsRevision.value += 1
      if (result?.memoryType === 'long_term')
        enqueueLongTermSyncUpdate(id, memoryPresentationOf(result))
      await checkpointMemoryDb()
      return result
    }

    const content = patch.content.trim()
    if (!content)
      throw new Error('Memory content must not be empty')

    const { activeMemoryEmbeddingMetadata, embedMemoryText } = await import('../../services/memory/local-memory-embedding')
    const contentVector = await embedMemoryText(content)
    const result = await memoryRepository.update(id, {
      ...patch,
      content,
      contentVector,
      embeddingMetadata: activeMemoryEmbeddingMetadata({ kind: 'document', dimensions: contentVector.length }),
    })
    factsRevision.value += 1
    // Only an already-promoted fact can exist in the remote store. Updates
    // for a short-term fragment reach zero remote rows, and the previous
    // code treated that empty update as success, silently dropping the
    // approval and clearing the outbox (R06).
    if (result?.memoryType === 'long_term') {
      // Mirror the reviewed fields the remote store cares about; a content
      // change carries its fresh embedding so remote search stays in sync.
      enqueueLongTermSyncUpdate(id, {
        ...(patch.content !== undefined ? { content } : {}),
        ...(patch.category !== undefined ? { category: patch.category } : {}),
        ...(patch.importance !== undefined ? { importance: patch.importance } : {}),
        ...(patch.reviewStatus !== undefined ? { reviewStatus: patch.reviewStatus } : {}),
        ...(patch.factStatus !== undefined ? { factStatus: patch.factStatus } : {}),
        ...(patch.supersedesId != null ? { supersedesId: patch.supersedesId } : {}),
        ...(patch.conflictGroup != null ? { conflictGroup: patch.conflictGroup } : {}),
        ...(patch.content !== undefined ? { embedding: contentVector } : {}),
      }, content)
    }
    await checkpointMemoryDb()
    return result
  }

  async function remove(id: string) {
    const memoryRepository = await initialize()
    if (!memoryRepository)
      return
    await memoryRepository.remove(id)
    factsRevision.value += 1
    enqueueLongTermSyncDelete(id)
    await checkpointMemoryDb()
  }

  /** Fragments waiting for the human confirmation gate (MEMORY-DESIGN §11.2). */
  async function listPending() {
    const memoryRepository = await initialize()
    if (!memoryRepository)
      return []
    const pending = await memoryRepository.list({ memoryType: 'short_term', reviewStatus: 'pending', limit: 100 })
    const ordinary: MemoryFragment[] = []
    for (const fragment of pending) {
      // Explicit proposals have a richer confirmation card showing the title,
      // summary, target version, and previous body. A body-only card must not
      // approve those unseen fields through the older review surface.
      if (!await memoryRepository.operationForFragment(fragment.id))
        ordinary.push(fragment)
    }
    return ordinary
  }

  /** Approves or rejects a pending fragment (rejected ones never get recalled). */
  async function setReviewStatus(id: string, status: 'approved' | 'rejected') {
    const memoryRepository = await initialize()
    if (!memoryRepository)
      return undefined
    const operation = await memoryRepository.operationForFragment(id)
    if (operation)
      return confirmOperation(operation.scope, operation.operationId, status === 'approved')
    const epoch = authorityEpoch
    const { result, current, superseded } = await memoryRepository.transaction(async (tx) => {
      const current = await tx.get(id)
      if (!current)
        return {}
      const superseded = current.supersedesId ? await tx.get(current.supersedesId) : undefined
      if (status === 'approved' && current.supersedesId && (!superseded || superseded.factStatus !== 'active' || ((current.scope || superseded.scope) && !isSameMemoryScope(current.scope, superseded.scope))))
        throw new Error('The replaced fact changed; review the current fact first')
      const transferPin = status === 'approved' && current.factStatus !== 'disputed' && superseded?.pinned
      const result = await tx.update(id, { reviewStatus: status, ...(transferPin ? { pinned: true, pinOrder: superseded.pinOrder } : {}) })
      if (status === 'approved' && superseded) {
        await tx.update(superseded.id, { factStatus: current.factStatus === 'disputed' ? 'disputed' : 'superseded', ...(superseded.pinned ? { pinned: false } : {}) })
        if (transferPin && current.scope && buildMemoryDirectory(await tx.directory(current.scope)).omitted.length)
          throw new Error('The replacement exceeds the pinned directory budget; edit its presentation first')
      }
      if (epoch !== authorityEpoch)
        throw new Error('Memory review revoked by account change')
      return { result, current, superseded }
    })
    factsRevision.value += 1
    if (result) {
      // A short-term fragment has no remote row yet. Queuing an update for it
      // used to hit zero rows, succeed, and clear the outbox while the mirror
      // stayed missing (R06). Its promotion insert carries the final state.
      if (current?.memoryType === 'long_term')
        enqueueLongTermSyncUpdate(id, { reviewStatus: status })
      if (status === 'approved' && current?.supersedesId) {
        const supersededStatus = current.factStatus === 'disputed' ? 'disputed' : 'superseded'
        // The replaced claim may already be mirrored (a long-term fact), in
        // which case the remote row must flip to superseded.
        if (superseded?.memoryType === 'long_term')
          enqueueLongTermSyncUpdate(current.supersedesId, { factStatus: supersededStatus, ...(superseded.pinned ? { pinned: false } : {}) })
      }
    }
    await checkpointMemoryDb()
    return result
  }

  /**
   * Creates a pending revision or dispute. Approval is required before the
   * previous claim is changed, so a model cannot silently rewrite history.
   */
  async function reviseFact(input: {
    memoryId: string
    content: string
    relation: MemoryFactRevisionRelation
  }): Promise<MemoryFragment | undefined> {
    if (!enabled.value || !input.content.trim())
      return undefined
    const memoryRepository = await initialize()
    if (!memoryRepository)
      return undefined
    const current = (await memoryRepository.list({ limit: 10_000 })).find(fragment => fragment.id === input.memoryId)
    if (!current)
      throw new Error(`Memory fragment not found: ${input.memoryId}`)
    if (current.memoryType === 'working')
      throw new Error('Working memory cannot be revised as a factual claim')
    // Revising a muscle converts it to fact semantics: the replacement is a
    // reviewable short-term fact, and approving it supersedes the old reflex
    // so the stale trigger can never fire again
    // (MEMORY-SEMANTICS-CORRECTION §6.3).
    if (!current.scope)
      throw new Error('Unscoped legacy memory cannot be revised into an owned fact')
    const revisionScope = current.scope
    // A revision is a claim about the same fact, so it inherits the provenance
    // of the claim it replaces. Without a sourceContext the replacement could
    // never pass the shareable-source gate, and after a correction the social
    // consideration boundary saw neither the old fact nor the new one
    // (ACC-20260910 S17).
    const revisionSourceContext = copyMemorySourceContext(current.sourceContext)
    const [revision] = await persistExtractions(memoryRepository, [{
      content: input.content.trim(),
      category: current.category,
      memoryType: 'short_term',
      importance: current.importance,
      valence: current.valence,
      arousal: current.arousal,
      tags: ['fact-revision', input.relation === 'disputes' ? 'dispute' : 'supersede'],
      reviewStatus: 'pending',
      factStatus: input.relation === 'disputes' ? 'disputed' : 'active',
      supersedesId: current.id,
      ...(input.relation === 'disputes' ? { conflictGroup: current.conflictGroup ?? current.id } : {}),
    }], revisionSourceContext, revisionScope)
    // The correction stays auditable from the moment it enters the pipeline;
    // approval and the resulting supersede are observable through the review
    // actions and the remote sync ops.
    useJournalStore().append(MEMORY_BROWSER_SESSION_ID, {
      type: 'memory/revised',
      sessionId: MEMORY_BROWSER_SESSION_ID,
      memoryId: current.id,
      revisionId: revision?.id ?? '',
      relation: input.relation,
      timestamp: Date.now(),
    })
    return revision
  }

  /** Stores an approved tool trigger as a non-decaying muscle memory. */
  async function rememberMuscle(input: { content: string, triggerPattern: string, scope?: MemoryScope }): Promise<MemoryFragment | undefined> {
    if (!enabled.value || !input.content.trim() || !input.triggerPattern.trim())
      return undefined

    const memoryRepository = await initialize()
    if (!memoryRepository)
      return undefined

    try {
      const { activeMemoryEmbeddingMetadata, embedMemoryText } = await import('../../services/memory/local-memory-embedding')
      const embedding = await embedMemoryText(input.content)
      const result = await memoryRepository.insert({
        content: input.content.trim(),
        category: 'chat',
        memoryType: 'muscle',
        importance: 9,
        valence: 0,
        arousal: 0,
        tags: ['muscle', 'self-authored-tool'],
        triggerPattern: input.triggerPattern.trim(),
        scope: input.scope,
        reviewStatus: 'approved',
        embedding,
        embeddingMetadata: activeMemoryEmbeddingMetadata({ kind: 'document', dimensions: embedding.length }),
      })
      await checkpointMemoryDb()
      return result
    }
    catch (error) {
      await resetDatabaseAfterError(error, 'Unknown muscle memory error')
      return undefined
    }
  }

  /**
   * Converts one patternless muscle record into a pending short-term fact,
   * keeping its id, source, and access history (MEMORY-SEMANTICS-CORRECTION
   * §2.4). The review gate reruns from scratch: the converted record waits
   * for approval before it may reach a behavior prompt again. Rejected
   * records stay rejected — converting them would resurrect a verdict — and
   * muscles with a usable trigger pattern are never converted automatically.
   */
  async function convertMuscleToFact(id: string): Promise<MemoryFragment | undefined> {
    const memoryRepository = await initialize()
    if (!memoryRepository)
      return undefined

    const current = (await memoryRepository.list({ limit: 10_000 })).find(fragment => fragment.id === id)
    if (!current)
      throw new Error(`Memory fragment not found: ${id}`)
    if (current.memoryType !== 'muscle')
      throw new Error('Only a muscle memory can be converted into a fact')
    if (current.reviewStatus === 'rejected')
      throw new Error('A rejected muscle memory cannot be converted into a fact')
    if (current.triggerPattern?.trim())
      throw new Error('A muscle memory with a usable trigger pattern is not converted automatically')

    const { activeMemoryEmbeddingMetadata, embedMemoryText } = await import('../../services/memory/local-memory-embedding')
    const contentVector = await embedMemoryText(current.content)
    const result = await memoryRepository.update(id, {
      memoryType: 'short_term',
      triggerPattern: null,
      reviewStatus: 'pending',
      factStatus: 'active',
      halfLifeHours: shortTermHalfLifeHours.value,
      contentVector,
      embeddingMetadata: activeMemoryEmbeddingMetadata({ kind: 'document', dimensions: contentVector.length }),
    })
    if (result) {
      // The converted row stays short_term (not mirrored). A remote update for
      // it would hit zero rows and be dropped as success, so the mirror waits
      // for the promotion insert that carries the final state (R06).
      useJournalStore().append(MEMORY_BROWSER_SESSION_ID, {
        type: 'memory/migrated',
        sessionId: MEMORY_BROWSER_SESSION_ID,
        memoryId: id,
        fromType: 'muscle',
        toType: 'short_term',
        hadTriggerPattern: false,
        reviewStatus: 'pending',
        timestamp: Date.now(),
      })
    }
    await checkpointMemoryDb()
    return result
  }

  async function refreshDreamIdeas(scope: MemoryScope, status?: MemoryDreamIdeaStatus): Promise<MemoryDreamIdea[]> {
    const memoryRepository = await initialize()
    if (!memoryRepository) {
      dreamIdeas.value = []
      return []
    }
    dreamIdeas.value = (await memoryRepository.listDreamIdeas({ scope, status, limit: 100 })).filter(idea => isSameMemoryScope(idea.scope, scope))
    return dreamIdeas.value
  }

  /** Runs one bounded dreaming pass; proposals stay ideas until a human changes their lifecycle. */
  async function dream(scope: MemoryScope): Promise<MemoryDreamIdea[]> {
    if (areRestoreEffectsHeld())
      return dreamIdeas.value.filter(idea => isSameMemoryScope(idea.scope, scope))
    if (!enabled.value || !dreamingEnabled.value || dreaming.value)
      return dreamIdeas.value.filter(idea => isSameMemoryScope(idea.scope, scope))

    dreaming.value = true
    try {
      const memoryRepository = await initialize()
      if (!memoryRepository)
        return []

      const [allFragments, ideas] = await Promise.all([
        memoryRepository.list({ limit: 1_000, scope }),
        memoryRepository.listDreamIdeas({ limit: 100, scope }),
      ])
      // Dreaming proposes follow-ups from reviewed facts only. Pending and
      // rejected fragments are not reliable inputs for a new suggestion.
      const fragments = selectDreamSourceFragments(allFragments).filter(fragment => isSameMemoryScope(fragment.scope, scope))
      const scopedIdeas = ideas.filter(idea => isSameMemoryScope(idea.scope, scope))
      const proposals = dreamAgent ? await dreamAgent({ fragments, ideas: scopedIdeas }) : []
      const existing = new Set(scopedIdeas.map(idea => idea.content.trim().toLocaleLowerCase()))
      for (const proposal of proposals.slice(0, 3)) {
        const content = proposal.content.trim()
        if (!content || existing.has(content.toLocaleLowerCase()))
          continue
        const { embedMemoryText } = await import('../../services/memory/local-memory-embedding')
        await memoryRepository.addDreamIdea({
          content,
          sourceType: 'dream-agent',
          scope: { ...scope },
          sourceId: proposal.sourceId,
          excitement: proposal.excitement,
          embedding: await embedMemoryText(content),
        })
        existing.add(content.toLocaleLowerCase())
      }
      return await refreshDreamIdeas(scope)
    }
    catch (error) {
      await resetDatabaseAfterError(error, 'Unknown dreaming error')
      return dreamIdeas.value.filter(idea => isSameMemoryScope(idea.scope, scope))
    }
    finally {
      dreaming.value = false
    }
  }

  function localDreamDayKey(timestamp: number): string {
    const date = new Date(timestamp)
    const month = String(date.getMonth() + 1).padStart(2, '0')
    const day = String(date.getDate()).padStart(2, '0')
    return `${date.getFullYear()}-${month}-${day}`
  }

  /**
   * Runs the private dreaming pass from an eligible life-mode heartbeat.
   * This budget is separate from life-mode speech decisions and never turns
   * a proposal into an executable plan.
   */
  async function runAutomaticDreaming(input: { now?: number, scope: MemoryScope }): Promise<AutomaticDreamResult> {
    const now = input.now ?? Date.now()
    if (areRestoreEffectsHeld() || !enabled.value || !dreamingEnabled.value || !automaticDreamingEnabled.value)
      return { status: 'skipped', reason: 'disabled' }
    if (!isLeader.value)
      return { status: 'skipped', reason: 'not-leader' }
    if (dreaming.value)
      return { status: 'skipped', reason: 'already-running' }

    const dayKey = localDreamDayKey(now)
    if (dreamingBudgetDateKey.value !== dayKey) {
      dreamingBudgetDateKey.value = dayKey
      dreamingBudgetUsed.value = 0
    }

    const dailyBudget = Number.isFinite(dreamingDailyBudget.value)
      ? Math.max(0, Math.floor(dreamingDailyBudget.value))
      : 1
    const budgetUsed = Number.isFinite(dreamingBudgetUsed.value)
      ? Math.max(0, Math.floor(dreamingBudgetUsed.value))
      : 0
    dreamingBudgetUsed.value = budgetUsed
    if (dailyBudget > 0 && budgetUsed >= dailyBudget)
      return { status: 'skipped', reason: 'budget' }

    const intervalHours = Number.isFinite(dreamingIntervalHours.value)
      ? Math.max(0, dreamingIntervalHours.value)
      : 24
    if (lastDreamAt.value > 0 && intervalHours > 0 && now - lastDreamAt.value < intervalHours * 60 * 60 * 1_000)
      return { status: 'skipped', reason: 'cooldown' }

    const memoryRepository = await initialize()
    if (!memoryRepository)
      return { status: 'skipped', reason: 'database-unavailable' }

    try {
      const allFragments = await memoryRepository.list({ limit: 1_000, scope: input.scope })
      const minNewMemoryCount = Number.isFinite(dreamingMinNewMemoryCount.value)
        ? Math.max(1, Math.floor(dreamingMinNewMemoryCount.value))
        : 3
      const newMemoryCount = allFragments.filter(fragment => isSameMemoryScope(fragment.scope, input.scope) && (fragment.memoryType === 'short_term' || fragment.memoryType === 'long_term')
        && fragment.reviewStatus !== 'pending'
        && fragment.reviewStatus !== 'rejected'
        && fragment.createdAt > lastDreamAt.value).length
      if (newMemoryCount < minNewMemoryCount)
        return { status: 'skipped', reason: 'insufficient-new-memory' }

      const previousIdeas = await memoryRepository.listDreamIdeas({ limit: 100, scope: input.scope })
      const previousIdeaIds = new Set(previousIdeas.map(idea => idea.id))
      const nextIdeas = await dream(input.scope)
      const addedCount = nextIdeas.filter(idea => !previousIdeaIds.has(idea.id)).length
      lastDreamAt.value = now
      dreamingBudgetUsed.value = budgetUsed + 1
      dreamingBudgetDateKey.value = dayKey
      return { status: 'ran', addedCount }
    }
    catch (error) {
      await resetDatabaseAfterError(error, 'Unknown automatic dreaming error')
      return { status: 'skipped', reason: 'database-unavailable' }
    }
  }

  async function updateDreamIdea(id: string, patch: Parameters<MemoryRepository['updateDreamIdea']>[1], scope: MemoryScope) {
    const memoryRepository = await initialize()
    if (!memoryRepository)
      return undefined
    const current = (await memoryRepository.listDreamIdeas({ limit: 10_000, scope })).find(idea => idea.id === id && isSameMemoryScope(idea.scope, scope))
    if (!current)
      throw new Error('The idea is outside the current memory scope.')
    if (patch.status !== undefined) {
      if (current && !canTransitionDreamIdea(current.status, patch.status))
        throw new Error(`Dream idea cannot move from ${current.status} to ${patch.status}`)
    }
    const idea = await memoryRepository.updateDreamIdea(id, patch)
    await refreshDreamIdeas(scope)
    return idea
  }

  function setMood(mood: MemoryMood) {
    currentMood.value = {
      valence: Math.max(-1, Math.min(1, mood.valence)),
      arousal: mood.arousal == null ? undefined : Math.max(0, Math.min(1, mood.arousal)),
    }
  }

  function setEmotion(emotion: { name: string, intensity: number }) {
    setMood(emotionToMood(emotion))
  }

  /** Reloads settings written by an isolated profile import into live refs. */
  function restorePersistedSettings(): void {
    if (typeof localStorage === 'undefined')
      return

    const read = (key: string) => localStorage.getItem(`settings/memory/${key}`)
    const boolean = (key: string, target: { value: boolean }) => {
      const value = read(key)
      if (value !== null)
        target.value = value === 'true'
    }
    const number = (key: string, target: { value: number }) => {
      const value = read(key)
      if (value === null)
        return
      const parsed = Number(value)
      if (Number.isFinite(parsed))
        target.value = parsed
    }
    const string = (key: string, target: { value: string }) => {
      const value = read(key)
      if (value !== null)
        target.value = value
    }

    boolean('enabled', enabled)
    boolean('capture-enabled', captureEnabled)
    boolean('directory-enabled', directoryEnabled)
    boolean('tools-enabled', toolsEnabled)
    boolean('compaction-enabled', compactionEnabled)
    string('active-provider', activeProvider)
    string('active-model', activeModel)
    number('compaction-threshold', compactionThreshold)
    number('context-length-override', contextLengthOverride)
    number('compaction-recent-turn-limit', compactionRecentTurnLimit)
    number('short-term-half-life-hours', shortTermHalfLifeHours)
    number('long-term-half-life-hours', longTermHalfLifeHours)
    number('promotion-access-count', promotionAccessCount)
    number('promotion-session-count', promotionSessionCount)
    number('weight-similarity', weightSimilarity)
    number('weight-time-relevance', weightTimeRelevance)
    number('weight-arousal', weightArousal)
    number('weight-access-count', weightAccessCount)
    number('weight-mood-congruence', weightMoodCongruence)
    boolean('intrusion-enabled', intrusionEnabled)
    number('intrusion-base-rate', intrusionBaseRate)
    number('intrusion-cooldown-ms', intrusionCooldownMs)
    boolean('dreaming-enabled', dreamingEnabled)
    boolean('automatic-dreaming-enabled', automaticDreamingEnabled)
    number('dreaming-interval-hours', dreamingIntervalHours)
    number('dreaming-daily-budget', dreamingDailyBudget)
    number('dreaming-min-new-memory-count', dreamingMinNewMemoryCount)
    number('last-dream-at', lastDreamAt)
    number('dreaming-budget-used', dreamingBudgetUsed)
    string('dreaming-budget-date-key', dreamingBudgetDateKey)
    string('embedding-source', embeddingSource)
    string('embedding-model', embeddingModel)
    string('embedding-fingerprint', embeddingFingerprint)
    const migration = read('embedding-migration')
    if (migration !== null) {
      try {
        const parsed = JSON.parse(migration) as MemoryEmbeddingMigrationState
        if (parsed && typeof parsed === 'object' && Array.isArray(parsed.ids) && typeof parsed.nextIndex === 'number' && typeof parsed.total === 'number' && typeof parsed.state === 'string')
          embeddingMigration.value = parsed
      }
      catch {
        // Keep the current migration state when an imported optional setting is malformed.
      }
    }
  }

  async function persistExtractions(memoryRepository: MemoryInteractionRepository, extractions: MemoryExtraction[], sourceContext: MemorySourceContext | undefined, scope: MemoryScope, isCurrent?: () => boolean, options?: { reconcile?: MemoryReconciler, signal: AbortSignal }): Promise<MemoryFragment[]> {
    // Automatic chat capture must reconcile handled claims. Explicit user
    // revisions retain their provenance and use the existing review boundary.
    const prepared = options
      ? await reconcileMemoryExtractions(memoryRepository, extractions, { scope, sourceContext, reconcile: options.reconcile, signal: options.signal })
      : { accepted: extractions.map((extraction): ReconciledMemoryExtraction => ({ extraction, sourceContext: sourceContext ?? extraction.sourceContext })), deferred: 0, errors: [] }
    if (prepared.deferred) {
      captureFailure.value = prepared.errors.join('; ') || `${prepared.deferred} memory candidates need source reconciliation`
      console.warn('[Memory] Capture deferred.', captureFailure.value)
    }
    if (!prepared.accepted.length)
      return []
    const { activeMemoryEmbeddingMetadata, embedMemoryText } = await import('../../services/memory/local-memory-embedding')
    const interactive = directoryEnabled.value || toolsEnabled.value
    if (interactive) {
      void initializeVectors(memoryRepository).then((ready) => {
        backgroundVectorsReady = ready
      })
    }
    const vectorsReady = interactive ? backgroundVectorsReady : await initializeVectors(memoryRepository)
    const fragments: MemoryFragment[] = []
    for (const candidate of prepared.accepted) {
      if (isCurrent && !isCurrent())
        break
      const { extraction, sourceContext: persistedSourceContext } = candidate
      if (!await isExtractionSourceCurrent(memoryRepository, candidate, scope)) {
        captureFailure.value = 'Memory source changed during reconciliation; capture deferred'
        continue
      }
      let embedding: number[] | undefined
      if (vectorsReady) {
        try {
          embedding = await embedWithInteractionBudget(extraction.content, 'document', embedMemoryText)
        }
        catch (error) {
          embeddingError.value = errorMessageFrom(error) ?? 'Memory embedding is pending'
        }
      }
      if (isCurrent && !isCurrent())
        break
      const fragment = await memoryRepository.transaction(async (tx) => {
        if (isCurrent && !isCurrent())
          throw new Error('Memory capture revoked')
        // No model or embedding runs inside the transaction. A new handled
        // claim invalidates the earlier comparison rather than racing its insert.
        if (!await isExtractionSourceCurrent(tx, candidate, scope)) {
          captureFailure.value = 'Memory source changed before capture commit; capture deferred'
          return undefined
        }
        const result = await tx.insert({
          ...extraction,
          // MEMORY-DESIGN §11.2: fresh extractions wait for human approval
          // before they may be promoted to long-term memory.
          ...(extraction.reviewStatus === undefined ? { reviewStatus: 'pending' as const } : {}),
          ...(persistedSourceContext ? { sourceContext: persistedSourceContext } : {}),
          scope,
          embedding,
          ...(embedding ? { embeddingMetadata: activeMemoryEmbeddingMetadata({ kind: 'document', dimensions: embedding.length }) } : {}),
          // Ordinary extractions are short-term facts by contract.
          halfLifeHours: shortTermHalfLifeHours.value,
        })
        if (isCurrent && !isCurrent())
          throw new Error('Memory capture revoked')
        return result
      })
      if (fragment)
        fragments.push(fragment)
    }
    if (!isCurrent || isCurrent())
      await promoteEligibleAndMirror(memoryRepository, embedMemoryText, scope)
    await checkpointMemoryDb()
    return fragments
  }

  async function promoteEligibleAndMirror(
    memoryRepository: MemoryRepository,
    embedMemoryText: (text: string) => Promise<number[]>,
    scope: MemoryScope,
  ): Promise<void> {
    const promotedIds = await memoryRepository.promoteEligible({
      minAccessCount: promotionAccessCount.value,
      minSessionCount: promotionSessionCount.value,
      halfLifeHours: longTermHalfLifeHours.value,
      scope,
    })
    await mirrorPromotedToLongTermStore(memoryRepository, promotedIds, embedMemoryText)
  }

  /** Queues the promotion snapshot of a newly promoted long-term fact. */
  function enqueueLongTermSync(fragment: MemoryFragment): void {
    if (!longTermSyncEnabled.value || !isLeader.value)
      return
    if (longTermSyncOutbox.value.some(item => item.originId === fragment.id))
      return

    longTermSyncOutbox.value = [...longTermSyncOutbox.value, {
      kind: 'insert' as const,
      ...memoryPresentationOf(fragment),
      originId: fragment.id,
      content: fragment.content,
      memoryType: fragment.memoryType,
      category: fragment.category,
      importance: fragment.importance,
      valence: fragment.valence,
      arousal: fragment.arousal,
      halfLifeHours: fragment.halfLifeHours,
      sessionId: fragment.sessionIds.at(-1),
      reviewStatus: fragment.reviewStatus,
      factStatus: fragment.factStatus,
      supersedesId: fragment.supersedesId ?? undefined,
      conflictGroup: fragment.conflictGroup ?? undefined,
      scope: fragment.scope,
      sourceContext: fragment.sourceContext,
      embedding: hasStorableVector(fragment.contentVector) ? fragment.contentVector : undefined,
      embeddingMetadata: fragment.embeddingProvider && fragment.embeddingModel && fragment.embeddingDimensions && fragment.embeddingInputType && fragment.embeddingSourceFingerprint && fragment.embeddedAt
        ? {
            embeddingProvider: fragment.embeddingProvider,
            embeddingModel: fragment.embeddingModel,
            embeddingDimensions: fragment.embeddingDimensions,
            embeddingInputType: fragment.embeddingInputType,
            embeddingSourceFingerprint: fragment.embeddingSourceFingerprint,
            embeddedAt: fragment.embeddedAt,
            embeddingStatus: fragment.embeddingStatus ?? 'active',
          }
        : undefined,
      attempts: 0,
      nextAttemptAt: 0,
      createdAt: Date.now(),
    }]
  }

  /**
   * Queues one absolute-state patch for an already-mirrored fact. A queued
   * delete wins over it: once the fact is being removed remotely, a lagging
   * update is obsolete.
   */
  function enqueueLongTermSyncUpdate(originId: string, patch: LongTermSyncItem['patch'], content?: string): void {
    if (!longTermSyncEnabled.value || !isLeader.value || !originId)
      return
    if (longTermSyncOutbox.value.some(item => item.originId === originId && item.kind === 'delete'))
      return

    longTermSyncOutbox.value = [...longTermSyncOutbox.value, {
      kind: 'update' as const,
      originId,
      content,
      patch,
      attempts: 0,
      nextAttemptAt: 0,
      createdAt: Date.now(),
    }]
  }

  /** Queues a tombstone for a locally deleted fact; remote redelivery never resurrects it. */
  function enqueueLongTermSyncDelete(originId: string): void {
    if (!longTermSyncEnabled.value || !isLeader.value || !originId)
      return
    if (longTermSyncOutbox.value.some(item => item.originId === originId && item.kind === 'delete'))
      return

    longTermSyncOutbox.value = [...longTermSyncOutbox.value, {
      kind: 'delete' as const,
      originId,
      attempts: 0,
      nextAttemptAt: 0,
      createdAt: Date.now(),
    }]
  }

  async function dispatchLongTermSyncOp(item: LongTermSyncItem, embedMemoryText: (text: string) => Promise<number[]>): Promise<void> {
    if (!memoryHostPort)
      throw new Error('Memory host bridge is not installed')

    if (item.kind === 'delete') {
      await memoryHostPort.remove({ originId: item.originId })
      return
    }

    if (item.kind === 'update') {
      const patch = {
        ...item.patch,
        ...(item.patch?.embedding ? { embedding: [...item.patch.embedding] } : {}),
        ...(item.patch?.embeddingMetadata ? { embeddingMetadata: copyMemoryEmbeddingMetadata(item.patch.embeddingMetadata) } : {}),
      }
      // A content change must re-embed, or remote search would keep ranking
      // the fact by its old text.
      if (patch.content && !patch.embedding)
        patch.embedding = hasStorableVector(item.embedding) ? item.embedding : await embedMemoryText(patch.content)
      if (patch.embedding && !patch.embeddingMetadata) {
        const { activeMemoryEmbeddingMetadata } = await import('../../services/memory/local-memory-embedding')
        patch.embeddingMetadata = activeMemoryEmbeddingMetadata({ kind: 'document', dimensions: patch.embedding.length })
      }
      await memoryHostPort.update({ originId: item.originId, patch })
      return
    }

    const embedding = item.embedding && hasStorableVector(item.embedding) ? [...item.embedding] : await embedMemoryText(item.content ?? '')
    const { activeMemoryEmbeddingMetadata } = await import('../../services/memory/local-memory-embedding')
    await memoryHostPort.insert({
      ...memoryPresentationOf(item),
      content: item.content ?? '',
      memoryType: item.memoryType ?? 'long_term',
      category: item.category ?? 'chat',
      importance: item.importance,
      valence: item.valence,
      arousal: item.arousal,
      halfLifeHours: item.halfLifeHours,
      sessionId: item.sessionId,
      reviewStatus: item.reviewStatus,
      factStatus: item.factStatus,
      supersedesId: item.supersedesId,
      conflictGroup: item.conflictGroup,
      scope: copyMemoryScope(item.scope),
      sourceContext: copyMemorySourceContext(item.sourceContext),
      embedding,
      embeddingMetadata: copyMemoryEmbeddingMetadata(item.embeddingMetadata) ?? activeMemoryEmbeddingMetadata({ kind: 'document', dimensions: embedding.length }),
      originId: item.originId,
    })
  }

  /** Reconstructs committed invalidations; restore holds prohibit replay. */
  async function recoverOperationMirrors(memoryRepository: MemoryInteractionRepository): Promise<void> {
    if (areRestoreEffectsHeld() || !longTermSyncEnabled.value || !isLeader.value)
      return
    for (const operation of await memoryRepository.pendingMirrorOperations()) {
      if (operation.status !== 'applied' || !operation.proposal.targetId || longTermSyncOutbox.value.some(item => item.operationId === operation.operationId))
        continue
      longTermSyncOutbox.value = [...longTermSyncOutbox.value, {
        kind: operation.proposal.kind === 'forget' ? 'delete' : 'update',
        originId: operation.proposal.targetId,
        operationId: operation.operationId,
        ...(operation.proposal.kind === 'forget' ? {} : { patch: { factStatus: 'superseded', pinned: false } }),
        attempts: 0,
        nextAttemptAt: 0,
        createdAt: operation.updatedAt,
      }]
    }
  }

  let syncFlush: Promise<void> | undefined
  async function flushLongTermSyncOutbox(embedMemoryText: (text: string) => Promise<number[]>): Promise<void> {
    if (syncFlush)
      return syncFlush
    syncFlush = deliverLongTermSyncOutbox(embedMemoryText)
    try {
      await syncFlush
    }
    finally {
      syncFlush = undefined
    }
  }

  async function deliverLongTermSyncOutbox(embedMemoryText: (text: string) => Promise<number[]>): Promise<void> {
    await waitForRestore()
    if (areRestoreEffectsHeld())
      return
    if (!longTermSyncEnabled.value || !isLeader.value || !memoryHostPort || remoteStatus.value !== 'ready')
      return
    const memoryRepository = await initialize()
    if (!memoryRepository)
      return
    await recoverOperationMirrors(memoryRepository)

    // Items persisted before ops carried a kind are promotion snapshots.
    let normalized = false
    const queue = longTermSyncOutbox.value.map((item) => {
      if (item.kind)
        return item
      normalized = true
      return { ...item, kind: 'insert' as const }
    })
    if (normalized)
      longTermSyncOutbox.value = queue

    const now = Date.now()
    const due = queue.filter(item => item.nextAttemptAt <= now).slice(0, 8)
    if (due.length === 0)
      return

    // Keyed by queue-item identity: succeeded ops leave the queue, failed ops
    // are replaced by their backoff state in place, preserving FIFO order.
    const outcomes = new Map<LongTermSyncItem, LongTermSyncItem | undefined>()
    for (const item of due) {
      try {
        await dispatchLongTermSyncOp(item, embedMemoryText)
        if (item.operationId) {
          await memoryRepository.transaction(async (tx) => {
            const receipt = await tx.operation(item.operationId!)
            if (receipt)
              await tx.saveOperation({ ...receipt, mirrorPending: false })
          })
          await checkpointMemoryDb()
        }
        outcomes.set(item, undefined)
        lastLongTermSyncAt.value = now
        lastLongTermSyncError.value = ''
      }
      catch (error) {
        const attempts = item.attempts + 1
        const delay = Math.min(6 * 60 * 60 * 1_000, 60_000 * 2 ** Math.min(attempts - 1, 6))
        const message = errorMessageFrom(error) ?? 'Long-term sync failed'
        outcomes.set(item, {
          ...item,
          attempts,
          nextAttemptAt: now + delay,
          lastError: message,
        })
        lastLongTermSyncError.value = message
        // Stop the retry timer until the host reports ready again. The local
        // outbox remains durable, so a later status refresh can resume it.
        remoteStatus.value = 'error'
        remoteError.value = message
      }
    }
    longTermSyncOutbox.value = longTermSyncOutbox.value.flatMap((item) => {
      if (!outcomes.has(item))
        return [item]
      const replacement = outcomes.get(item)!
      return replacement ? [replacement] : []
    })
  }

  /**
   * Enqueues promoted fragments before attempting remote delivery. The queue
   * is local and idempotent, so a disconnected host or renderer restart does
   * not lose an already-promoted long-term fact.
   */
  async function mirrorPromotedToLongTermStore(
    memoryRepository: MemoryRepository,
    promotedIds: string[],
    embedMemoryText: (text: string) => Promise<number[]>,
  ): Promise<void> {
    if (promotedIds.length === 0 || !longTermSyncEnabled.value)
      return

    try {
      const promoted = new Set(promotedIds)
      const longTermFragments = await memoryRepository.list({ memoryType: 'long_term', limit: 1000 })
      for (const fragment of longTermFragments) {
        if (!promoted.has(fragment.id))
          continue
        enqueueLongTermSync(fragment)
      }
      await flushLongTermSyncOutbox(embedMemoryText)
    }
    catch (error) {
      lastLongTermSyncError.value = errorMessageFrom(error) ?? 'Unknown long-term store error'
    }
  }

  /** Connects (or disconnects) the long-term Postgres store. */
  async function configureRemoteHost(connectionString: string): Promise<MemoryHostStatusLike> {
    if (!memoryHostPort) {
      remoteStatus.value = 'unconfigured'
      return { status: 'unconfigured', error: 'Memory host bridge is not installed in this window' }
    }

    pgConnectionString.value = connectionString
    const result = await memoryHostPort.configure({ connectionString: connectionString.trim() || undefined })
    remoteStatus.value = result.status
    remoteError.value = result.error
    if (result.status === 'ready')
      await retryLongTermSync()
    return result
  }

  async function refreshRemoteHostStatus(): Promise<MemoryHostStatusLike> {
    if (!memoryHostPort) {
      remoteStatus.value = 'unconfigured'
      return { status: 'unconfigured' }
    }
    const result = await memoryHostPort.getStatus()
    remoteStatus.value = result.status
    remoteError.value = result.error
    if (result.status === 'ready')
      await retryLongTermSync()
    return result
  }

  async function retryLongTermSync(): Promise<void> {
    if (areRestoreEffectsHeld())
      return
    longTermSyncOutbox.value = longTermSyncOutbox.value.map(item => ({ ...item, nextAttemptAt: 0 }))
    if (!longTermSyncEnabled.value || !isLeader.value)
      return
    const { embedMemoryText } = await import('../../services/memory/local-memory-embedding')
    await flushLongTermSyncOutbox(embedMemoryText)
  }

  async function queueExistingLongTermMemories(): Promise<void> {
    if (!longTermSyncEnabled.value || !isLeader.value)
      return
    const memoryRepository = await initialize()
    if (!memoryRepository)
      return
    const fragments = await memoryRepository.list({ memoryType: 'long_term', limit: 10_000 })
    for (const fragment of fragments)
      enqueueLongTermSync(fragment)
    await refreshRemoteHostStatus()
    await retryLongTermSync()
  }

  // Expiry scheduler for the outbox backoff: without it a failed delivery
  // would sit until the next promotion or a manual retry happened to trigger
  // another flush. Only the leader runs it — it is the single delivery owner.
  let syncRetryTimer: ReturnType<typeof setInterval> | undefined
  watch([longTermSyncEnabled, isLeader, remoteStatus], ([enabled, leader, status]) => {
    const shouldRun = enabled && leader && status === 'ready'
    if (shouldRun && syncRetryTimer === undefined) {
      syncRetryTimer = setInterval(() => {
        void (async () => {
          const { embedMemoryText } = await import('../../services/memory/local-memory-embedding')
          await flushLongTermSyncOutbox(embedMemoryText)
        })()
      }, 60_000)
    }
    else if (!shouldRun && syncRetryTimer !== undefined) {
      clearInterval(syncRetryTimer)
      syncRetryTimer = undefined
    }
  }, { immediate: true })

  // The database owner also owns source validation and its shared error.
  // A follower validation error would propose its entire startup snapshot,
  // replacing restored switches and database health before the first sync.
  // The initial validation belongs to initialize(), after restore. Starting it
  // here before election can also queue the leader's stale startup snapshot.
  // Remote snapshots must never start validation or migration in followers.
  watch([embeddingSource, embeddingBaseUrl, embeddingApiKey, embeddingModel], async () => {
    if (!isLeader.value || !repository.value)
      return
    backgroundVectorsReady = false
    const sourceReady = await applyEmbeddingSource()
    if (repository.value && sourceReady)
      await migrateEmbeddingSpace(repository.value, true)
  }, { immediate: true })

  function resetState() {
    enabled.reset()
    captureEnabled.reset()
    directoryEnabled.value = false
    toolsEnabled.value = false
    if (isLeader.value) {
      localStorage.removeItem('settings/memory/directory-enabled')
      localStorage.removeItem('settings/memory/tools-enabled')
    }
    compactionEnabled.reset()
    activeProvider.reset()
    activeModel.reset()
    compactionThreshold.reset()
    contextLengthOverride.reset()
    compactionRecentTurnLimit.reset()
    shortTermHalfLifeHours.reset()
    longTermHalfLifeHours.reset()
    promotionAccessCount.reset()
    promotionSessionCount.reset()
    weightSimilarity.reset()
    weightTimeRelevance.reset()
    weightArousal.reset()
    weightAccessCount.reset()
    weightMoodCongruence.reset()
    intrusionEnabled.reset()
    intrusionBaseRate.reset()
    intrusionCooldownMs.reset()
    dreamingEnabled.reset()
    automaticDreamingEnabled.reset()
    dreamingIntervalHours.reset()
    dreamingDailyBudget.reset()
    dreamingMinNewMemoryCount.reset()
    lastDreamAt.reset()
    dreamingBudgetUsed.reset()
    dreamingBudgetDateKey.reset()
    longTermSyncEnabled.reset()
    longTermSyncOutbox.reset()
    lastLongTermSyncAt.reset()
    lastLongTermSyncError.reset()
    embeddingSource.reset()
    embeddingBaseUrl.reset()
    embeddingApiKey.reset()
    embeddingModel.reset()
    embeddingFingerprint.reset()
    embeddingMigration.reset()
    embeddingError.value = undefined
    captureFailure.value = undefined
    pgConnectionString.reset()
    remoteStatus.value = 'unconfigured'
    remoteError.value = undefined
    dreamIdeas.value = []
    dreaming.value = false
    currentMood.value = { valence: 0, arousal: 0 }
  }

  return {
    enabled,
    captureEnabled,
    captureError: computed(() => captureFailure.value),
    directoryEnabled,
    toolsEnabled,
    setInteractionSettings,
    directory,
    proposeOperation,
    operationStatus,
    listOperations,
    confirmOperation,
    editPresentation,
    readBodies,
    recordBodyReads,
    confirmedReferences,
    factsRevision,
    compactionEnabled,
    activeProvider,
    activeModel,
    compactionThreshold,
    contextLengthOverride,
    compactionRecentTurnLimit,
    shortTermHalfLifeHours,
    longTermHalfLifeHours,
    promotionAccessCount,
    promotionSessionCount,
    weightSimilarity,
    weightTimeRelevance,
    weightArousal,
    weightAccessCount,
    weightMoodCongruence,
    intrusionEnabled,
    intrusionBaseRate,
    intrusionCooldownMs,
    dreamingEnabled,
    automaticDreamingEnabled,
    dreamingIntervalHours,
    dreamingDailyBudget,
    dreamingMinNewMemoryCount,
    lastDreamAt,
    dreamingBudgetUsed,
    dreamingBudgetDateKey,
    longTermSyncEnabled,
    linkLocalHistory,
    longTermSyncOutbox,
    lastLongTermSyncAt,
    lastLongTermSyncError,
    embeddingSource,
    embeddingBaseUrl,
    embeddingApiKey,
    embeddingModel,
    embeddingError,
    embeddingMigration,
    pgConnectionString,
    remoteStatus,
    remoteError,
    configureRemoteHost,
    refreshRemoteHostStatus,
    retryLongTermSync,
    queueExistingLongTermMemories,
    dreamIdeas,
    dreaming,
    configured,
    databaseStatus,
    databaseError,
    databasePersistenceStatus,
    currentMood,
    isLeader,
    initialize,
    getScoreWeights,
    retrieve,
    retrieveForEvaluation,
    retrieveEvaluationTrace,
    evaluateProductionRetrieval,
    captureTurn,
    captureEvent,
    list,
    listShareableFacts,
    update,
    remove,
    listPending,
    setReviewStatus,
    reviseFact,
    rememberMuscle,
    convertMuscleToFact,
    refreshDreamIdeas,
    dream,
    runAutomaticDreaming,
    updateDreamIdea,
    reembedMemoryVectors,
    setMood,
    setEmotion,
    restorePersistedSettings,
    resetState,
  }
}, {
  synced: {
    state: true,
    // Settings windows are followers: their review/browse/dream UI must
    // operate on the leader's database, so these actions are leader-routed.
    // capture/retrieve stay local — the chat runtime calls them in the
    // leader itself on every turn.
    // NOTE: "initialize" intentionally stays out — it returns the repository
    // object (functions are not cloneable), and it must run per-window anyway:
    // the leader opens the database, followers no-op through the same guard.
    actions: [
      'setInteractionSettings',
      'listOperations',
      'confirmOperation',
      'editPresentation',
      'list',
      'listPending',
      'setReviewStatus',
      'reviseFact',
      'retrieve',
      'refreshDreamIdeas',
      'updateDreamIdea',
      'reembedMemoryVectors',
      'dream',
      'runAutomaticDreaming',
      'update',
      'remove',
      'convertMuscleToFact',
      'configureRemoteHost',
      'refreshRemoteHostStatus',
      'retryLongTermSync',
      'queueExistingLongTermMemories',
    ],
  },
})
