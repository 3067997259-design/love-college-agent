import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type { ContinuityOwner, ContinuousWorkCommand, ContinuousWorksView, ContinuousWorkView, WorkTarget, WorkIdentity, WorkEvidence, WorkCheckpoint } from '../../shared/continuity'
import type { PublicErrorCode } from '../../shared'
import type { Clock } from '../clock'
import { openWorkJournal, sameOwner, workDigest, workEvidenceSchema, checkpointProposalSchema, type CheckpointProposal, type WorkDecision, type WorkInput, type WorkRecord } from './journal'
import { verifyWorkFile } from '../../../dsh/lca-bridge/work-evidence.js'

export interface WorkRuntime {
  deliver(input: { eventId: string; text: string; revision: number }): Promise<void>
  invalidateWork(revision: number): void
  close(): Promise<void>
  busy(): boolean
  stateChanged(): void
  untrust(project: string): void
  efforts(efforts: { chat?: string; work?: string }): void
}
export interface WorkRuntimeContext {
  work: WorkRecord
  consumed(eventId: string): void
  settled(failed: boolean): void
  waiting(reason: 'approval' | 'user' | null): void
  evidence(evidence: WorkEvidence): void
  successfulInputs(eventIds: readonly string[]): void
}
const resumable = new Set<WorkRecord['status']>(['paused', 'stopped', 'review_required', 'failed', 'waiting'])
const modifiable = new Set<WorkRecord['status']>(['queued', 'running', 'waiting', 'paused', 'review_required', 'completed'])
const recoverable = new Set<WorkRecord['status']>(['queued', 'running', 'waiting', 'stopping'])

/** Durable task identity and subscriptions. This is a scheduler/delivery port,
 * not a model loop: DSH still owns all steps, retries, tools and compaction. */
export function createContinuousWork(options: {
  root: string; owner: ContinuityOwner; clock: Clock
  project(id: string, knownPath?: string): { id: string; path: string } | null
  decision(id: string): WorkDecision | null
  safeText(text: string): string
  available(): boolean
  held(): boolean
  createRuntime(context: WorkRuntimeContext): WorkRuntime
  observed?(work: WorkRecord, input: WorkInput, decisions: readonly WorkDecision[]): void
  deliverCheckpoint?(work: WorkRecord, checkpoint: WorkCheckpoint): 'accepted' | 'consumed' | 'unavailable'
  changed(): void
}) {
  const { clock, owner } = options
  const journal = openWorkJournal(join(options.root, 'events.log'), owner, clock)
  const works = new Map<string, WorkRecord>(), operations = new Map<string, { digest: string; workId: string | null }>()
  for (const row of journal.rows()) {
    operations.set(row.operationId, { digest: row.digest, workId: row.work?.identity.workId ?? row.receiptWorkId ?? null })
    if (row.work) works.set(row.work.identity.workId, row.work)
  }
  type Live = { generation: number; runtime: WorkRuntime; sending: boolean; closing: boolean; releasing?: Promise<void> }
  const live = new Map<string, Live>()
  let scheduled = false, closed = false, failure: 'storage' | null = null
  const persist = (work: WorkRecord, kind: string, operationId: string = randomUUID(), input: unknown = { workId: work.identity.workId, revision: work.revision }) => {
    const next = structuredClone(work); next.updatedAt = clock.nowMs()
    const digest = workDigest(input)
    try { journal.append({ kind, operationId, digest, work: next }) } catch (error) { failure = 'storage'; for (const item of live.values()) void item.runtime.close().catch(() => {}); throw error }
    works.set(next.identity.workId, next); operations.set(operationId, { digest, workId: next.identity.workId }); options.changed()
    return next
  }
  // Restart never replays a delivery or approval whose final outcome was not observed.
  for (const work of [...works.values()]) if (recoverable.has(work.status)) {
    work.status = 'review_required'; work.waitingFor = 'recovery'; work.revision++
    for (const input of work.inputs) if (input.state === 'accepted' || input.state === 'pending') input.state = 'unknown'
    persist(work, 'recovered')
  }
  const progressOf = (work: WorkRecord) => {
    const observations = (work.evidence ?? []).filter(item => item.identity.generation === work.identity.generation && item.identity.objectiveRevision === work.identity.objectiveRevision)
    return { observedActions: observations.length, changedFiles: new Set(observations.filter(item => item.kind === 'artifact' && item.status === 'passed').map(item => item.relativePath)).size,
      completedCommands: observations.filter(item => item.kind === 'command' && item.status === 'passed').length,
      failedActions: observations.filter(item => item.status === 'failed').length, lastObservedAt: observations.at(-1)?.observedAt ?? null }
  }
  const viewOf = (work: WorkRecord): ContinuousWorkView => ({ identity: structuredClone(work.identity), revision: work.revision, label: work.label, progress: progressOf(work),
    status: work.status, waitingFor: work.waitingFor, checkpointId: work.checkpointId, updatedAt: work.updatedAt,
    ...(work.delivery ? { delivery: { eventId: work.delivery.eventId, state: work.delivery.state } } : {}),
    controls: { supplement: modifiable.has(work.status), pause: ['running', 'queued', 'waiting'].includes(work.status),
      stop: ['running', 'queued', 'waiting', 'paused', 'review_required'].includes(work.status), resume: resumable.has(work.status) && !live.has(work.identity.workId) } })
  const view = (): ContinuousWorksView => ({ items: [...works.values()].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 100).map(viewOf), active: live.size, limit: 2, failure })
  const current = (id: string, generation: number) => { const work = works.get(id); return work?.identity.generation === generation ? structuredClone(work) : null }
  const targetOf = (target: WorkTarget) => {
    const work = works.get(target.identity.workId)
    return work && sameOwner(target.identity.owner, owner) && work.revision === target.expectedRevision
      && JSON.stringify(work.identity) === JSON.stringify(target.identity) ? structuredClone(work) : null
  }
  const taskInput = (work: WorkRecord, input: WorkInput) => JSON.stringify({
    kind: input.kind === 'supplement' ? 'work-decision-update' : 'work-package', identity: work.identity,
    objective: work.objective, objectiveOrigin: 'delegated-task-description', acceptance: work.acceptance,
    userDecisions: work.decisions.filter(decision => input.kind !== 'supplement' || input.decisionIds.includes(decision.id)),
    checkpointId: work.checkpointId, eventId: input.eventId,
    instruction: input.kind === 'resume' ? 'Resume only after reconciling existing files and effects. Prior approvals do not authorize a new action. Do not repeat actions with unknown results.'
      : 'Use the latest objective and exact user decisions. This is a referenced task package, not newly authored user speech. Tool receipts and actual outputs must support delivery.',
  })
  const observed = (id: string, generation: number, eventIds: readonly string[]) => {
    for (const eventId of eventIds) {
      const work = current(id, generation), entry = live.get(id)
      if (!work || entry?.closing || failure || work.observedInputs?.includes(eventId)) continue
      const input = work.inputs.find(input => input.eventId === eventId && input.generation === generation && input.state === 'consumed')
      if (!input) continue
      const decisions = work.decisions.filter(decision => input.decisionIds.includes(decision.id))
      options.observed?.(work, input, decisions)
      work.observedInputs = [...work.observedInputs ?? [], eventId]; work.revision++; persist(work, 'successful-input')
    }
  }
  const recordEvidence = (id: string, generation: number, value: WorkEvidence) => {
    const work = current(id, generation), entry = live.get(id), parsed = workEvidenceSchema.safeParse(value)
    if (!work || !entry || entry.closing || failure || !parsed.success || !sameOwner(value.identity.owner, owner)
      || value.identity.workId !== id || value.identity.generation !== generation || value.identity.projectId !== work.identity.projectId
      || value.identity.objectiveRevision > work.identity.objectiveRevision || work.evidence?.some(item => item.id === value.id)) return
    work.evidence = [...work.evidence ?? [], parsed.data]; work.revision++; persist(work, 'evidence')
  }
  const validProofs = (work: WorkRecord, checkpoint: WorkCheckpoint) => checkpoint.evidenceIds.every(id => {
    const evidence = work.evidence?.find(item => item.id === id)
    if (!evidence || evidence.identity.generation !== work.identity.generation || evidence.identity.objectiveRevision !== work.identity.objectiveRevision || evidence.status !== 'passed') return false
    return evidence.kind === 'artifact' ? verifyWorkFile(work.projectPath, evidence) : evidence.kind === 'command' && evidence.exitCode === 0
  })
  const deliveries = (work: WorkRecord) => work.deliveries ?? (work.delivery ? [work.delivery] : [])
  const markDelivery = (work: WorkRecord, eventId: string, state: 'accepted' | 'consumed') => {
    work.deliveries = deliveries(work).map(item => item.eventId === eventId ? { ...item, state } : item)
    if (work.delivery?.eventId === eventId) work.delivery.state = state
    work.revision++; persist(work, 'checkpoint-delivery')
  }
  const deliver = (id: string) => {
    const initial = works.get(id)
    if (!initial || failure || closed || options.held()) return
    for (const receipt of deliveries(initial)) {
      const work = works.get(id)!
      if (receipt.state === 'consumed') continue
      const checkpoint = work.checkpoints?.find(item => item.id === receipt.checkpointId)
      if (!checkpoint) continue
      try {
        const state = options.deliverCheckpoint?.({ ...structuredClone(work), delivery: structuredClone(receipt) }, checkpoint)
        if (state && state !== 'unavailable' && state !== receipt.state) markDelivery(structuredClone(works.get(id)!), receipt.eventId, state)
      } catch { /* Keep the durable pending event; reconciliation uses its stable ID. */ }
    }
  }
  const consumed = (id: string, generation: number, eventId: string) => {
    const work = current(id, generation), runtime = live.get(id)
    if (!work || !runtime || runtime.closing || !['running', 'waiting'].includes(work.status)) return
    const input = work.inputs.find(item => item.eventId === eventId && item.generation === generation)
    if (!input || !['pending', 'accepted'].includes(input.state)) return
    input.state = 'consumed'; input.consumedAt = clock.nowMs()
    // Only a contiguous terminal prefix advances the subscription watermark.
    for (const item of work.inputs.filter(item => item.generation === generation)) {
      if (item.sequence <= work.consumedThrough) continue
      if (item.state !== 'consumed' && item.state !== 'cancelled') break
      work.consumedThrough = item.sequence
    }
    work.revision++; persist(work, 'consumed')
  }
  const flush = async (id: string, entry: Live) => {
    if (entry.sending || entry.closing || closed || failure) return
    entry.sending = true
    try {
      for (;;) {
        const work = current(id, entry.generation)
        if (!work || entry.closing || closed || !['running', 'waiting'].includes(work.status)) return
        const input = work.inputs.find(item => item.generation === entry.generation && item.state === 'pending')
        if (!input) return
        await entry.runtime.deliver({ eventId: input.eventId, text: taskInput(work, input), revision: input.revision })
        const latest = current(id, entry.generation)
        if (!latest || entry.closing || closed) return
        const receipt = latest.inputs.find(item => item.eventId === input.eventId)!
        // Consumption can arrive before the IPC accepted continuation.
        if (receipt.state === 'pending') { receipt.state = 'accepted'; latest.revision++; persist(latest, 'accepted') }
      }
    } catch {
      const work = current(id, entry.generation)
      if (work && !entry.closing && !closed && !failure) {
        work.status = 'review_required'; work.waitingFor = 'recovery'; work.revision++
        for (const input of work.inputs) if (input.generation === entry.generation && ['pending', 'accepted'].includes(input.state)) input.state = 'unknown'
        persist(work, 'delivery-unknown'); void release(id, entry)
      }
    } finally { entry.sending = false }
  }
  const release = (id: string, entry: Live): Promise<void> => entry.releasing ??= (async () => {
    entry.closing = true
    try { await entry.runtime.close(); if (live.get(id) === entry) live.delete(id) }
    catch {
      // Retain the project lock: disposal was not acknowledged.
      const work = current(id, entry.generation)
      if (work && !failure) { work.status = 'review_required'; work.waitingFor = 'recovery'; work.revision++; persist(work, 'stop-unknown') }
    } finally { options.changed(); schedule() }
  })()
  const settled = (id: string, generation: number, failed: boolean) => {
    const work = current(id, generation), entry = live.get(id)
    if (!work || !entry || entry.closing || closed || failure) return
    if (failed && work.inputs.some(input => input.generation === generation && ['pending', 'accepted'].includes(input.state))) {
      work.status = 'review_required'; work.waitingFor = 'recovery'; work.revision++
      for (const input of work.inputs) if (input.generation === generation && ['pending', 'accepted'].includes(input.state)) input.state = 'unknown'
      persist(work, 'failed-with-pending-delivery'); void release(id, entry); return
    }
    // A turn ending is not proof of task completion. The checkpoint path owns that claim.
    if (work.inputs.some(input => input.generation === generation && ['pending', 'accepted'].includes(input.state))) { void flush(id, entry); return }
    const checkpoint = work.checkpoints?.find(item => item.id === work.checkpointId)
    if (!failed && checkpoint && checkpoint.identity.objectiveRevision === work.identity.objectiveRevision && validProofs(work, checkpoint)) {
      work.status = checkpoint.outcome === 'completed' ? 'completed' : 'waiting'; work.waitingFor = checkpoint.outcome === 'completed' ? null : 'user'; work.revision++
      const previousDeliveries = deliveries(work)
      work.delivery = { eventId: `checkpoint:${checkpoint.id}`, checkpointId: checkpoint.id, state: 'pending' }
      work.deliveries = [...previousDeliveries.filter(item => item.eventId !== work.delivery!.eventId), work.delivery]
      persist(work, 'checkpoint-published'); void release(id, entry).then(() => deliver(id)); return
    }
    work.status = failed ? 'failed' : 'waiting'; work.waitingFor = failed ? null : 'user'; work.revision++
    persist(work, failed ? 'run-failed' : 'turn-settled'); void release(id, entry)
  }
  const pump = () => {
    scheduled = false
    if (closed || failure || options.held() || !options.available()) return
    for (const work of structuredClone([...works.values()])) {
      if (work.status !== 'queued' || live.size >= 2) continue
      if ([...live.keys()].some(id => works.get(id)?.identity.projectId === work.identity.projectId)) continue
      const project = options.project(work.identity.projectId, work.projectPath)
      if (!project || project.id !== work.identity.projectId) { work.status = 'review_required'; work.waitingFor = 'recovery'; work.revision++; persist(work, 'project-unavailable'); continue }
      const id = work.identity.workId, generation = work.identity.generation
      work.status = 'running'; work.waitingFor = null; work.revision++
      persist(work, 'run-start')
      try {
        const runtime = options.createRuntime({ work: structuredClone(work), consumed: eventId => consumed(id, generation, eventId), settled: failed => settled(id, generation, failed),
          evidence: value => recordEvidence(id, generation, value), successfulInputs: ids => observed(id, generation, ids),
          waiting: reason => { const next = current(id, generation); if (!next || live.get(id)?.closing || failure) return; next.status = reason ? 'waiting' : 'running'; next.waitingFor = reason; next.revision++; persist(next, 'waiting') } })
        const entry = { generation, runtime, sending: false, closing: false }; live.set(id, entry); void flush(id, entry)
      } catch { const next = current(id, generation)!; next.status = 'failed'; next.waitingFor = null; next.revision++; persist(next, 'launch-failed') }
    }
    options.changed()
  }
  const schedule = () => { if (!scheduled && !closed) { scheduled = true; queueMicrotask(pump) } }
  const newInput = (work: WorkRecord, eventId: string, kind: WorkInput['kind'], decisionIds: string[]): WorkInput => ({ eventId, subscriptionId: work.subscriptionId,
    sequence: (work.inputs.at(-1)?.sequence ?? 0) + 1, generation: work.identity.generation, revision: work.identity.objectiveRevision, kind, state: 'pending', consumedAt: null, decisionIds })
  const stop = (work: WorkRecord, outcome: 'paused' | 'stopped', operationId: string, input: unknown) => {
    const id = work.identity.workId, entry = live.get(id)
    work.status = entry ? 'stopping' : outcome; work.waitingFor = null; work.revision++
    for (const event of work.inputs) if (event.state === 'pending') event.state = 'cancelled'; else if (event.state === 'accepted') event.state = 'unknown'
    persist(work, outcome === 'paused' ? 'pause-requested' : 'stop-requested', operationId, input)
    if (entry) void release(id, entry).then(() => {
      const next = current(id, entry.generation)
      if (next && next.status === 'stopping' && !live.has(id) && !failure) { next.status = outcome; next.revision++; persist(next, outcome) }
    })
  }
  const dispatch = (command: ContinuousWorkCommand, operationId: string): { error?: PublicErrorCode; work?: ContinuousWorkView } => {
    if (closed || failure) return { error: 'unavailable' }
    const previous = operations.get(operationId)
    if (previous) return previous.digest === workDigest(command) ? { work: previous.workId && works.has(previous.workId) ? viewOf(works.get(previous.workId)!) : undefined } : { error: 'invalid-command' }
    if (command.type === 'work.query') { const work = works.get(command.workId); return work ? { work: viewOf(work) } : { error: 'invalid-command' } }
    try {
      if (command.type === 'work.create') {
        if (!options.available() || options.held()) return { error: 'unavailable' }
        const project = options.project(command.projectId)
        const decisions = [...new Set(command.decisionIds)].map(options.decision)
        if (!project || !decisions.length || decisions.some(value => !value)) return { error: 'invalid-command' }
        const at = clock.nowMs(), workId = randomUUID()
        const work: WorkRecord = { identity: { owner, projectId: project.id, workId, generation: 1, objectiveRevision: 1 }, revision: 1,
          label: options.safeText(decisions[0]!.text).replace(/\s+/g, ' ').slice(0, 120), objective: command.objective, acceptance: [...command.acceptance],
          decisions: decisions as WorkDecision[], projectPath: project.path, status: 'queued', waitingFor: 'project', checkpointId: null,
          createdAt: at, updatedAt: at, runStartedAt: at, subscriptionId: randomUUID(), consumedThrough: 0, inputs: [] }
        work.inputs.push(newInput(work, operationId, 'start', work.decisions.map(decision => decision.id)))
        persist(work, 'created', operationId, command); schedule(); return { work: viewOf(work) }
      }
      const work = targetOf(command.target)
      if (!work) return { error: 'invalid-command' }
      const id = work.identity.workId
      if (command.type === 'work.supplement') {
        const ids = [...new Set([...(command.clarifiedDecisionIds ?? []), command.decisionId])]
        const decisions = ids.map(options.decision)
        if (!modifiable.has(work.status) || decisions.some(item => !item) || work.decisions.some(item => item.id === command.decisionId) || work.inputs.length >= 256) return { error: 'invalid-command' }
        const added = (decisions as WorkDecision[]).filter(item => !work.decisions.some(previous => previous.id === item.id))
        if (work.decisions.length + added.length > 64) return { error: 'invalid-command' }
        // Exact original speech is preserved separately from the routed explanation.
        const completed = work.status === 'completed'
        if (completed) { work.identity.generation++; work.runStartedAt = clock.nowMs(); work.subscriptionId = randomUUID(); work.consumedThrough = work.inputs.at(-1)?.sequence ?? 0; work.checkpointId = null }
        work.decisions.push(...added); work.identity.objectiveRevision++; work.revision++
        work.inputs.push(newInput(work, operationId, completed ? 'resume' : 'supplement', completed ? work.decisions.map(item => item.id) : ids))
        if (completed || work.status === 'waiting' && !live.has(id)) { work.status = 'queued'; work.waitingFor = 'project' }
        persist(work, 'supplemented', operationId, command)
        const entry = live.get(id)
        if (entry?.generation === work.identity.generation) { entry.runtime.invalidateWork(work.identity.objectiveRevision); void flush(id, entry) } else schedule()
      } else if (command.type === 'work.stop' || command.type === 'work.pause') {
        if (!viewOf(work).controls[command.type === 'work.stop' ? 'stop' : 'pause']) return { error: 'invalid-command' }
        stop(work, command.type === 'work.stop' ? 'stopped' : 'paused', operationId, command)
      } else if (command.type === 'work.resume') {
        if (!resumable.has(work.status) || live.has(id) || options.held() || !options.available()) return { error: 'unavailable' }
        work.identity.generation++; work.revision++; work.runStartedAt = clock.nowMs(); work.subscriptionId = randomUUID(); work.status = 'queued'; work.waitingFor = 'project'
        for (const input of work.inputs) if (['pending', 'accepted'].includes(input.state)) input.state = 'unknown'
        work.consumedThrough = work.inputs.at(-1)?.sequence ?? 0
        work.inputs.push(newInput(work, operationId, 'resume', work.decisions.map(decision => decision.id)))
        persist(work, 'resumed', operationId, command); schedule()
      }
      return { work: viewOf(works.get(id)!) }
    } catch { return { error: failure ? 'unavailable' : 'invalid-command' } }
  }
  return { view, dispatch,
    checkpoint: (identity: WorkIdentity, proposal: CheckpointProposal, operationId: string) => {
      const parsed = checkpointProposalSchema.parse(proposal), work = current(identity.workId, identity.generation), entry = live.get(identity.workId)
      const previous = operations.get(operationId)
      if (previous) { if (previous.digest !== workDigest(proposal)) throw new Error('WORK_OPERATION_CONFLICT'); return work?.checkpoints?.find(item => item.id === operationId) }
      if (!work || !entry || entry.closing || failure || closed || !sameOwner(identity.owner, owner) || identity.projectId !== work.identity.projectId
        || parsed.expectedObjectiveRevision !== work.identity.objectiveRevision || !['running', 'waiting'].includes(work.status)
        || parsed.outcome === 'completed' && parsed.unresolved.length) throw new Error('WORK_CHECKPOINT_STALE')
      const checkpoint: NonNullable<WorkRecord['checkpoints']>[number] = { id: operationId, identity: structuredClone(work.identity), objective: work.objective, decisionIds: work.decisions.map(item => item.id),
        evidenceIds: [...new Set(parsed.evidenceIds)], outcome: parsed.outcome, explanation: parsed.explanation, unresolved: parsed.unresolved, nextStep: parsed.nextStep, createdAt: clock.nowMs() }
      if (!validProofs(work, checkpoint)) throw new Error('WORK_CHECKPOINT_UNVERIFIED')
      work.checkpointId = checkpoint.id; work.checkpoints = [...work.checkpoints ?? [], checkpoint]; work.revision++
      persist(work, 'checkpoint-prepared', operationId, proposal)
      return structuredClone(checkpoint)
    },
    consumedDelivery: (eventId: string) => {
      const work = [...works.values()].find(item => deliveries(item).some(item => item.eventId === eventId && item.state !== 'consumed'))
      if (work) markDelivery(structuredClone(work), eventId, 'consumed')
    },
    get: (id: string) => { const work = works.get(id); return work ? structuredClone(work) : null },
    // Routing checks must cover archived/older work too, beyond the 100-row UI.
    requestWorks: () => structuredClone([...works.values()]),
    busy: () => live.size > 0,
    stateChanged: () => { if (options.held()) for (const work of [...works.values()]) if (live.has(work.identity.workId) && work.status !== 'stopping') stop(structuredClone(work), 'paused', randomUUID(), { cause: 'held' }); for (const id of works.keys()) deliver(id); schedule() },
    untrust: (project: string) => { for (const entry of live.values()) entry.runtime.untrust(project) },
    efforts: (value: { chat?: string; work?: string }) => { for (const entry of live.values()) entry.runtime.efforts(value) },
    disconnect: async () => {
      for (const work of structuredClone([...works.values()])) if (recoverable.has(work.status)) {
        work.status = 'review_required'; work.waitingFor = 'recovery'; work.revision++
        for (const input of work.inputs) if (['pending', 'accepted'].includes(input.state)) input.state = 'unknown'
        persist(work, 'disconnected')
      }
      await Promise.all([...live].map(([id, entry]) => release(id, entry)))
    },
    close: async () => { closed = true; await Promise.all([...live.values()].map(entry => entry.runtime.close())); live.clear() },
  }
}
export type ContinuousWorkService = ReturnType<typeof createContinuousWork>
