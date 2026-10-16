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
export type PublicErrorCode = 'invalid-command' | 'stale-epoch' | 'unavailable' | 'not-configured' | 'permission-denied' | 'connection-failed' | 'privacy-unavailable' | 'internal'

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
  locationText?: string
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
}
export interface EvidenceView {
  subject: string
  senderName: string
  receivedAtMs: number
  excerpt: string
  /** UTF-16 offsets into excerpt; start inclusive, end exclusive. */
  highlights: readonly { start: number; end: number; field: 'deadlineIso' | 'eventStartIso' | 'locationText' | 'title' }[]
}
export interface CapabilityView {
  id: 'chat' | 'pomodoro' | 'mail' | 'privacy' | 'memory' | 'backup' | 'mcp' | 'rodin' | 'heart-flow'
  status: Availability
  source: 'real' | 'fake' | 'none'
  error?: PublicError
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
}
