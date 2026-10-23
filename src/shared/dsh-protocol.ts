import type { AgentAddress, AgentMode, AgentSource } from './collaboration'
import type { CollaborationCommand, CollaborationView } from './collaboration'

/** Main <-> trusted DSH subprocess only; NEVER expose these internal records to renderer/debug. */
export const DSH_PROTOCOL_VERSION = 2 as const
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
export interface DshCollaborationRequest { rootSessionId: string; command: CollaborationCommand }
export interface DshCollaborationReply { view: CollaborationView }
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
