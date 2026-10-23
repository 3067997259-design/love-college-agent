// Only bridge-authored metadata. DSH owns the task board and all execution.
export const COLLABORATION_KEY = 'lca-collaboration-v1'
export const RETIRED_TASK = '[LCA retired source-derived task text; obtain fresh evidence before continuing.]'
export const cleanLine = (value, max = 200) => typeof value === 'string' ? value.replace(/\p{Cc}/gu, ' ').slice(0, max) : ''
const validLease = (value) => value && typeof value.authorizationId === 'string' && Array.isArray(value.sources)
  && value.sources.every((source) => ['mail', 'document', 'web', 'mcp', 'plugin', 'member'].includes(source))
const recordMap = (value) => value && typeof value === 'object' && !Array.isArray(value)
const validOperation = (value, id) => value?.requestId === id && value.error === null
  && (value.phase === 'running' && value.outcome === 'pending' || value.phase === 'settled' && ['accepted', 'failed'].includes(value.outcome))
const validMember = (value) => validLease(value) && (!value.labelLease || validLease(value.labelLease))
  && (!value.outcome || ['none', 'completed', 'aborted', 'failed', 'refused', 'unknown'].includes(value.outcome))
export const turnOutcome = (reason) => reason === 'completed' ? 'completed' : ['aborted', 'cancelled', 'interrupted'].includes(reason) ? 'aborted'
  : reason === 'error' ? 'failed' : ['blocked', 'refusal'].includes(reason) ? 'refused' : 'unknown'
export function collaborationProjection() {
  return {
    key: COLLABORATION_KEY, stateVersion: 1,
    init: () => ({ members: {}, tasks: {}, operations: {}, lastOperation: null }),
    stateSchema: { parse(value) {
      if (!recordMap(value?.members) || !recordMap(value.tasks) || !recordMap(value.operations)
        || !Object.values(value.tasks).every((entry) => validLease(entry) && Number.isSafeInteger(entry.revision) && entry.revision > 0)
        || !Object.values(value.members).every(validMember) || !Object.entries(value.operations).every(([id, entry]) => validOperation(entry, id))
        || value.lastOperation !== null && !Object.hasOwn(value.operations, value.lastOperation)) throw new Error('LCA_COLLABORATION_STATE_INVALID')
      return value
    } },
    apply(state, event) {
      if (event.type !== 'plugin:lca/collaboration') return state
      const { kind, id, value } = event.data
      if (kind === 'operation') {
        if (typeof id !== 'string' || !validOperation(value, id)) throw new Error('LCA_OPERATION_RECORD_INVALID')
        return { ...state, operations: { ...state.operations, [id]: value }, lastOperation: id }
      }
      if (!['member', 'task'].includes(kind) || typeof id !== 'string' || !(kind === 'member' ? validMember(value) : validLease(value) && Number.isSafeInteger(value.revision) && value.revision > 0)) throw new Error('LCA_COLLABORATION_RECORD_INVALID')
      const key = kind === 'task' ? 'tasks' : 'members'
      return { ...state, [key]: { ...state[key], [id]: value } }
    },
  }
}
export function taskVisible(task, lease, authorizationId) {
  return !!validLease(lease) && lease.revision === task.revision && (lease.sources.length === 0 || lease.authorizationId === authorizationId)
}
/** Revision-only edits must retain the old lease, including already retired text. */
export function nextTaskLease(previous, current, revision) {
  if (!previous) return { authorizationId: 'unverified', sources: ['member'], revision }
  return { authorizationId: previous.authorizationId, sources: [...new Set([...previous.sources, ...current.sources])], revision }
}
