import { z } from 'zod'
import type { AppCommand, PublicErrorCode } from '../../shared'
import type { AgentAddress, MemberStepsRead, CollaborationCommand, CollaborationView } from '../../shared/collaboration'
import { agentAddressSchema } from './identity'

const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const label = z.string().max(200).refine((text) => !/\p{Cc}/u.test(text))
const id = z.string().min(1).max(160)
/** The trusted child still cannot accidentally expand renderer's projection with raw logs or paths. */
export const collaborationViewSchema = z.object({
  status: z.literal('ready'), runtimeId: id, projectId: id,
  members: z.array(z.object({ address: agentAddressSchema, revision: count, mode: z.enum(['root', 'subagent', 'fork', 'teammate']), name: label, taskLabel: label.nullable(),
    activity: z.enum(['starting', 'running', 'waiting', 'inactive', 'stopping', 'unavailable']), outcome: z.enum(['none', 'completed', 'aborted', 'failed', 'refused', 'unknown']),
    waitingFor: z.enum(['approval', 'member', 'budget', 'user', 'recovery']).nullable(), controls: z.object({ message: z.boolean(), interrupt: z.boolean() }),
    usage: z.object({ admittedUnits: count, inputTokens: count.nullable(), outputTokens: count.nullable() }),
    sources: z.object({ status: z.enum(['clean', 'restricted', 'unverified']), kinds: z.array(z.enum(['mail', 'document', 'web', 'mcp', 'plugin', 'member'])).max(6) }),
    resultText: z.string().max(2000).nullable().optional(), error: z.null(),
    step: z.object({ tool: label.nullable(), phase: z.enum(['tool', 'thinking', 'note']), seq: count }).nullable().optional(),
  })).max(512),
  tasks: z.array(z.object({ id, rootSessionId: id, revision: count, subject: label, ownerSessionId: id.nullable(), status: z.enum(['open', 'claimed', 'completed', 'deleted']),
    blockedBy: z.array(id).max(256), writeScopeLabels: z.array(label).max(256), scopeOverlap: z.boolean(), sourceStatus: z.enum(['available', 'retired']).optional() })).max(256),
  capacity: z.object({ teamUsed: count, teamLimit: count, resident: count.nullable(), activeLimit: count }),
  operation: z.object({ requestId: id, phase: z.enum(['running', 'settled']), outcome: z.enum(['pending', 'accepted', 'failed', 'unknown']), error: z.null() }).nullable().optional(),
}).superRefine((view, ctx) => {
  const roots = view.members.filter((member) => member.mode === 'root'), root = roots[0]?.address
  if (roots.length !== 1 || !root || root.parentSessionId !== null || root.sessionId !== root.rootSessionId
    || view.members.some((member) => member.address.runtimeId !== view.runtimeId || member.address.projectId !== view.projectId || member.address.rootSessionId !== root.sessionId)
    || view.tasks.some((task) => task.rootSessionId !== root.sessionId)
    || new Set(view.members.map((member) => member.address.sessionId)).size !== view.members.length) ctx.addIssue({ code: 'custom', message: 'Inconsistent collaboration scope' })
})
const empty = (): CollaborationView => ({ status: 'unavailable', runtimeId: null, projectId: null, members: [], tasks: [], operation: null })
export function createCollaborationState(options: { run(command: CollaborationCommand): Promise<CollaborationView>; readMemberSteps?(address: AgentAddress): Promise<MemberStepsRead>; changed(): void; allowed(): boolean }) {
  let value = empty(), generation = 0, pending = false
  return {
    view: (): CollaborationView => structuredClone(value),
    async readMemberSteps(address: AgentAddress): Promise<MemberStepsRead> {
      if (value.status !== 'ready' || !options.readMemberSteps || !value.members.some((member) => member.mode !== 'root' && JSON.stringify(member.address) === JSON.stringify(address))) throw new Error('LCA_MEMBER_STEPS_UNAVAILABLE')
      const token = generation, answer = await options.readMemberSteps(address)
      if (token !== generation) throw new Error('LCA_MEMBER_STEPS_UNAVAILABLE')
      return answer
    },
    busy: () => pending || value.members.some((member) => member.mode !== 'root' && ['running', 'waiting', 'stopping', 'starting'].includes(member.activity)),
    accept(view: CollaborationView) { value = { ...view, operation: view.operation && (!pending || view.operation.requestId === value.operation?.requestId) ? view.operation : value.operation }; options.changed() },
    reset(failed = false) { generation++; pending = false; value = { ...empty(), status: failed ? 'failed' : 'unavailable', operation: value.operation?.phase === 'running' ? { ...value.operation, phase: 'settled', outcome: 'unknown', error: { code: 'connection-failed', retryable: false } } : null }; options.changed() },
    dispatch(command: AppCommand): PublicErrorCode | undefined {
      if (!command.type.startsWith('agent.') && command.type !== 'team.task.update') return 'invalid-command'
      const input = command as AppCommand & CollaborationCommand
      if (pending) return 'unavailable'
      if (value.operation?.outcome === 'unknown' && input.type !== 'agent.refresh' && input.type !== 'agent.stop-family') return 'unavailable'
      if (input.type !== 'agent.refresh') {
        if (!options.allowed()) return 'permission-denied'
        const member = value.members.find((entry) => JSON.stringify(entry.address) === JSON.stringify(input.target.address) && (['agent.stop-family', 'team.task.update'].includes(input.type) ? entry.mode === 'root' : entry.revision === input.target.expectedRevision))
        if (!member) return 'stale-epoch'
        if (input.type === 'agent.message' && !member.controls.message || input.type === 'agent.interrupt' && !member.controls.interrupt) return 'permission-denied'
        if (input.type === 'team.task.update' && !value.tasks.some((task) => task.id === input.taskId && task.revision === input.expectedTaskRevision)) return 'stale-epoch'
      }
      const token = generation
      pending = true; value.operation = { requestId: input.requestId, phase: 'running', outcome: 'pending', error: null }; options.changed()
      void options.run(input).then((view) => {
        if (token !== generation) return
        value = { ...view, operation: view.operation ?? { requestId: input.requestId, phase: 'settled', outcome: 'accepted', error: null } }
      }, (error: unknown) => {
        if (token !== generation) return
        const unknown = /TIMEOUT|EXITED|CLOSED|OUTCOME_UNKNOWN/.test(error instanceof Error ? error.message : '')
        value.operation = { requestId: input.requestId, phase: 'settled', outcome: unknown ? 'unknown' : 'failed', error: { code: unknown ? 'connection-failed' : 'stale-epoch', retryable: false } }
      }).finally(() => { if (token === generation) { pending = false; options.changed() } })
      return undefined
    },
  }
}
export type CollaborationPort = Pick<ReturnType<typeof createCollaborationState>, 'view' | 'dispatch'> & Partial<Pick<ReturnType<typeof createCollaborationState>, 'readMemberSteps'>>
