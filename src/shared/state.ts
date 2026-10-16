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
  /** Main derives completed focuses, excluding a currently running/paused focus. Old fixtures may omit it. */
  completedCount?: number
  phaseDurationMs: number
  plannedCount: number
  /** Only confirmed or finished plans; replacing a proposal never changes this field or the current phase. */
  plan?: PomodoroPlanView
  /** Pending user confirmation; a new proposal replaces only this draft. */
  proposal?: PomodoroPlanView
}
export interface PomodoroPlanItem {
  /** Short single-line text, at most 40 Unicode code points; main validates it. */
  text: string
  /** Positive integer; all item counts must sum exactly to plannedCount. */
  count: number
  assist: boolean
}
export interface PomodoroPlanInput {
  label: string
  plannedCount: number
  /** Optional daily tasks; counts include completed and currently running focuses and sum to plannedCount. */
  items?: readonly PomodoroPlanItem[]
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
  urgency?: 'normal' | 'reply-today' | 'location-change'
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
  summaryCounts?: { day: number; week: number; month: number }
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
export interface SessionPage {
  sessionId: string; dayKey: string; messages: readonly MessageView[]; truncated: boolean
  /** Main verifies successful model-input visibility; archive visibility alone does not authorize recall. */
  recallableMessageIds?: readonly string[]
  photo?: HistoryPhotoView
}
/** Half-open UTF-16 offsets into the archived message. Main resolves and validates the text. */
export interface RecallAnchor { sessionId: string; messageId: string; start: number; end: number }
export interface HistoryPhotoView {
  id: string; sessionId: string; dayKey: string; capturedAtMs: number
  reason: 'manual' | 'gift' | 'outing' | 'work' | 'day-end'
  imageUrl: string; width: number; height: number
}
export interface RecallView {
  status: 'idle' | 'recalling' | 'ready' | 'failed'
  requestId?: string; anchor?: RecallAnchor; dayKey?: string; sourceCount?: number
  photo?: HistoryPhotoView; error?: PublicError
}
export interface HistoryView {
  photos: readonly HistoryPhotoView[]
  captureStatus: 'idle' | 'capturing' | 'failed'
  captureError?: PublicError
  /** Metadata only. Historical excerpts are resolved in main and never copied into snapshots. */
  recall: RecallView
}
export type OpticalTier = 'large' | 'base' | 'small' | 'tiny'
export interface OpticalMemoryView {
  enabled: boolean
  source: 'real' | 'fake' | 'none'
  status: 'idle' | 'processing' | 'failed' | 'unconfigured'
  frames: readonly { id: string; sessionId: string; createdAtMs: number; sourceCount: number; pageIndex: number; pageCount: number }[]
  impressions: readonly { frameId: string; tier: OpticalTier; createdAtMs: number; status: 'guarded' | 'rejected'; verifiedLineCount: number; rejectedLineCount: number }[]
  error?: PublicError
}
/** Book-user lookup only. Page and guarded fragments are absent from ordinary snapshots/debug. */
export interface OpticalMemoryRead {
  frameId: string
  imageUrl: string
  impressions: readonly { tier: OpticalTier; status: 'guarded' | 'rejected'; fragments: readonly string[]; rejectedLineCount: number }[]
  uncertainty: 'unreviewed-impression'
}
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
export interface DiagnosticsView {
  contextSource: 'last-successful-input' | 'not-yet-sent'
  context: readonly { role: 'system' | 'user' | 'assistant' | 'tool'; layer: 'policy' | 'summary' | 'conversation' | 'recall'; text: string }[]
  contextTruncated: boolean
  turns: readonly { id: string; startedAtMs: number; endedAtMs: number | null; status: string; inputTokens: number | null; outputTokens: number | null; durationMs: number | null; firstTokenLatencyMs: number | null; cachedInputTokens: number | null; cost: number | null }[]
  queue: readonly { id: string; atMs: number; everyMs?: number; paused: boolean }[]
  inbox: readonly { id: string; source: string }[]
  memoryScores: readonly { id: string; score: number; relevance: number; tier: 'short_term' | 'long_term' }[]
  privacy: { mailStatus: string; fileFilteringEnabled: boolean; pendingFiles: number; evidenceAccess: 'user-only' }
}
export interface ModelSettingsView {
  status: 'idle' | 'selecting' | 'saved' | 'failed'
  configuredSlots: readonly ('chat' | 'background' | 'chat_google' | 'chat_claude' | 'privacy')[]
  restartRequired: boolean
  error?: PublicError
}
export interface WindowsView {
  mode: 'book' | 'mini'
  diagnosticsOpen?: boolean
  miniPresentation?: 'transparent' | 'opaque'
  miniFallbackReason?: 'forced' | 'gpu-unavailable' | 'black-background' | 'gpu-crash' | null
  miniBounds: { x: number; y: number; width: number; height: number } | null
  miniAlwaysOnTop: boolean
  miniClickThrough: boolean
}
export interface OnboardingView {
  status: 'needed' | 'completed'
  userName: string | null
  characterName: string
  completedAtMs: number | null
}

export const GIFT_OBJECT_IDS = ['cup', 'paper-bridge', 'leaf', 'shell', 'quill'] as const
export type GiftObjectId = typeof GIFT_OBJECT_IDS[number]
export type GiftMotif = 'plain' | 'sakura' | 'stars'
export interface GeneratedGiftView {
  id: string
  sourceMemoryId: string
  objectId: GiftObjectId
  motif: GiftMotif
  status: 'proposed' | 'making' | 'ready' | 'given' | 'failed' | 'cancelled'
  source: 'real' | 'fake'
  createdAtMs: number
  readyAtMs: number | null
  givenAtMs: number | null
  /** Content-addressed local resource; never an upstream job token, signed URL or filesystem path. */
  assetRef?: string
  assetUrl?: string
  error?: PublicError
}
export interface GiftsView { configured: boolean; dailyLimit: number; items: readonly GeneratedGiftView[] }

export interface AppSnapshot {
  characterPack?: CharacterPackView
  notifications?: NotificationsView
  diary?: DiaryView
  life?: LifeView
  heartFlow?: HeartFlowView
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
  history?: HistoryView
  /** Optional optical impressions; default text memory remains authoritative. No OCR prose/page text here. */
  opticalMemory?: OpticalMemoryView
  mcp?: McpView
  backup?: BackupView
  quill?: QuillView
  modelSettings?: ModelSettingsView
  windows?: WindowsView
  /** Main-owned, persisted per private profile/owner. Booth always projects completed. */
  onboarding?: OnboardingView
  gifts?: GiftsView
}
export interface CharacterPackView {
  activeId: string
  name: string
  /** Owned local URLs only. Missing pose -> same-pose calm -> facing-user calm -> built-in fallback. */
  images: Readonly<Record<string, string>>
  installed: readonly { id: string; name: string; builtin: boolean }[]
  status: 'idle' | 'importing' | 'exporting' | 'failed'
  restartRequired: boolean
  selectedId: string
}
export interface NotificationRule { id: string; sourceRole: 'any' | 'teaching-assistant' | 'student-club' | 'library' | 'other'; keyword: string }
export interface NotificationsView { rules: readonly NotificationRule[]; proposal?: NotificationRule; pendingCount: number; sentLastHour: number; delivery: 'native' | 'synthetic' }
export interface DiaryView { status: 'idle' | 'writing' | 'failed' | 'unconfigured'; source: 'real' | 'fake' | 'none'; entries: readonly { id: string; dayKey: string; createdAtMs: number; unlocked: boolean; clue: 'next-bookmark'; source: 'real' | 'fake' }[] }
/** Explicit user-only read, absent from snapshots, debug MCP, model contexts and memory. */
export interface DiaryRead { id: string; dayKey: string; text: string; key: string; subjective: true }
export type OutingPlace = 'coast' | 'swing'
export interface OutingView { id: string; place: OutingPlace; startsAtMs: number; returnsAtMs: number; acquiredAtMs: number; item: 'shell' | 'leaf'; status: 'proposed' | 'away' | 'returned' | 'cut_short' | 'cancelled'; settledAtMs: number | null; offline: boolean }
export interface LifeView {
  dayKey: string
  userSchedule: 'auto' | 'work' | 'rest'
  locationId: 'room' | OutingPlace
  settledUntilMs: number
  /** Fictional plans and occurrences. Never proof of real work while the app was closed. */
  agenda: readonly { kind: 'read' | 'write' | 'walk'; atMs: number; state: 'planned' | 'settled' | 'skipped' }[]
  outings: readonly OutingView[]
  items: readonly { id: string; outingId: string; dayKey: string; place: OutingPlace; kind: 'shell' | 'leaf'; acquiredAtMs: number; display: 'desk' | 'drawer' }[]
  /** Actual online work, separate from fictional outings. Text stays in the private journal/desk. */
  work?: LifeWorkView
}
export type LifeWorkKind = 'read' | 'write'
export interface LifeWorkItem {
  id: string
  dayKey: string
  kind: LifeWorkKind
  source: 'real' | 'fake'
  materialId: string
  status: 'queued' | 'running' | 'paused' | 'interrupted' | 'failed' | 'completed'
  completedSteps: number
  totalSteps: number
  createdAtMs: number
  updatedAtMs: number
  completedAtMs: number | null
  /** Codes only; never provider errors, input excerpts or generated prose. */
  reason?: 'user' | 'interrupted' | 'busy' | 'lights' | 'conflict' | 'model' | 'budget'
  /** Latest verified, immutable checkpoint in her desk; present even before the whole work completes. */
  output?: { path: string; sha256: string; byteLength: number }
}
export interface LifeWorkView {
  enabled: boolean
  source: 'real' | 'fake' | 'none'
  runningId: string | null
  attemptsToday: number
  dailyAttemptLimit: number
  /** Explicitly registered materials only; no recursive reading of arbitrary desk files. */
  materials: readonly { id: string; path: string; sha256: string; source: 'fake' }[]
  jobs: readonly LifeWorkItem[]
}
export interface HeartFlowView {
  activeId: string | null
  mode: 'plan' | 'execute'
  execution: 'javascript-sandbox' | 'disabled'
  /** Source and output text are user-only; models obtain approved work through desk tools. */
  pending?: { id: string; code: string }
  files: readonly { path: string; byteLength: number }[]
  changes: readonly { id: string; path: string; undone: boolean }[]
  sessions: readonly { id: string; startedAtMs: number; endedAtMs: number | null; summary: string | null }[]
  lastRun?: { ok: boolean; output: string }
  /** Metadata-only subordinate work. Conclusions are unreviewed tool results for the parent flow. */
  delegates?: readonly DelegateView[]
}
export interface DelegateView {
  id: string
  flowId: string
  status: 'running' | 'completed' | 'failed' | 'cancelled'
  source: 'real' | 'fake'
  sourceCount: number
  createdAtMs: number
  updatedAtMs: number
  error?: 'unavailable' | 'cancelled' | 'timeout' | 'invalid-output' | 'interrupted'
}
/** Explicit user lookup only. Raw desk diffs never enter snapshots, debug MCP or ordinary memory. */
export interface HeartFlowInspection {
  flowId: string
  section: 'status' | 'permissions' | 'diff'
  mode: 'plan' | 'execute'
  scope: 'desk-only'
  approval: 'each-run'
  execution: 'javascript-sandbox' | 'disabled'
  contextChars: number
  inputTokens: number | null
  outputTokens: number | null
  /** Unknown pricing is null, never a fabricated zero. No private provider/model values. */
  cost: number | null
  changes: readonly { id: string; path: string; before: string | null; after: string | null; current: boolean; undone: boolean }[]
  truncated: boolean
}
