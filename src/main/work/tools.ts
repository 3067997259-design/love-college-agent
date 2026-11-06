import { z } from 'zod'
import type { ContinuousWorkCommand } from '../../shared/continuity'
import type { HarnessTool } from '../harness/tools'
import { workDigest } from './journal'
import type { ContinuousWorkService } from './service'
import type { WorkIdentity } from '../../shared/continuity'
import { checkpointProposalSchema } from './journal'
import { createWorkInput as create, updateWorkInput as update } from './request-schema'
import { authoredWorkRequest, checkWorkRequest } from './request'
import { workResultContext } from './result'

export function workTools(service: ContinuousWorkService): HarnessTool[] {
  const query = z.strictObject({ workId: z.string().uuid().optional() })
  const value = (result: unknown) => { const data = JSON.parse(JSON.stringify(result)) as Record<string, never>; return { ok: true, raw: data, visible: data } }
  const clarify = (reason: string) => value({ error: 'work-clarification-required', reason, applied: false,
    instruction: 'No work was created or changed. Ask which work and what concrete change the user wants, including both in their answer. Do not infer missing details from historical work or retry as start_work. A rejection is not completion.' })
  return [{ templateId: 'work.create', definition: { name: 'start_work',
    description: 'Start one persistent work for the current explicit user request in their selected project. Main uses the current original request (and its committed clarification answers) as objective, not your paraphrase. acceptance may quote explicit user criteria, or be empty. decisionIds may only name these current originals, never historical work. Keep foreground chat available. Do not start another work for a supplement or a rejected update; ask for clarification when target or requirements are missing.',
    parameters: z.toJSONSchema(create) }, validate: input => create.safeParse(input).success,
    run: async (input, context) => {
      context.signal.throwIfAborted()
      if (!context.userMessageId || !context.callId) return value({ error: 'authored-user-message-required' })
      const parsed = create.parse(input)
      const request = authoredWorkRequest(context)
      if (!request) return clarify('current-request-required')
      const works = service.requestWorks(), ids = request.decisions.map(item => item.id)
      if (parsed.decisionIds?.some(id => !ids.includes(id))) return clarify('historical-decision-not-current-request')
      const bound = works.filter(work => work.decisions.some(item => ids.includes(item.id)))
      if (bound.length === 1 && bound[0].inputs[0]?.decisionIds.includes(request.latest.id)) {
        return value({ ...service.dispatch({ type: 'work.query', workId: bound[0].identity.workId }, workDigest([context.turnId, context.callId])), alreadyApplied: true })
      }
      if (bound.length) return clarify('request-already-bound-to-work')
      const rows = context.store.records(), latest = rows.findLastIndex(row => row.type === 'user/message' && row.id === request.latest.id)
      if (rows.slice(latest + 1).some(row => row.type === 'work/activity' && row.turnId === context.turnId && row.templateId === 'work.update')) return clarify('update-request-cannot-create-work')
      const issue = checkWorkRequest(request, works, { action: 'create' })
      if (issue) return clarify(issue)
      const command: ContinuousWorkCommand = { type: 'work.create', projectId: 'current', objective: request.text,
        acceptance: parsed.acceptance.filter(text => request.decisions.some(item => item.text.includes(text))), decisionIds: ids }
      return value(service.dispatch(command, workDigest([context.turnId, context.callId])))
    } }, { templateId: 'work.update', definition: { name: 'update_work',
    description: 'Route the current original request to a SPECIFIC work, or pause/stop/resume it. Get the latest revision first. targetQuote must quote the current user wording of a name explicitly declared as a task/work name in its original start request, or its exact label; a literal work ID is also accepted. An arbitrary substring of an old requirement is not a name. requirementQuote can quote the concrete requested change. Quotes cannot come from old decisions, model objectives or your question text. Ambiguous target or change requires ask_user_question, never guessing or start_work. Stopping cannot undo external actions; resume uses a new generation without old approvals.',
    parameters: z.toJSONSchema(update) }, validate: input => update.safeParse(input).success,
    run: async (input, context) => {
      context.signal.throwIfAborted()
      if (!context.userMessageId || !context.callId) return value({ error: 'authored-user-message-required' })
      const parsed = update.parse(input), work = service.get(parsed.workId)
      if (!work) return value({ error: 'work-unavailable' })
      if (!service.contextAllowed(parsed.workId)) return value({ error: 'work-source-withdrawn', instruction: 'This historical work has withdrawn source decisions. Ask for a new explicit request; do not restore its old objective.' })
      const request = authoredWorkRequest(context)
      if (!request) return clarify('current-request-required')
      const works = service.requestWorks(), ids = request.decisions.map(item => item.id)
      if (works.some(other => other.identity.workId !== parsed.workId && other.decisions.some(item => ids.includes(item.id)))) return clarify('request-already-bound-to-other-work')
      if (parsed.action === 'supplement' && work.decisions.some(item => item.id === request.latest.id)) {
        return value({ ...service.dispatch({ type: 'work.query', workId: parsed.workId }, workDigest([context.turnId, context.callId])), alreadyApplied: true })
      }
      const issue = checkWorkRequest(request, works, parsed)
      if (issue) return clarify(issue)
      const target = { identity: work.identity, expectedRevision: parsed.expectedRevision }
      const command: ContinuousWorkCommand = parsed.action === 'supplement'
        ? { type: 'work.supplement', target, text: request.text, decisionId: request.latest.id,
          ...(ids.length > 1 ? { clarifiedDecisionIds: ids.slice(0, -1) } : {}) }
        : { type: `work.${parsed.action}`, target }
      return value(service.dispatch(command, workDigest([context.turnId, context.callId])))
    } }, { templateId: 'work.query', definition: { name: 'inspect_work',
    description: 'Read current persistent work identity, objective revision, original user decisions and delivery receipts. Query by workId for details, or omit it for the current work list. A turn ending or an accepted event is not a verified completed task.',
    parameters: z.toJSONSchema(query) }, validate: input => query.safeParse(input).success,
    run: async (input, context) => { context.signal.throwIfAborted(); const { workId } = query.parse(input)
      const work = workId && service.contextAllowed(workId) ? service.get(workId) : null
      return value(workId ? work ? { identity: work.identity, revision: work.revision, status: work.status, objective: work.objective, acceptance: work.acceptance,
        userDecisions: work.decisions, result: workResultContext(work), checkpointId: work.checkpointId, checkpoint: checkpointContext(work), receipts: work.inputs.map(({ eventId, state, revision, consumedAt }) => ({ eventId, state, revision, consumedAt })) } : { error: 'work-unavailable' }
        : { ...service.view(), items: service.view().items.filter(item => service.contextAllowed(item.identity.workId)).map(item => ({ ...item, result: workResultContext(service.get(item.identity.workId)!) })) }) }
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
  const works = service.view().items.filter(item => service.contextAllowed(item.identity.workId))
  return { workCheckpoints: works.map(item => ({ identity: item.identity, revision: item.revision, label: item.label, status: item.status, waitingFor: item.waitingFor,
    progress: item.progress, result: workResultContext(service.get(item.identity.workId)!), checkpoint: item.checkpointId ? checkpointContext(service.get(item.identity.workId)!) : null })),
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
