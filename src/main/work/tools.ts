import { z } from 'zod'
import type { ContinuousWorkCommand } from '../../shared/continuity'
import type { HarnessTool } from '../harness/tools'
import { workDigest } from './journal'
import type { ContinuousWorkService } from './service'

export function workTools(service: ContinuousWorkService): HarnessTool[] {
  const create = z.strictObject({ objective: z.string().min(1).max(20_000), acceptance: z.array(z.string().min(1).max(2000)).max(16), decisionIds: z.array(z.string().min(1).max(128)).max(32).optional() })
  const update = z.strictObject({ workId: z.string().uuid(), expectedRevision: z.number().int().positive(), action: z.enum(['supplement', 'pause', 'stop', 'resume']) })
  const query = z.strictObject({ workId: z.string().uuid().optional() })
  const value = (result: unknown) => { const data = JSON.parse(JSON.stringify(result)) as Record<string, never>; return { ok: true, raw: data, visible: data } }
  return [{ templateId: 'work.create', definition: { name: 'start_work',
    description: 'Start a persistent work for an explicit request by the user, in their selected project. Keep this foreground conversation available. Preserve exact decision IDs; objective is your task description, not user speech or completion evidence. Returns a work ID, revision and queued/running status. Do not start another work for a supplement to an existing one.',
    parameters: z.toJSONSchema(create) }, validate: input => create.safeParse(input).success,
    run: async (input, context) => {
      context.signal.throwIfAborted()
      if (!context.userMessageId || !context.callId) return value({ error: 'authored-user-message-required' })
      const parsed = create.parse(input)
      const command: ContinuousWorkCommand = { type: 'work.create', projectId: 'current', objective: parsed.objective, acceptance: parsed.acceptance,
        decisionIds: [...new Set([context.userMessageId, ...parsed.decisionIds ?? []])] }
      return value(service.dispatch(command, workDigest([context.turnId, context.callId])))
    } }, { templateId: 'work.update', definition: { name: 'update_work',
    description: 'Route the user\'s latest original decision to a SPECIFIC work, or pause/stop/resume it. Get its latest revision first. Never route ambiguous chat by guessing the most recent work. Stopping cannot undo external actions already issued; resume reconciles in a new generation without replaying approvals.',
    parameters: z.toJSONSchema(update) }, validate: input => update.safeParse(input).success,
    run: async (input, context) => {
      context.signal.throwIfAborted()
      if (!context.userMessageId || !context.callId) return value({ error: 'authored-user-message-required' })
      const parsed = update.parse(input), work = service.get(parsed.workId)
      if (!work) return value({ error: 'work-unavailable' })
      const target = { identity: work.identity, expectedRevision: parsed.expectedRevision }
      const source = context.store.records().find(row => row.type === 'user/message' && row.id === context.userMessageId)
      const command: ContinuousWorkCommand = parsed.action === 'supplement'
        ? { type: 'work.supplement', target, text: source?.type === 'user/message' ? source.text : '', decisionId: context.userMessageId }
        : { type: `work.${parsed.action}`, target }
      return value(service.dispatch(command, workDigest([context.turnId, context.callId])))
    } }, { templateId: 'work.query', definition: { name: 'inspect_work',
    description: 'Read current persistent work identity, objective revision, original user decisions and delivery receipts. Query by workId for details, or omit it for the current work list. A turn ending or an accepted event is not a verified completed task.',
    parameters: z.toJSONSchema(query) }, validate: input => query.safeParse(input).success,
    run: async (input, context) => { context.signal.throwIfAborted(); const { workId } = query.parse(input)
      const work = workId ? service.get(workId) : null
      return value(workId ? work ? { identity: work.identity, revision: work.revision, status: work.status, objective: work.objective, acceptance: work.acceptance,
        userDecisions: work.decisions, checkpointId: work.checkpointId, receipts: work.inputs.map(({ eventId, state, revision, consumedAt }) => ({ eventId, state, revision, consumedAt })) } : { error: 'work-unavailable' } : service.view()) }
    }]
}
