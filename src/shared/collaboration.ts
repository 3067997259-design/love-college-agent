import type { PublicError } from './state'

/** Opaque, main-issued identity. runtimeId changes on every DSH launch; epoch belongs to AppCommand.
 * A member id alone is never sufficient authority. No path or transcript crosses this boundary. */
export interface AgentAddress {
  runtimeId: string
  projectId: string
  rootSessionId: string
  sessionId: string
  parentSessionId: string | null
}
export type AgentMode = 'root' | 'subagent' | 'fork' | 'teammate'
export type AgentActivity = 'starting' | 'running' | 'waiting' | 'inactive' | 'stopping' | 'unavailable'
export type AgentOutcome = 'none' | 'completed' | 'aborted' | 'failed' | 'refused' | 'unknown'
export type AgentSource = 'mail' | 'document' | 'web' | 'mcp' | 'plugin' | 'member'
/** Broad kind of work: local files and commands, looking things up, or coordinating with other members. */
export type AgentWorkArea = 'files' | 'research' | 'team'
/** What a running member is doing, derived in main from the same tool-kind table as her own steps.
 * No tool names, arguments or output; changes here never bump the member revision. */
export interface AgentWork {
  /** Calling a tool, thinking between steps, or reading a note from another member. */
  phase: 'tool' | 'thinking' | 'note'
  /** Activity template of the current tool, such as 'dsh.edit'; null outside phase 'tool'. */
  templateId: string | null
  /** Main clock time this phase began. */
  sinceMs: number
  /** Where she has mostly been working lately. Switches only after new work has held a few seconds; null before any. */
  focus: AgentWorkArea | null
  /** Thinking for 20 seconds or more without calling a tool. */
  long: boolean
}
/** Book-only, read when a member's card opens: recent tool steps from DSH's own log. Never in the snapshot, diary or memory. */
export interface MemberStepsRead {
  /** Oldest first, at most 12. The last one may still be running. */
  steps: readonly { templateId: string; status: 'running' | 'completed' | 'failed'; durationMs: number | null
    /** Project-relative file, search pattern, clipped command or site host. Only for members with no outside sources. */
    target?: string }[]
  /** Targets were left out because this member read mail, web pages or other outside content. */
  withheld: boolean
}
export interface AgentView {
  address: AgentAddress
  revision: number
  mode: AgentMode
  /** Short labels filtered in main, never a model transcript or tool arguments. */
  name: string
  taskLabel: string | null
  activity: AgentActivity
  /** Outcome of the last observed activation, independent of activity/idle state. */
  outcome: AgentOutcome
  waitingFor: 'approval' | 'member' | 'budget' | 'user' | 'recovery' | null
  controls: { message: boolean; interrupt: boolean }
  usage: { admittedUnits: number; inputTokens: number | null; outputTokens: number | null }
  sources: { status: 'clean' | 'restricted' | 'unverified'; kinds: readonly AgentSource[] }
  error: PublicError | null
  /** Final user-facing text only when no restricted source contributed; never reasoning or tool output. */
  resultText?: string | null
  /** @deprecated Raw DSH tool name; replaced by `work`. */
  activityLabel?: string | null
  /** Present while the member runs and main has seen its steps. */
  work?: AgentWork | null
}
export interface TeamTaskView {
  id: string
  rootSessionId: string
  revision: number
  subject: string
  ownerSessionId: string | null
  status: 'open' | 'claimed' | 'completed' | 'deleted'
  blockedBy: readonly string[]
  /** Display hints only. These do not lock files or grant filesystem access. */
  writeScopeLabels: readonly string[]
  scopeOverlap: boolean
  sourceStatus?: 'available' | 'retired'
}
export interface CollaborationView {
  status: 'unavailable' | 'ready' | 'recovering' | 'failed'
  runtimeId: string | null
  projectId: string | null
  members: readonly AgentView[]
  tasks: readonly TeamTaskView[]
  /** Roster slots and resident execution slots differ. null means not observable. */
  capacity?: { teamUsed: number; teamLimit: number; resident: number | null; activeLimit: number }
  operation?: { requestId: string; phase: 'running' | 'settled'; outcome: 'pending' | 'accepted' | 'failed' | 'unknown'; error: PublicError | null } | null
}
export interface AgentTarget { address: AgentAddress; expectedRevision: number }
/** Accepted means queued, never evidence that a member stopped or processed a message. */
export type CollaborationCommand =
  | { type: 'agent.refresh' }
  | { type: 'agent.message'; target: AgentTarget; text: string }
  | { type: 'agent.interrupt'; target: AgentTarget }
  | { type: 'agent.stop-family'; target: AgentTarget }
  | { type: 'team.task.update'; target: AgentTarget; taskId: string; expectedTaskRevision: number; action: 'claim' | 'release' | 'complete' | 'reopen' }
