import { randomUUID } from 'node:crypto'
import type { AppCommand, LifeWorkItem, LifeWorkKind, LifeWorkView, PublicErrorCode } from '../../../shared'
import type { Clock } from '../../clock'
import type { Scheduler } from '../../scheduler'
import type { SessionStore } from '../../store/session'
import type { createDesk } from '../../heart-flow/desk'
import { calendarDay } from '../service'
import { workOutput, type LifeWorkModel, type WorkDraft } from './schema'
import { workHash, workPath, workRecords } from './records'
import { lifeWorkFixtures } from './fake'

const DAILY_ATTEMPTS = 8
export function createLifeWork(options: {
  store: SessionStore; clock: Clock; scheduler: Scheduler; desk: ReturnType<typeof createDesk>; model: LifeWorkModel | null; developer: boolean
  available(): boolean; changed(): void; projected(): void; open(path: string, text: string, source: LifeWorkItem['source']): void
}) {
  const { store, clock, desk } = options; const rows = () => store.history?.() ?? store.records()
  let enabled = true; let closed = false; let active: AbortController | undefined; let worker: Promise<void> | undefined
  const jobs = workRecords(rows()).jobs
  for (const [id, checkpoints] of workRecords(rows()).committed) {
    const job = jobs.get(id)!; const last = checkpoints.at(-1)!
    job.completedSteps = checkpoints.length; job.output = { path: last.path, sha256: last.sha256, byteLength: Buffer.byteLength(last.text) }
  }
  const attempts = () => rows().filter((row) => row.type === 'life/work-attempt' && row.dayKey === calendarDay(clock)).length
  const save = (job: LifeWorkItem) => { job.updatedAtMs = clock.nowMs(); store.append({ type: 'life/work-state', job: { ...job, totalSteps: 3 } }); options.changed() }
  const blocked = () => !enabled || closed || !options.model || store.projection().lightsOut || !options.available()
  const reason = () => store.projection().lightsOut ? 'lights' as const : 'busy' as const
  const pause = (job: LifeWorkItem, why: LifeWorkItem['reason']) => { job.status = 'paused'; job.reason = why; save(job) }
  const fail = (job: LifeWorkItem, why: LifeWorkItem['reason']) => { job.status = 'failed'; job.reason = why; job.completedAtMs = null; save(job) }
  const checkpoint = (job: LifeWorkItem, draft: WorkDraft) => {
    if (draft.step !== job.completedSteps + 1 || desk.read(draft.path) !== draft.text) throw new Error('WORK_CONFLICT')
    store.append({ type: 'life/work-commit', workId: job.id, draftId: draft.id })
    job.completedSteps = draft.step; job.output = { path: draft.path, sha256: draft.sha256, byteLength: Buffer.byteLength(draft.text) }
    job.status = draft.step === job.totalSteps ? 'completed' : 'queued'; delete job.reason
    job.completedAtMs = job.status === 'completed' ? clock.nowMs() : null; save(job); options.projected()
  }
  // A committed checkpoint is a private-journal projection. Recreate missing files, preserve edits.
  // One unreadable or oversized file must never take the whole service — and the app — down with it:
  // a user editing her own work outside the app can exceed the desk read limit (issue #17).
  const rebuild = () => {
    const conflicted = new Set<string>()
    const replay = workRecords(rows())
    for (const material of replay.materials.values()) {
      const conflict = () => { for (const job of jobs.values()) if (job.materialId === material.id) { if (job.reason !== 'conflict') fail(job, 'conflict'); conflicted.add(job.id) } }
      try { const present = desk.read(material.path); if (present === null) desk.write(material.path, material.text); else if (present !== material.text) conflict() } catch { conflict() }
    }
    for (const [id, checkpoints] of replay.committed) for (const draft of checkpoints) {
      try {
        const present = desk.read(draft.path)
        if (present === null) desk.write(draft.path, draft.text)
        else if (present !== draft.text) { const job = jobs.get(id); if (job && job.reason !== 'conflict') fail(job, 'conflict'); conflicted.add(id) }
      } catch { const job = jobs.get(id); if (job && job.reason !== 'conflict') fail(job, 'conflict'); conflicted.add(id) }
    }
    return conflicted
  }
  // A conflict found here is the state the user has to resolve, so the startup reconcile below must not
  // overwrite it with "all steps committed" — that would both hide the conflict and re-open the resume path.
  const conflictedAtStartup = rebuild()
  // No model calls at startup. Only reconcile a write that already exists on disk with its durable intent.
  const replay = workRecords(rows())
  for (const job of jobs.values()) {
    const commits = replay.committed.get(job.id) ?? []
    job.completedSteps = commits.length
    const last = commits.at(-1)
    if (last) job.output = { path: last.path, sha256: last.sha256, byteLength: Buffer.byteLength(last.text) }
    const pending = [...replay.drafts.values()].findLast((draft) => draft.workId === job.id && draft.step === commits.length + 1)
    if (job.reason !== 'conflict' && pending) {
      try {
        const present = desk.read(pending.path)
        if (present === pending.text) checkpoint(job, pending)
        else if (present !== null) { fail(job, 'conflict'); conflictedAtStartup.add(job.id) }
      } catch { fail(job, 'conflict'); conflictedAtStartup.add(job.id) }
    }
    // A conflict found by this startup pass stays a conflict, even when every step was committed: the user
    // has to resolve it, and settling it silently would also re-open the resume path (issue #16).
    if (conflictedAtStartup.has(job.id)) continue
    if (job.reason === 'conflict') continue
    // A conflict recorded earlier that already committed every step is finished work, not a permanent
    // failure: settle it here so the resume path can never queue a fourth step (issue #16).
    if (job.completedSteps >= job.totalSteps) { if (job.status !== 'completed') { job.status = 'completed'; job.completedAtMs = clock.nowMs(); delete job.reason; save(job) }; continue }
    if (job.status === 'running' || job.status === 'queued' || job.status === 'paused' && job.reason !== 'user') { job.status = 'interrupted'; job.reason = 'interrupted'; save(job) }
  }
  const ensure = (kind: LifeWorkKind, day = calendarDay(clock)): LifeWorkItem | undefined => {
    const prior = [...jobs.values()].find((job) => job.dayKey === day && job.kind === kind); if (prior) return prior
    const material = [...workRecords(rows()).materials.values()][0]
    if (!enabled || !options.model || !material || day !== calendarDay(clock)) return
    const id = workHash(JSON.stringify([store.scope.userId, store.scope.characterId, day, kind]))
    const job: LifeWorkItem = { id, dayKey: day, kind, source: options.model.source, materialId: material.id, status: 'queued', completedSteps: 0, totalSteps: 3, createdAtMs: clock.nowMs(), updatedAtMs: clock.nowMs(), completedAtMs: null }
    jobs.set(id, job); save(job); return job
  }
  const tick = () => {
    if (worker) { if (blocked()) active?.abort(); return worker }
    if (blocked()) return Promise.resolve()
    const job = [...jobs.values()].find((job) => job.status === 'queued' || job.status === 'paused' && (job.reason === 'busy' || job.reason === 'lights'))
    if (!job) return Promise.resolve()
    // A fake checkpoint cannot quietly become a real-model work on mode/config changes.
    if (job.source !== options.model!.source) { fail(job, 'model'); return Promise.resolve() }
    // Never attempt a step that does not exist: `life/work-attempt.step` is capped at the last step, so a
    // job whose steps are all committed must settle as completed instead of leaving a phantom "running".
    if (job.completedSteps >= job.totalSteps) { job.status = 'completed'; job.completedAtMs = clock.nowMs(); delete job.reason; save(job); return Promise.resolve() }
    if (attempts() >= DAILY_ATTEMPTS) { pause(job, 'budget'); return Promise.resolve() }
    const abort = new AbortController(); active = abort
    // The attempt row is written before the state change: if the journal rejects it, the job keeps its
    // previous state and no worker is reserved, so no dead "running" state can survive the failure.
    store.append({ type: 'life/work-attempt', workId: job.id, step: job.completedSteps + 1, dayKey: calendarDay(clock) })
    job.status = 'running'; delete job.reason; save(job)
    // Reserve the worker synchronously, even when a fake model fails synchronously.
    worker = Promise.resolve().then(async () => {
      const stop = clock.after(30000, () => abort.abort()); let remove = () => {}; let conflict = false
      try {
        const material = workRecords(rows()).materials.get(job.materialId)!
        if (desk.read(material.path) !== material.text || job.output && workHash(desk.read(job.output.path) ?? '') !== job.output.sha256) { conflict = true; throw new Error('WORK_CONFLICT') }
        const previous = job.output ? desk.read(job.output.path)! : ''
        const chunks = material.text.split('\n\n')
        const input = { kind: job.kind, step: job.completedSteps + 1, totalSteps: 3, material: job.kind === 'read' ? chunks[0] + '\n\n' + chunks[job.completedSteps + 1] : material.text, previous }
        const pending = options.model!.produce(input, abort.signal)
        const output = await Promise.race([pending, new Promise<never>((_resolve, reject) => {
          const listener = () => reject(new Error('WORK_STOPPED')); abort.signal.addEventListener('abort', listener, { once: true }); remove = () => abort.signal.removeEventListener('abort', listener); if (abort.signal.aborted) listener()
        })])
        abort.signal.throwIfAborted(); if (blocked()) { abort.abort(); abort.signal.throwIfAborted() }
        const text = workOutput.parse(output).markdown
        if (text === previous) throw new Error('WORK_NO_PRODUCT')
        const draft: WorkDraft = { id: randomUUID(), workId: job.id, step: input.step, path: workPath(job.id, input.step), text, sha256: workHash(text) }
        const present = desk.read(draft.path)
        if (present !== null && present !== text) { conflict = true; throw new Error('WORK_CONFLICT') }
        store.append({ type: 'life/work-draft', draft })
        try { if (present === null) desk.write(draft.path, text); checkpoint(job, draft) } catch { conflict = true; throw new Error('WORK_CONFLICT') }
      } catch (cause) {
        if (job.status === 'running') {
          if (abort.signal.aborted) pause(job, blocked() ? reason() : 'interrupted')
          else fail(job, conflict ? 'conflict' : cause && typeof cause === 'object' && 'code' in cause && cause.code === 'budget-exceeded' ? 'budget' : 'model')
        }
      } finally { stop(); remove(); active = undefined; worker = undefined; options.changed() }
    }); return worker
  }
  options.scheduler.schedule('life.work', clock.nowMs() + 5000, () => { void tick() }, { everyMs: 5000 })
  return {
    view: (): LifeWorkView => ({ enabled, source: options.model?.source ?? 'none', runningId: active ? [...jobs.values()].find((job) => job.status === 'running')?.id ?? null : null, attemptsToday: attempts(), dailyAttemptLimit: DAILY_ATTEMPTS,
      materials: [...workRecords(rows()).materials.values()].map(({ id, path, sha256, source }) => ({ id, path, sha256, source })), jobs: structuredClone([...jobs.values()].slice(-100)) }),
    ensure, tick, rebuild,
    active: () => !!worker,
    completed: (kind: LifeWorkKind, day: string) => [...jobs.values()].some((job) => job.kind === kind && job.dayKey === day && job.status === 'completed'),
    foreground: () => { active?.abort() },
    setEnabled: (value: boolean) => { enabled = value; if (!value) active?.abort(); options.changed() },
    dispatch: (command: AppCommand): PublicErrorCode | undefined => {
      if (command.type === 'developer.life.seed') {
        if (!options.developer) return 'permission-denied'
        const text = lifeWorkFixtures.material; const id = workHash(text); const path = `合成材料/${id}.md`; const present = desk.read(path)
        if (present !== null && present !== text) return 'unavailable'
        if (present === null) desk.write(path, text)
        if (!workRecords(rows()).materials.has(id)) store.append({ type: 'life/material', material: { id, path, text, sha256: id, source: 'fake' } })
        options.changed(); return
      }
      if (command.type === 'life.work.start') { if (!enabled) return 'unavailable'; if (!ensure(command.kind)) return 'not-configured'; void tick(); return }
      if (command.type !== 'life.work.open' && command.type !== 'life.work.resume' && command.type !== 'life.work.pause') return 'invalid-command'
      const job = jobs.get(command.workId); if (!job) return 'unavailable'
      if (command.type === 'life.work.open') {
        if (!job.output) return 'unavailable'
        const text = desk.read(job.output.path); if (text === null || workHash(text) !== job.output.sha256) return 'unavailable'
        options.open(job.output.path, text, job.source); return
      }
      if (job.status === 'completed') return 'unavailable'
      if (command.type === 'life.work.pause') { if (active && job.status === 'running') active.abort(); pause(job, 'user'); return }
      if (job.completedSteps >= job.totalSteps) {
        // Progress count alone cannot clear a real conflict. Re-check the material and every committed
        // product before settling, even when no model is configured; never schedule a fourth step.
        const replay = workRecords(rows()); const material = replay.materials.get(job.materialId)
        try {
          if (!material || desk.read(material.path) !== material.text || (replay.committed.get(job.id) ?? []).some((draft) => desk.read(draft.path) !== draft.text)) throw new Error('WORK_CONFLICT')
        } catch { fail(job, 'conflict'); return 'unavailable' }
        job.status = 'completed'; job.completedAtMs = rows().findLast((row) => row.type === 'life/work-commit' && row.workId === job.id)?.atMs ?? clock.nowMs(); delete job.reason; save(job); return
      }
      if (!enabled || !options.model || worker) return 'unavailable'
      if (job.source !== options.model.source) { fail(job, 'model'); return 'unavailable' }
      job.status = 'queued'; delete job.reason; save(job); void tick()
    },
    idle: async () => { await worker },
    close: async () => { closed = true; active?.abort(); options.scheduler.cancel('life.work'); await worker },
  }
}
export type LifeWorkService = ReturnType<typeof createLifeWork>
