import type { AgentAddress, AgentMode, AgentSource } from './collaboration'
import type { CollaborationCommand, CollaborationView } from './collaboration'
import type { WorkIdentity } from './continuity'

/** Main fixes a root's lane before it opens. This is not model-selectable authority. */
export interface DshRootPolicy {
  role: 'foreground' | 'worker'
  work: WorkIdentity | null
}

/** Main <-> trusted DSH subprocess only; NEVER expose these internal records to renderer/debug. */
export const DSH_PROTOCOL_VERSION = 2 as const
/** Ephemeral state capability: only main issues it; old replies cannot override a new user choice. */
export interface DshConversationState { mode: 'work' | 'quiet' | 'rest'; token: string }
/** One user-requested connection test through DSH's own adapter for a role's route (bridge `probe` -> `probed`). */
export interface DshProbeResult {
  ok: boolean
  durationMs: number
  route: { provider: string; model: string }
  /** DSH's normalized model failure; `message` is the provider's or transport's text. */
  failure?: { code: string; message: string; status?: number; requestId?: string }
}
export interface DshRootBinding {
  protocolVersion: typeof DSH_PROTOCOL_VERSION
  runtimeId: string
  projectId: string
  /** Canonical project path selected by main. Not a renderer-supplied directory. */
  cwd: string
}
export interface DshOrigin extends AgentAddress {
  protocolVersion: typeof DSH_PROTOCOL_VERSION
  cwd: string
}
export interface DshMemberRegistration {
  t: 'member'
  origin: DshOrigin
  /** Identity can be registered before the collaboration adapter has resolved its mode. */
  mode?: AgentMode
}
/** One pending decision belongs to one activation and one policy revision, never a standing grant.
 * Cancellation is explicit IPC; main adds its own AbortSignal when presenting the question. */
export interface DshApprovalScope {
  approvalId: string
  activationId: string
  policyRevision: number
}
export interface DshApprovalCancellation { t: 'approval-cancel'; id: string }
/** Main-owned scope. The child independently checks the visible member revision. */
export interface DshCollaborationRequest { rootSessionId: string; command: CollaborationCommand; requestId?: string }
export interface DshCollaborationReply { view: CollaborationView }
/** A member's current step as the bridge sees it, sent beside each member view. Main turns it into AgentView.work
 * and never forwards the tool name. `tool`: the current tool in phase 'tool', otherwise the last one.
 * `seq` counts steps in this DSH run, so main notices steps that two coalesced views would hide. */
export interface DshMemberStep { tool: string | null; phase: 'tool' | 'thinking' | 'note'; seq: number }
/** Bridge `member-steps` -> `member-steps-reply`: a member's recent tool steps from its own session log.
 * `target` only when the member has no outside sources; DSH times are its own epoch milliseconds. */
export interface DshMemberStepsRequest { rootSessionId: string; sessionId: string }
export interface DshMemberStepsReply {
  steps: readonly { tool: string; status: 'running' | 'completed' | 'failed'; startedAt: number; endedAt: number | null; target?: string }[]
  withheld: boolean
}
/** Provenance refers to an authorization and session-local turn, never to raw content.
 * Child turn numbers cannot be compared with root turn numbers. Unknown ancestry stays restricted. */
export interface DshSourceLease {
  id: string
  authorizationId: string
  origin: AgentAddress
  turn: number
  sources: readonly AgentSource[]
  status: 'active' | 'retired' | 'unverified'
}
