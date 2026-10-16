/** Public, serializable UI projections. Never put credentials or raw tool results here. */
export const PROTOCOL_VERSION = 1 as const
export const EXPRESSION_IDS = ['calm', 'smile', 'think', 'worried'] as const
export const DEFAULT_EXPRESSION = 'calm' as const
export const POSE_IDS = ['desk-computer', 'desk-writing', 'facing-user', 'sleeping'] as const
export type KnownExpressionId = typeof EXPRESSION_IDS[number]
export type KnownPoseId = typeof POSE_IDS[number]
export type Daypart = 'morning' | 'day' | 'evening' | 'night'
export type InteractionMode = 'work' | 'quiet' | 'rest'
export type Availability = 'unavailable' | 'unconfigured' | 'connecting' | 'ready' | 'failed'
export type TaskStatus = 'queued' | 'running' | 'waiting-user' | 'cancelling' | 'completed' | 'aborted' | 'failed'
export const PUBLIC_ERROR_CODES = ['invalid-command', 'stale-epoch', 'unavailable', 'not-configured', 'permission-denied', 'connection-failed', 'privacy-unavailable', 'internal',
  'configuration-failed', 'upstream-busy', 'quota-exhausted', 'stream-interrupted', 'invalid-model-output', 'step-limit', 'repeat-limit', 'budget-exceeded',
  'privacy-invalid-output', 'evidence-unavailable', 'stale-candidate', 'export-failed', 'source-blocked',
  'unsupported-file', 'file-too-large', 'file-unreadable', 'document-parse-failed', 'document-interrupted', 'memory-invalid-output', 'context-too-large',
  'mcp-invalid-result', 'operation-cancelled', 'backup-invalid', 'backup-scope-mismatch', 'restore-failed'] as const
export type PublicErrorCode = typeof PUBLIC_ERROR_CODES[number]

export interface PublicError {
  code: PublicErrorCode
  retryable: boolean
  /** Opaque local diagnostic reference, never an exception message or remote response. */
  detailsId?: string
}

export interface Scope { userId: string; characterId: string; sessionId: string }
export interface ClockView { nowMs: number; timeZone: string; rate: number; frozen: boolean }
export interface CompanionView {
  mode: InteractionMode
  lightsOut: boolean
  locationId: string
  pose: string
  expression: string
  daypart: Daypart
  /** Meaningful only while the mail capability is ready. Failure is not zero new mail. */
  mailboxUnseen: number
}
export interface PomodoroView {
  phase: 'idle' | 'focus' | 'short-break' | 'long-break'
  status: 'idle' | 'running' | 'paused'
  remainingMs: number
  endsAtMs: number | null
  focusIndex: number
  phaseDurationMs: number
  plannedCount: number
  /** A proposed plan requires a separate user confirmation before it can run. */
  plan?: PomodoroPlanView
}
export interface PomodoroPlanInput {
  label: string
  plannedCount: number
  focusDurationMs: number
  shortBreakDurationMs: number
  longBreakDurationMs: number
  longBreakEvery: number
  timing: 'standard' | 'demo' | 'custom'
}
export interface PomodoroPlanView extends PomodoroPlanInput {
  id: string
  createdAtMs: number
  status: 'proposed' | 'confirmed' | 'finished'
  source: 'user' | 'assistant'
}
export interface PluginView {
  id: string
  name: string
  version: string
  source: 'builtin' | 'folder'
  status: 'enabled' | 'disabled' | 'needs-approval' | 'incompatible' | 'failed'
  tools: readonly string[]
  privacy: 'none' | 'optional' | 'always'
  /** Mandatory source isolation cannot be weakened by a plugin preference. */
  privacyLocked?: boolean
  permissions: readonly ('local-code' | 'network' | 'filesystem')[]
  /** Consent is bound to this exact manifest/code revision, never only a plugin name. */
  fingerprint: string
}
export interface RuntimeView {
  plugins: readonly PluginView[]
  developer: {
    mode: 'normal' | 'developer' | 'booth'
    requestedEnabled: boolean
    restartRequired: boolean
    mcpPort?: number
    cdpPort?: number
    sceneId?: string
    error?: PublicError
  }
}
export interface PlanStep { id: string; text: string; status: 'pending' | 'active' | 'done' | 'failed' }
export interface TaskView {
  id: string
  status: TaskStatus
  steps: readonly PlanStep[]
  error?: PublicError
}
export interface MessageView {
  id: string
  role: 'user' | 'assistant' | 'narrator'
  text: string
  createdAtMs: number
  status: 'streaming' | 'complete' | 'interrupted' | 'undelivered'
  emotion?: string
}
export interface ActivityView {
  id: string
  taskId: string
  toolCallId: string
  templateId: string
  status: 'running' | 'completed' | 'failed' | 'cancelled' | 'unknown'
  /** Validated short fields for a display template; no arguments or raw output. */
  fields: Readonly<Record<string, string | number | boolean>>
  error?: PublicError
}
export interface CandidateView {
  id: string
  createdAtMs: number
  kind: 'deadline' | 'event'
  title: string
  deadlineIso: string | null
  plannedCompletionIso: string | null
  status: 'candidate' | 'confirmed' | 'changed' | 'ignored'
  eventStartIso?: string
  eventEndIso?: string
  locationText?: string
  /** Present on real IPC snapshots; optional only for older UI fixtures. */
  revision?: number
  source?: 'real' | 'fake'
  /** A changed proposal leaves the previously accepted schedule in force until confirmed. */
  change?: { previousDeadlineIso: string | null; previousEventStartIso?: string; previousEvidenceRef: string }
  /** Validated short label, not a raw subject or sender address. */
  sourceLabel: string
  /** Evidence is fetched separately for the user, never carried into model context. */
  evidenceRef: string
}
export interface DeliveryView {
  id: string
  createdAtMs: number
  artifactId: string
  displayName: string
  kind: 'calendar' | 'markdown' | 'document' | 'gift'
  status: 'ready' | 'failed'
  sourceRefs: readonly string[]
  source?: 'real' | 'fake'
}
export interface EvidenceView {
  subject: string
  senderName: string
  receivedAtMs: number
  excerpt: string
  /** UTF-16 offsets into excerpt; start inclusive, end exclusive. */
  highlights: readonly { start: number; end: number; field: 'deadlineIso' | 'eventStartIso' | 'eventEndIso' | 'locationText' | 'title' }[]
}
export const MAIL_SCENARIO_IDS = ['initial', 'deadline-change', 'malicious', 'privacy-failure', 'empty'] as const
export type MailScenarioId = typeof MAIL_SCENARIO_IDS[number]
export interface MailboxView {
  status: 'blocked' | 'idle' | 'scanning' | 'ready' | 'failed' | 'disabled'
  source: 'real' | 'fake'
  folderLabel: '桃子'
  /** Null means not observed; failure is never converted to zero unread. */
  unseenCount: number | null
  lastAttemptAtMs: number | null
  lastSuccessAtMs: number | null
  processedCount: number
  pendingReviewCount: number
  scenarioId?: MailScenarioId
  error?: PublicError
}
export interface CapabilityView {
  id: 'chat' | 'pomodoro' | 'mail' | 'privacy' | 'memory' | 'backup' | 'mcp' | 'rodin' | 'heart-flow'
  status: Availability
  source: 'real' | 'fake' | 'none'
  error?: PublicError
}
export type DocumentFormat = 'pdf' | 'text' | 'markdown'
export const DOCUMENT_SCENARIO_IDS = ['ready', 'privacy-failure', 'malicious'] as const
export type DocumentScenarioId = typeof DOCUMENT_SCENARIO_IDS[number]
export interface FileAttachmentView {
  id: string
  candidateId?: string
  /** Code-generated label, never an original attachment name or local path. */
  displayName: string
  byteLength: number
  format: DocumentFormat
  source: 'real' | 'fake'
}
export interface DocumentView {
  id: string
  createdAtMs: number
  updatedAtMs: number
  displayName: string
  origin: 'mail-attachment' | 'drop'
  format: DocumentFormat
  byteLength: number
  source: 'real' | 'fake'
  status: 'staged' | 'queued' | 'processing' | 'ready' | 'failed' | 'cancelled'
  pageCount: number | null
  deadlineIso: string | null
  error?: PublicError
}
export interface DocumentsView {
  jobs: readonly DocumentView[]
  attachments: readonly FileAttachmentView[]
  privacyAvailable: boolean
  scenarioId?: DocumentScenarioId
}
export interface FileImportAck {
  acceptedIds: readonly string[]
  rejectedCount: number
  error?: PublicError
}
export interface MemoryItemView {
  id: string
  text: string
  kind: 'fact' | 'experience'
  tier: 'short_term' | 'long_term'
  reviewStatus: 'unreviewed'
  createdAtMs: number
  accessCount: number
  sourceSessionCount: number
  supersededBy?: string
}
export interface MemoryView {
  status: 'unconfigured' | 'idle' | 'extracting' | 'compacting' | 'failed'
  source: 'real' | 'fake' | 'none'
  shortTermCount: number
  longTermCount: number
  contextChars: number
  lastExtractedAtMs: number | null
  lastCompactedAtMs: number | null
  /** Bounded display of safe, unreviewed memories; never original private source material. */
  items: readonly MemoryItemView[]
  scenarioId?: 'ready' | 'failure' | 'invalid'
  error?: PublicError
}
export interface SessionPageInfo { sessionId: string; dayKey: string; messageCount: number; summarized: boolean }
export interface SessionView {
  dayKey: string
  rolloverPending: boolean
  /** Metadata only; user-only page reads are separate from the model context. */
  pages: readonly SessionPageInfo[]
}
export interface SessionPage { sessionId: string; dayKey: string; messages: readonly MessageView[]; truncated: boolean }
export interface McpServerView {
  id: string
  transport: 'stdio' | 'http'
  status: 'disconnected' | 'connecting' | 'ready' | 'failed'
  source: 'real' | 'fake'
  /** Consent binds the private configuration and selected tool allowlist. No config values are exposed. */
  fingerprint: string
  privacy: 'none' | 'always'
  tools: readonly string[]
  error?: PublicError
}
export interface McpView { servers: readonly McpServerView[]; error?: PublicError }
export interface SaveSummary { savedAtMs: number; source: 'real' | 'fake'; pageCount: number; messageCount: number; memoryCount: number; deliveryCount: number }
export interface BackupView {
  status: 'idle' | 'exporting' | 'exported' | 'validating' | 'awaiting-confirmation' | 'restoring' | 'restored' | 'failed'
  operationId?: string
  archiveId?: string
  exportedAtMs?: number
  restoreId?: string
  incoming?: SaveSummary
  safetyBackupId?: string
  error?: PublicError
}
export interface QuillView {
  id: string
  state: 'ready' | 'given'
  createdAtMs: number
  givenAtMs: number | null
  sourceMemoryId: string
  sourceEventId: string
  /** Built-in first gift. Live Rodin generation is a later feature. */
  kind: 'quill'
}
export interface AppSnapshot {
  protocolVersion: typeof PROTOCOL_VERSION
  epoch: string
  revision: number
  scope: Scope
  clock: ClockView
  companion: CompanionView
  pomodoro: PomodoroView
  task: TaskView | null
  messages: readonly MessageView[]
  activities: readonly ActivityView[]
  candidates: readonly CandidateView[]
  deliveries: readonly DeliveryView[]
  capabilities: readonly CapabilityView[]
  privacy: { mode: 'follow-main' | 'isolated'; fileFilteringEnabled: boolean }
  /** Optional for older renderer fixtures; the real runtime supplies this. Never contains credentials. */
  runtime?: RuntimeView
  /** Source health and counts only; no message headers or bodies. */
  mailbox?: MailboxView
  /** Metadata only. Neither extracted text nor generated document contents belong here. */
  documents?: DocumentsView
  memory?: MemoryView
  session?: SessionView
  mcp?: McpView
  backup?: BackupView
  quill?: QuillView
}
