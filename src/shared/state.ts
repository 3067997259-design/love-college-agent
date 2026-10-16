/** Public, serializable UI projections. Never put credentials or raw tool results here. */
export const PROTOCOL_VERSION = 1 as const
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
}
export interface PomodoroView {
  phase: 'idle' | 'focus' | 'short-break' | 'long-break'
  status: 'idle' | 'running' | 'paused'
  remainingMs: number
  endsAtMs: number | null
  focusIndex: number
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
  title: string
  deadlineIso: string | null
  plannedCompletionIso: string | null
  status: 'candidate' | 'confirmed' | 'changed' | 'ignored'
  /** Evidence is fetched separately for the user, never carried into model context. */
  evidenceRef: string
}
export interface DeliveryView {
  id: string
  artifactId: string
  displayName: string
  kind: 'calendar' | 'markdown' | 'document' | 'gift'
  status: 'ready' | 'failed'
  sourceRefs: readonly string[]
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
