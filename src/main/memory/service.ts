import { randomUUID } from 'node:crypto'
import type { AppCommand, MemoryView, PublicErrorCode } from '../../shared'
import type { Clock } from '../clock'
import type { Scheduler } from '../scheduler'
import type { SessionStore } from '../store/session'
import { sessionDayKey } from '../journal/file'
import type { MemoryRepository } from './repository'
import { memoryInputBytes, type SeenFragment } from './seen'
import { boundedMemoryCall, MemoryFailure, validateSummary, type MemoryModel, type createFakeMemoryModel } from './model'
import { createExperienceIndex, boundedSeenInput } from './experience'
import type { MemoryFacts } from './facts'
import type { MemoryProposal } from './airi/core'

type OperationKind = 'extract' | 'compact' | 'day' | 'week' | 'month' | 'review'
export function createMemoryService(options: { clock: Clock; scheduler: Scheduler; store: SessionStore; repository: MemoryRepository; facts: MemoryFacts; model: MemoryModel | null;
  development?: ReturnType<typeof createFakeMemoryModel>; isBusy(): boolean; rolled(): void; changed(): void; failed?(): void;
  limits?: { idleMs?: number; compactChars?: number; hardChars?: number; dailyChars?: number; dailyCalls?: number };
  beforeRoll?(): Promise<void>;
  closingDay?(): void;
  compactRoot?(operationId: string): Promise<{ rootSessionId: string; outcome: import('../../shared/continuity').RootCompactionOutcome }>;
}) {
  const { clock, store, scheduler, repository } = options
  const records = () => store.history?.() ?? store.records()
  let worker: Promise<void> | undefined; let active: AbortController | undefined; let disposed = false; let enabled = true
  let status: MemoryView['status'] = options.model ? 'idle' : 'unconfigured'
  let error: { code: PublicErrorCode; retryable: boolean } | undefined
  let compaction: MemoryView['compaction']
  const idleMs = options.limits?.idleMs ?? 120_000
  const lastUserAt = () => records().reduce((time, row) => row.type === 'user/message' ? Math.max(time, row.atMs) : time, 0)
  const allowed = () => !disposed && enabled && !store.projection().lightsOut
  const backgroundAllowed = () => allowed() && !options.isBusy() && clock.nowMs() - lastUserAt() >= idleMs
  const contextChars = () => JSON.stringify(store.projection().context).length
  const reserve = (kind: OperationKind, chars: number) => {
    const started = records().filter((row) => row.type === 'memory/operation' && row.status === 'started' && sessionDayKey(clock, row.atMs) === sessionDayKey(clock))
    const used = started.reduce((sum, row) => sum + (row.type === 'memory/operation' ? row.reservedChars : 0), 0)
    if (started.length >= (options.limits?.dailyCalls ?? 32) || used + chars > (options.limits?.dailyChars ?? 240_000)) throw new MemoryFailure('budget-exceeded')
    const operationId = randomUUID()
    repository.append({ type: 'memory/operation', operationId, kind: kind === 'review' ? 'extract' : kind, source: options.model!.source, status: 'started', reservedChars: chars })
    return operationId
  }
  const call = async <T>(kind: OperationKind, input: readonly SeenFragment[], signal: AbortSignal, validate: (output: unknown) => T): Promise<T> => {
    const operationId = reserve(kind, memoryInputBytes(input))
    try {
      const output = await boundedMemoryCall(options.model, kind === 'extract' ? 'extract' : 'summarize', input, clock, signal)
      signal.throwIfAborted(); const validated = validate(output)
      repository.append({ type: 'memory/operation', operationId, kind: kind === 'review' ? 'extract' : kind, source: options.model!.source, status: 'success', reservedChars: 0 })
      return validated
    } catch (cause) {
      repository.append({ type: 'memory/operation', operationId, kind: kind === 'review' ? 'extract' : kind, source: options.model!.source, status: 'failed', reservedChars: 0,
        error: { code: cause instanceof MemoryFailure ? cause.code : 'unavailable', retryable: true } })
      throw cause
    }
  }
  const experiences = createExperienceIndex({ clock, store, repository, source: () => options.model!.source,
    policy: options.facts.experiencePolicy,
    summarize: (kind, input, signal) => call(kind, input, signal, output => validateSummary(output, input)) })
  const extractCore = async (signal: AbortSignal) => {
    if (!options.model?.airi) throw new MemoryFailure('not-configured')
    const input = boundedSeenInput(options.facts.pendingSources().slice(0, 5))
    if (!input.length) return
    for (const source of input) {
      const operationId = reserve('extract', memoryInputBytes([source]))
      try {
        await options.facts.capture([source], options.model.airi, signal)
        signal.throwIfAborted()
        repository.append({ type: 'memory/operation', operationId, kind: 'extract', source: options.model.source, status: 'success', reservedChars: 0 })
      } catch (cause) {
        repository.append({ type: 'memory/operation', operationId, kind: 'extract', source: options.model.source, status: 'failed', reservedChars: 0,
          error: { code: cause instanceof MemoryFailure ? cause.code : 'unavailable', retryable: true } })
        throw cause
      }
    }
  }

  const compactCore = async (signal: AbortSignal, requestId: string) => {
    signal.throwIfAborted()
    if (!options.compactRoot) throw new MemoryFailure('unavailable')
    const result = await options.compactRoot(requestId)
    compaction = { ...result, atMs: clock.nowMs() }
    if (result.outcome === 'failed' || result.outcome === 'busy') throw new MemoryFailure('unavailable')
  }
  const rollCore = async (signal: AbortSignal) => {
    if (!experiences.pendingDay() || !backgroundAllowed() || store.projection().pomodoro.status === 'running') throw new MemoryFailure('unavailable')
    const old = experiences.currentPage()
    if (options.model) {
      try { for (let i = 0; i < 4; i++) await extractCore(signal); await experiences.summarizeDay(old, signal) }
      catch (cause) {
        signal.throwIfAborted()
        if (!(cause instanceof MemoryFailure)) throw cause
        // A failed background dependency does not trap all future chat in yesterday's session.
        status = 'failed'; error = { code: cause.code, retryable: true }
      }
    }
    signal.throwIfAborted()
    if (!backgroundAllowed()) throw new MemoryFailure('unavailable')
    await options.beforeRoll?.(); signal.throwIfAborted()
    if (!backgroundAllowed()) throw new MemoryFailure('unavailable')
    // The final synchronous handoff follows the post-capture busy/idle check.
    options.closingDay?.()
    if (store.rotate?.()) { repository.refresh(); options.changed(); options.rolled() }
  }
  const run = (kind: OperationKind, work: (signal: AbortSignal) => Promise<void>) => {
    if (worker || !allowed() || !options.model && kind !== 'day' && kind !== 'review' && !(kind === 'compact' && options.compactRoot)) return worker ?? Promise.resolve()
    const abort = new AbortController(); active = abort; status = kind === 'compact' ? 'compacting' : 'extracting'; error = undefined; options.changed()
    worker = work(abort.signal).catch((cause: unknown) => {
      if (!abort.signal.aborted) { status = 'failed'; error = { code: cause instanceof MemoryFailure ? cause.code : 'internal', retryable: true } }
    }).finally(() => { active = undefined; worker = undefined; if (status !== 'failed') status = options.model ? 'idle' : 'unconfigured'; options.changed() })
    return worker
  }
  const maintenance = async () => {
    if (!backgroundAllowed() || worker) return
    if (experiences.pendingDay()) { await run('day', rollCore); return }
    if (!options.model) return
    const old = experiences.unsummarizedPage()
    await run('extract', async signal => { if (old) await experiences.summarizeDay(old, signal); await extractCore(signal); await experiences.consolidate(signal, 1) })
  }
  scheduler.schedule('memory.maintenance', clock.nowMs() + 30_000, () => { void maintenance().catch(() => options.failed?.()) }, { everyMs: 30_000 })
  const search = async (query: string, requestId: string) => allowed() ? options.facts.search(query.slice(-1200), requestId) : []
  const disclose = (requestId: string, reference: Record<string, unknown>) => {
    const entries = [reference.memoryDirectory, reference.memoryReference].flatMap(value => Array.isArray(value) ? value : [])
    options.facts.disclose(requestId, entries.filter((entry): entry is { id: string; revision: number } => typeof entry?.id === 'string' && Number.isSafeInteger(entry?.revision)))
  }
  return { maintenance,
    initialize: async () => { try { await options.facts.refresh() } catch { status = 'failed'; error = { code: 'unavailable', retryable: true }; options.changed() } },
    reference: async (query: string, requestId: string, firstOfSession: boolean): Promise<Record<string, unknown> | null> => {
      if (!allowed()) return null
      try {
        const directory = await options.facts.directory()
        const recall = query.trim() ? await search(query, requestId) : []
        const days = firstOfSession ? experiences.previousDays() : []
        const index = experiences.index()
        const dayIndex = firstOfSession ? index.days.filter(day => day.sessionId !== store.scope.sessionId).slice(-14) : []
        if (!days.length && !recall.length && !directory.entries.length && !dayIndex.length) return null
        const reference = { ...(days.length ? { previousDaysReference: days } : {}), ...(directory.entries.length ? { memoryDirectory: directory.entries } : {}),
          ...(dayIndex.length ? { experienceIndex: dayIndex, experiencePeriods: index.periods.slice(-12) } : {}),
          ...(recall.length ? { memoryReference: recall } : {}), trust: 'unreviewed-reference' as const }
        disclose(requestId, reference); return reference
      } catch {
        status = 'failed'; error = { code: 'unavailable', retryable: true }; options.changed()
        return { memoryStatus: { available: false, failure: 'storage', note: 'Stored memories could not be read. Do not claim successful recall.' } }
      }
    },
    view: (): MemoryView => {
      const state = repository.view(); const facts = options.facts.factViews(); const valid = facts.filter(fact => fact.factStatus === 'active' && fact.reviewStatus !== 'rejected')
      return { ...(compaction ? { compaction } : {}), status: status === 'idle' || status === 'unconfigured' ? options.model ? 'idle' : 'unconfigured' : status, source: options.model?.source ?? 'none',
        engine: options.facts.status(), facts, operations: options.facts.operations(),
        shortTermCount: valid.filter(item => item.memoryType === 'short_term').length, longTermCount: valid.filter(item => item.memoryType === 'long_term').length,
        summaryCounts: experiences.summaryCounts(), contextChars: contextChars(), lastExtractedAtMs: options.facts.lastExtractedAt(), lastCompactedAtMs: compaction?.atMs ?? null,
        // Historical experience proof remains available to gifts/quill; it is not a second fact engine.
        items: state.items.filter(item => item.kind === 'experience').slice(-20).map(item => ({ id: item.id, text: item.text, kind: item.kind, tier: item.tier, reviewStatus: item.reviewStatus, createdAtMs: item.createdAtMs,
          accessCount: item.accessCount, sourceSessionCount: new Set(item.sources.map(source => source.sessionId)).size, ...(item.supersededBy ? { supersededBy: item.supersededBy } : {}) })),
        ...(options.development ? { scenarioId: options.development.scenario() } : {}), ...(error ? { error } : {}) }
    },
    sessionView: experiences.sessionView, readSession: experiences.readSession, search,
    experienceIndex: experiences.index, expandExperience: experiences.expand,
    bind: options.facts.bind,
    disclose,
    read: options.facts.read,
    propose: (turnId: string, messageId: string, operationId: string, proposal: MemoryProposal, signal: AbortSignal) => {
      if (!allowed()) throw new MemoryFailure('unavailable')
      return options.facts.propose(turnId, messageId, operationId, proposal, signal)
    },
    foreground: () => { active?.abort(); options.facts.foreground() },
    setEnabled: (value: boolean) => { enabled = value; options.facts.runtime.enabled.value = value; if (!value) active?.abort(); options.changed() },
    stateChanged: () => { if (store.projection().lightsOut) { active?.abort(); options.facts.foreground() } },
    dispatch: (command: AppCommand): PublicErrorCode | undefined => {
      if (command.type === 'developer.memory') {
        if (!options.development) return 'permission-denied'
        if (worker) return 'unavailable'; options.development.select(command.scenarioId); error = undefined; status = 'idle'; options.changed(); return
      }
      if (!allowed() || options.isBusy() || worker) return 'unavailable'
      if (command.type === 'session.rollover') {
        if (!experiences.pendingDay() || !backgroundAllowed() || store.projection().pomodoro.status === 'running') return 'unavailable'
        void run('day', rollCore); return
      }
      if (command.type === 'context.compact') { void run('compact', signal => compactCore(signal, command.requestId)); return }
      if (command.type === 'memory.propose') {
        const { kind, targetId, expectedRevision, content, title, summary } = command
        void run('review', async signal => { await options.facts.propose('user:' + command.requestId, 'user:' + command.requestId, command.requestId,
          { kind, ...(targetId ? { targetId } : {}), ...(expectedRevision ? { expectedRevision } : {}), ...(content !== undefined ? { content } : {}), ...(title !== undefined ? { title } : {}), ...(summary !== undefined ? { summary } : {}) }, signal) }); return
      }
      if (command.type === 'memory.review') { void run('review', async () => { await options.facts.review(command.operationId, command.approve) }); return }
      if (command.type === 'memory.fact.review') { void run('review', async () => { await options.facts.reviewFact(command.id, command.expectedRevision, command.approve) }); return }
      if (command.type === 'memory.presentation') { void run('review', async () => { const { id, expectedRevision, title, summary, pinned, pinOrder } = command; await options.facts.presentation({ id, expectedRevision, title, summary, pinned, pinOrder }) }); return }
      if (!options.model) return 'not-configured'
      if (command.type === 'memory.extract') { void run('extract', extractCore); return }
      if (command.type === 'memory.consolidate') { void run('week', (signal) => experiences.consolidate(signal)); return }
      return 'unavailable'
    },
    idle: async () => { await worker },
    close: async () => { disposed = true; active?.abort(); scheduler.cancel('memory.maintenance'); await worker; await options.facts.close() },
  }
}
export type MemoryService = ReturnType<typeof createMemoryService>
