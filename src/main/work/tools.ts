import { z } from 'zod'
import type { ContinuousWorkCommand } from '../../shared/continuity'
import type { HarnessTool } from '../harness/tools'
import { workDigest } from './journal'
import type { ContinuousWorkService } from './service'
import type { WorkIdentity } from '../../shared/continuity'
import { checkpointProposalSchema } from './journal'

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
        userDecisions: work.decisions, checkpointId: work.checkpointId, checkpoint: checkpointContext(work), receipts: work.inputs.map(({ eventId, state, revision, consumedAt }) => ({ eventId, state, revision, consumedAt })) } : { error: 'work-unavailable' } : service.view()) }
    }]
}

export function checkpointContext(work: NonNullable<ReturnType<ContinuousWorkService['get']>>) {
  const checkpoint = work.checkpoints?.find(item => item.id === work.checkpointId)
  if (!checkpoint) return null
  const evidence = checkpoint.evidenceIds.flatMap(id => work.evidence?.find(item => item.id === id) ?? [])
  const restricted = evidence.some(item => item.restricted)
  return { id: checkpoint.id, identity: checkpoint.identity, outcome: checkpoint.outcome, published: work.delivery?.checkpointId === checkpoint.id,
    decisionIds: checkpoint.decisionIds, createdAt: checkpoint.createdAt, restricted,
    explanation: restricted ? null : checkpoint.explanation, explanationSource: 'worker-expression-not-independent-evidence',
    unresolved: restricted ? null : checkpoint.unresolved, nextStep: restricted ? null : checkpoint.nextStep,
    observations: evidence.map(item => ({ id: item.id, kind: item.kind, status: item.status, exitCode: item.exitCode,
      relativePath: item.restricted ? null : item.relativePath, hash: item.afterHash, observedAt: item.observedAt })),
    authority: 'historical-work-evidence-not-current-permission-or-new-experience' }
}

/** Whole references are budgeted by the shared context composer. Latest exact
 * user decisions precede older ones; no worker-authored objective gains authority. */
export function workContext(service: ContinuousWorkService) {
  const works = service.view().items
  return { workCheckpoints: works.map(item => ({ identity: item.identity, revision: item.revision, label: item.label, status: item.status, waitingFor: item.waitingFor,
    progress: item.progress, checkpoint: item.checkpointId ? checkpointContext(service.get(item.identity.workId)!) : null })),
  currentDecisions: works.flatMap(item => service.get(item.identity.workId)!.decisions.toReversed().map(decision => ({ workId: item.identity.workId,
    objectiveRevision: item.identity.objectiveRevision, status: item.status, eventId: decision.id, atMs: decision.atMs, text: decision.text, authority: 'original-decision-for-this-work-only-not-new-speech' }))) }
}

export function workCompletionTools(service: ContinuousWorkService, identity: WorkIdentity): HarnessTool[] {
  const empty = z.strictObject({})
  const result = (value: unknown) => { const data = JSON.parse(JSON.stringify(value)) as Record<string, never>; return { ok: true, raw: data, visible: data } }
  return [{ templateId: 'work.evidence', definition: { name: 'inspect_current_work', description: 'Read this work\'s current objective revision, exact original decisions, and executor-observed evidence IDs. Tool acceptance, a background job starting, or your own statement is not completion evidence.', parameters: z.toJSONSchema(empty) }, validate: input => empty.safeParse(input).success,
    run: async (_input, context) => { context.signal.throwIfAborted(); const work = service.get(identity.workId)
      return result(work?.identity.generation === identity.generation ? { identity: work.identity, decisions: work.decisions, acceptance: work.acceptance,
        evidence: work.evidence?.filter(item => item.identity.generation === identity.generation) ?? [] } : { error: 'work-generation-retired' }) } },
  { templateId: 'work.finish', definition: { name: 'finish_work', description: 'Prepare a durable delivery checkpoint using evidence IDs from inspect_current_work. Only current-version successful file changes or completed commands qualify. Main verifies file hashes again after this turn ends, then publishes the delivery. State unresolved work honestly; do not claim completed with unresolved items. After preparing it, end this turn.', parameters: z.toJSONSchema(checkpointProposalSchema) }, validate: input => checkpointProposalSchema.safeParse(input).success,
    run: async (input, context) => { context.signal.throwIfAborted(); if (!context.callId) return result({ error: 'call-id-required' })
      try { const checkpoint = service.checkpoint(identity, checkpointProposalSchema.parse(input), workDigest([context.turnId, context.callId]))
        return result({ checkpointId: checkpoint?.id, state: 'pending-turn-end-verification' }) }
      catch { return result({ error: 'checkpoint-unverified-or-stale', instruction: 'Inspect current work and actual outputs before trying a new checkpoint.' }) }
    } }]
}
