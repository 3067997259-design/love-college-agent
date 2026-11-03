/** Durable identities are independent of a day page, a DSH process, and a project path.
 * All ids are issued by main. None of these references grants source or tool access. */
export interface ContinuityOwner {
  userId: string
  characterId: string
  dataRootId: string
}

export interface ContinuityReference {
  owner: ContinuityOwner
  sourceId: string
  eventId: string
  revision: number
  occurredAt: number
  effectiveAt: number
  purpose: 'decision' | 'memory' | 'experience' | 'checkpoint' | 'world'
  /** Original event ids survive cross-root handoff; derived text is never new experience. */
  derivedFrom: readonly string[]
}

export interface WorkIdentity {
  owner: ContinuityOwner
  projectId: string
  workId: string
  /** A new run after stop/restart gets a new generation; approvals are not carried. */
  generation: number
  objectiveRevision: number
}

export type WorkStatus = 'queued' | 'running' | 'waiting' | 'paused' | 'stopping' | 'stopped' | 'review_required' | 'completed' | 'failed'
export interface WorkTarget { identity: WorkIdentity; expectedRevision: number }

/** Safe book projection. Raw worker transcripts, third-party goals and paths stay in main. */
export interface ContinuousWorkView {
  identity: WorkIdentity
  revision: number
  label: string
  status: WorkStatus
  waitingFor: 'approval' | 'user' | 'budget' | 'project' | 'recovery' | null
  checkpointId: string | null
  delivery?: { eventId: string; state: 'pending' | 'accepted' | 'consumed' | 'unknown' }
  /** Counts of current-version executor observations, never a model percentage. */
  progress?: { observedActions: number; changedFiles: number; completedCommands: number; failedActions: number; lastObservedAt: number | null }
  updatedAt: number
  controls: { supplement: boolean; pause: boolean; stop: boolean; resume: boolean }
}

/** Structured observations from the trusted executor, never model self-reports.
 * Paths remain private until main verifies project scope and source restrictions. */
export interface WorkEvidence {
  id: string
  identity: WorkIdentity
  rootSessionId: string
  callId: string
  kind: 'artifact' | 'command' | 'tool'
  status: 'passed' | 'failed' | 'unverified'
  relativePath: string | null
  beforeHash: string | null
  afterHash: string | null
  bytes: number | null
  exitCode: number | null
  restricted: boolean
  observedAt: number
}

export interface WorkCheckpoint {
  id: string
  identity: WorkIdentity
  objective: string
  decisionIds: readonly string[]
  evidenceIds: readonly string[]
  outcome: 'completed' | 'partial'
  /** Model explanation; it is not a verified change or a new experience. */
  explanation: string
  unresolved: readonly string[]
  nextStep: string | null
  createdAt: number
}

export interface ContinuousWorksView {
  items: readonly ContinuousWorkView[]
  active: number
  limit: 2
  /** A failed ledger is unavailable, never silently replaced by an empty one. */
  failure: 'storage' | null
}

export type ContinuousWorkCommand =
  | { type: 'work.create'; projectId: string; objective: string; acceptance: readonly string[]; decisionIds: readonly string[] }
  | { type: 'work.supplement'; target: WorkTarget; text: string; decisionId: string; clarifiedDecisionIds?: readonly string[] }
  | { type: 'work.pause'; target: WorkTarget }
  | { type: 'work.stop'; target: WorkTarget }
  | { type: 'work.resume'; target: WorkTarget }
  | { type: 'work.query'; workId: string }

/** Persistent subscription receipts; accepted and consumed are distinct observations. */
export interface WorkDeliveryReceipt {
  eventId: string
  subscriptionId: string
  target: WorkIdentity
  sequence: number
  state: 'pending' | 'accepted' | 'consumed' | 'cancelled' | 'unknown'
  consumedAt: number | null
}

export interface MemoryEngineStatus {
  engine: 'airi-duckdb'
  state: 'opening' | 'ready' | 'recovering' | 'failed' | 'closed'
  checkpointAt: number | null
  pendingOperations: number
  embedding: { state: 'unconfigured' | 'ready' | 'migrating' | 'failed'; remaining: number }
  mirror: { state: 'unconfigured' | 'ready' | 'held' | 'offline'; pending: number }
  /** Fixed vocabulary only, never a database/connection/provider exception. */
  failure: 'storage' | 'reconciliation' | 'embedding' | 'mirror' | null
}

export interface MemoryFactReference {
  owner: ContinuityOwner
  id: string
  revision: number
}

export interface MemoryOperationReceipt {
  operationId: string
  state: 'intent' | 'pending_review' | 'committed' | 'published' | 'rejected' | 'conflict'
  fact: MemoryFactReference | null
  /** The UI may claim success only after the append-only completion is durable. */
  publishedEventId: string | null
}

export interface ContextTarget {
  owner: ContinuityOwner
  role: 'foreground' | 'worker'
  rootSessionId: string
  work: WorkIdentity | null
}

export interface ContextWatermark {
  sourceId: string
  revision: number
}

export type RootCompactionOutcome = 'compacted' | 'no_range' | 'busy' | 'failed'

/** User-facing fact presentation, not the underlying database or source body. */
export interface MemoryFactView {
  id: string
  revision: number
  title: string
  summary: string
  content: string
  pinned: boolean
  pinOrder: number
  memoryType: 'short_term' | 'long_term' | 'muscle'
  reviewStatus: 'pending' | 'approved' | 'rejected'
  factStatus: 'active' | 'superseded' | 'disputed'
  createdAtMs: number
}

export interface MemoryReviewView {
  operationId: string
  kind: 'remember' | 'correct' | 'forget'
  title: string
  content: string
  previousContent: string | null
  status: 'pending_review' | 'applied' | 'rejected' | 'conflict'
  updatedAtMs: number
}

/** Connection secrets are write-only. Snapshots contain no endpoint paths,
 * database names, credentials, or remote exception text. */
export interface MemorySettingsView {
  status: 'idle' | 'saving' | 'failed'
  embedding: { configured: boolean; model: string | null; host: string | null }
  mirror: { configured: boolean; enabled: boolean }
  interaction: { directoryEnabled: boolean; toolsEnabled: boolean }
  error?: 'configuration' | 'connection' | 'embedding' | 'storage'
}

export type MemorySettingsCommand =
  | { type: 'memory.settings.configure'; embedding?: { baseUrl: string; apiKey?: string; model: string } | null; mirror?: { connectionString?: string; enabled: boolean } | null }
  | { type: 'memory.settings.retry'; target: 'embedding' | 'mirror' }
  | { type: 'memory.settings.interaction'; directoryEnabled: boolean; toolsEnabled: boolean }
