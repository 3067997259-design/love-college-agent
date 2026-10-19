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
  'mcp-invalid-result', 'operation-cancelled', 'backup-invalid', 'backup-scope-mismatch', 'restore-failed', 'command-encoding-unsupported', 'content-filtered'] as const
export type PublicErrorCode = typeof PUBLIC_ERROR_CODES[number]

export interface PublicError {
  code: PublicErrorCode
  retryable: boolean
  /** Opaque local diagnostic reference, never an exception message or remote response. */
  detailsId?: string
}

export interface Scope { userId: string; characterId: string; sessionId: string }
export interface ClockView { nowMs: number; timeZone: string; rate: number; frozen: boolean }
/** D3 attention: the single place that decides what she currently has in hand. */
export type AttentionKind = 'rest' | 'user' | 'task' | 'gift' | 'life' | 'idle'
export interface AttentionView {
  kind: AttentionKind
  pose: 'sleeping' | 'facing-user' | 'desk-computer' | 'desk-writing'
  /** A task exists and is waiting for the user; it does not occupy her time. */
  taskWaiting: boolean
  focusRunning: boolean
}
export interface CompanionView {
  mode: InteractionMode
  lightsOut: boolean
  /** Main-owned sleep, separate from lights/pause. Older snapshots may omit it (awake). */
  sleeping?: boolean
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
  /** One-line manifest description; absent for built-ins without a curated description. */
  description?: string
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
/** D1 task object view. Proposals and plans are not authorization; approval binds one plan version. */
export type TaskCardStatus = 'proposed' | 'approved' | 'active' | 'completed' | 'abandoned' | 'failed'
export interface TaskPlanView { version: number; source: 'model' | 'user'; steps: readonly PlanStep[] }
export interface TaskApprovalView { planVersion: number; scope: { writes: 'desk'; commands: 'each' }; approvedAtMs: number }
export interface TaskCheckpointView { id: string; summary: string; createdAtMs: number; source: 'model' | 'code'; evidenceSeqs?: readonly number[] }
/** D2 safety state for the currently running turn: third-party originals were part of its request. */
export interface DegradedView { active: boolean; turnId: string; sources: readonly ('mail' | 'document' | 'web' | 'mcp' | 'plugin')[] }
export interface TaskCardView {
  id: string
  title: string
  goalId?: string
  workspace: 'desk'
  status: TaskCardStatus
  plan?: TaskPlanView
  approval?: TaskApprovalView
  checkpoints: readonly TaskCheckpointView[]
  createdAtMs: number
  updatedAtMs: number
  closedAtMs: number | null
}
export interface MessageView {
  id: string
  role: 'user' | 'assistant' | 'narrator'
  text: string
  createdAtMs: number
  status: 'streaming' | 'complete' | 'interrupted' | 'undelivered'
  emotion?: string
  /** Code-owned failure narration. No exception body, provider config or model reasoning. */
  failure?: ModelFailureView
}
export interface ModelFailureView {
  turnId: string
  code: PublicErrorCode
  category: 'configuration' | 'network' | 'upstream' | 'quota' | 'budget' | 'content-filtered' | 'interrupted' | 'invalid-response' | 'execution-guard' | 'internal'
  attemptCount: number
  toolsExecuted: boolean
  httpStatus?: number
  /** Optional original request already visible to the book user. Resending requires user review. */
  sourceMessageId?: string
  /** Original user-selected seen reference. Restore the quote with the question;
   * sending still creates a fresh history.recall and revalidates scope and budgets. */
  sourceRecallAnchor?: RecallAnchor
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
export type ModelProviderSlot = 'chat' | 'background' | 'chat_google' | 'chat_claude' | 'privacy'
export interface ModelRouting { background: 'follow-main' | 'independent'; privacy: 'follow-main' | 'independent' }
export interface ModelSettingsView {
  routing?: ModelRouting
  status: 'idle' | 'selecting' | 'saved' | 'failed'
  configuredSlots: readonly ModelProviderSlot[]
  restartRequired: boolean
  /** Latest user-requested connectivity probe; never carries URL, model name, key or response text. */
  probe?: { slot: ModelProviderSlot; status: 'testing' | 'ok' | 'failed'; code?: PublicErrorCode; atMs: number }
  /** Presence only: never URLs, mail user, voices or keys. */
  services?: { tts: boolean; rodin: boolean; mail: boolean }
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
  /** User said yes; actual making still waits for focus. Not proof of generation. */
  acceptedAtMs?: number
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
  /** D1 task objects. Optional so older renderer fixtures and pre-D1 snapshots stay valid. */
  tasks?: readonly TaskCardView[]
  /** The single task currently in hand, if any. */
  activeTaskId?: string | null
  /** D2: present while the running turn's request contains third-party originals. */
  degraded?: DegradedView
  /** D3: what she currently has in hand; derived in main, never a permission grant. */
  attention?: AttentionView
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
  voice?: VoiceView
  /** Local resource admissions survive private-book restore. No prices, provider names or secrets. */
  resources?: ResourceBudgetView
  /** A single current model question. Queued questions expose no prompt until rest. */
  question?: UserQuestionView
  /** Main-owned optional game context. No MCP launch config, URLs, tokens or raw game transcript. */
  minecraft?: MinecraftView
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
export interface FlowGoalView {
  id: string
  text: string
  status: 'active' | 'completed' | 'cancelled'
  createdAtMs: number
  updatedAtMs: number
  closedAtMs: number | null
  flowIds: readonly string[]
  /** A user's status decision, never proof that the model performed an external action. */
  confirmedBy: 'user'
}
export interface FlowOperationView {
  id: string
  flowId: string
  kind: 'init' | 'review'
  /** ready means an actual unreviewed draft file exists, never that code passed review or tests. */
  status: 'running' | 'ready' | 'failed' | 'cancelled'
  source: 'real' | 'fake'
  sourceCount: number
  omittedSourceCount: number
  outputPath: string
  createdAtMs: number
  updatedAtMs: number
  artifact?: { changeId: string; sha256: string; byteLength: number }
  error?: 'no-product' | 'source-changed' | 'interrupted' | 'cancelled' | 'unavailable'
}
export interface HeartFlowView {
  activeId: string | null
  mode: 'plan' | 'execute'
  execution: 'javascript-sandbox' | 'disabled'
  /** Independent from the JavaScript worker; missing means this backend is not installed. */
  commandExecution?: 'windows-appcontainer' | 'unavailable' | 'disabled'
  /** User-only command text and execution receipts. stdout/stderr never enter snapshots. */
  command?: DeskCommandView
  /** Metadata only. Rewinds recorded desk files, never shell/network side effects or log history. */
  rewind?: FlowRewindView
  /** Source and output text are user-only; models obtain approved work through desk tools. */
  pending?: { id: string; code: string }
  files: readonly { path: string; byteLength: number }[]
  changes: readonly { id: string; path: string; undone: boolean; shadow?: DeskShadowView }[]
  sessions: readonly { id: string; startedAtMs: number; endedAtMs: number | null; summary: string | null }[]
  lastRun?: { ok: boolean; output: string }
  /** Metadata-only subordinate work. Conclusions are unreviewed tool results for the parent flow. */
  delegates?: readonly DelegateView[]
  /** Scoped across day pages and flow instances. Only explicit user commands may edit or close. */
  goals?: readonly FlowGoalView[]
  goalId?: string | null
  /** User-only draft metadata. Contents stay in the desk/work context and native preview. */
  operations?: readonly FlowOperationView[]
  computer?: DeskComputerView
  webFetch?: FlowFetchView
}

export interface FlowRewindView {
  id: string
  changeId: string
  createdAtMs: number
  status: 'awaiting-confirmation' | 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted'
  paths: readonly string[]
  changeCount: number
  /** Confirmed per-file writes. Cross-file publication is not atomic. */
  appliedFiles: number
  error?: 'conflict' | 'write-failed' | 'unavailable'
}

export interface DeskCommandView {
  id: string
  shell: 'cmd'
  scope: 'desk-snapshot'
  command: string
  timeoutMs: number
  createdAtMs: number
  status: 'preparing' | 'awaiting-approval' | 'running' | 'completed' | 'failed' | 'cancelled'
  fileCount: number
  /** Immutable snapshot of approved inputs. No absolute path or source text. */
  snapshotHash?: string
  outcome?: {
    exitCode: number | null
    /** Null when a crash left no durable process receipt. */
    elapsedMs: number | null
    processTreeTerminated: boolean | null
    /** Unknown never implies no effects; appliedFiles remains confirmed evidence. */
    publication: 'unchanged' | 'applied' | 'not-applied' | 'partial' | 'unknown'
    changedFiles: number | null
    /** Confirmed publications; a lower bound when publication is unknown. */
    appliedFiles: number
  }
  error?: PublicError
}
export interface FlowFetchView {
  source: 'real' | 'fake'
  requestsUsed: number
  maxRequests: number
  pending?: { id: string; url: string }
  status: 'idle' | 'waiting-approval' | 'fetching'
  last?: { url: string; status: 'fetched' | 'denied' | 'failed' | 'cancelled'; atMs: number; receivedBytes?: number; truncated?: boolean }
}
export type DeskComputerAction = { type: 'click'; x: number; y: number } | { type: 'type'; text: string } | { type: 'key'; key: 'TAB' | 'ENTER' | 'ESCAPE' | 'BACKSPACE' }
/** An isolated static HTML desk preview, never the user's whole computer or an existing application. */
export interface DeskComputerView {
  status: 'closed' | 'opening' | 'ready' | 'waiting-approval' | 'acting' | 'failed'
  target?: { path: string; sha256: string }
  frame?: { ref: string; sha256: string; width: number; height: number; capturedAtMs: number }
  pending?: { id: string; frameRef: string; action: DeskComputerAction }
  actionsUsed: number
  maxActions: number
  /** Scripts/network/downloads/filesystem are disabled. Reopening never inherits action approval. */
  scope: 'static-desk-preview'
  error?: PublicError
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
  changes: readonly { id: string; path: string; before: string | null; after: string | null; current: boolean; undone: boolean; shadow?: DeskShadowView }[]
  truncated: boolean
}
/** Independent private Git copy; never stages or commits into the user's repository. Journal snapshots remain authoritative. */
export interface DeskShadowView { status: 'committed' | 'not-git' | 'unavailable' | 'failed'; commit?: string }
export interface MinecraftScope {
  radiusBlocks: number; durationMs: number; allowChat: boolean
  /** Explicit round consent; absent means false, independent of MCP connection approval. */
  allowScreenshots?: boolean
  allowMining?: boolean
}
export const MINECRAFT_FEATURES = ['inventory', 'scene', 'look', 'screenshot', 'mining'] as const
export type MinecraftFeature = typeof MINECRAFT_FEATURES[number]
export interface VoiceView {
  enabled: boolean
  available: boolean
  source: 'real' | 'fake' | 'none'
  /** Output speech only; no microphone or voice cloning. Audio is ephemeral and never replayed after restart. */
  utterance?: { id: string; messageId: string; status: 'synthesizing' | 'ready' | 'cancelled' | 'failed';
    playback: 'idle' | 'playing' | 'ended' | 'failed'; chunkCount: number; byteLength: number; createdAtMs: number }
  error?: PublicError
}
export interface ResourceBudgetView {
  status: 'ready' | 'unavailable'
  /** Conservative reservations before dispatch; never actual billing or fabricated currency cost. */
  accounting: 'reserved-units'
  /** Only the book's booth operator can change daily model limits. */
  configurable: boolean
  model: {
    dayKey: string
    totalReservedUnits: number | null
    autonomousReservedUnits: number | null
    totalLimitUnits: number
    autonomousLimitUnits: number
    attemptCount: number | null
    legacyReservedUnits: number | null
  }
  speech: {
    dayKey: string
    reservedChars: number | null
    charLimit: number
    attemptCount: number | null
    attemptLimit: number
  }
}
export type UserQuestionView = {
  id: string
  taskId: string
  createdAtMs: number
  context: 'conversation' | 'work'
} & ({ status: 'queued' } | {
  status: 'waiting'
  question: string
  choices: readonly string[]
  /** Main-owned ten-minute visible-time deadline; quiet/focus time does not consume it. */
  expiresAtMs: number
})
export interface VoiceRead {
  utteranceId: string
  format: 'pcm_s16le'
  sampleRate: 24000
  channels: 1
  /** At most eight chunks per read, each <= 16 KiB. No provider configuration or source text. */
  chunks: readonly { index: number; pcmBase64: string }[]
  done: boolean
}
export interface MinecraftView {
  status: 'idle' | 'checking' | 'ready' | 'playing' | 'paused' | 'stopping' | 'failed'
  source: 'real' | 'fake' | 'none'
  serverId: string | null
  pilot?: { uuid: string; name: string; dimension: string; position: { x: number; y: number; z: number } }
  scope?: MinecraftScope
  roundId: string | null
  endsAtMs: number | null
  actionsUsed: number
  maxActions: number
  chatSeen: number
  /** Only a matching release/ownership observation may set true; RPC cancellation alone is insufficient. */
  stopVerified: boolean
  checks?: { commandsDisabled: boolean; worldWriteDisabled: boolean; worldBound: boolean }
  /** Optional endpoint tools whose schemas were checked. Round scope still controls their use. */
  features?: readonly MinecraftFeature[]
  lastAction?: { kind: 'navigate' | 'chat' | 'look' | 'mine'; status: 'running' | 'succeeded' | 'failed' | 'cancelled' | 'unknown'; atMs: number }
  error?: PublicError
}
