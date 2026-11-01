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
  updatedAt: number
  controls: { supplement: boolean; pause: boolean; stop: boolean; resume: boolean }
}

export type ContinuousWorkCommand =
  | { type: 'work.create'; projectId: string; objective: string; acceptance: readonly string[]; decisionIds: readonly string[] }
  | { type: 'work.supplement'; target: WorkTarget; text: string; decisionId: string }
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
