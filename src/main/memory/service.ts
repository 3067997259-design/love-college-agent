import { randomUUID } from 'node:crypto'
import type { AppCommand, MemoryView, MessageView, PublicErrorCode, SessionPage, SessionView } from '../../shared'
import type { Clock } from '../clock'
import type { Scheduler } from '../scheduler'
import type { SessionStore } from '../store/session'
import type { ContextMessage } from '../journal/schema'
import { sessionDayKey } from '../journal/file'
import { projectJournal } from '../journal/projection'
import type { MemoryRepository } from './repository'
import { seenFragments, memoryDigest, type SeenFragment } from './seen'
import { boundedMemoryCall, MemoryFailure, validateMemories, validateSummary, type MemoryModel, type createFakeMemoryModel } from './model'
import { searchMemories } from './retrieval'
import { redactFixed } from '../privacy/redact'
import { profileContext } from '../onboarding/context'
import { closedSummaryGroups, latestSummaries, summaryReferences, validSummaries } from './hierarchy'
import harnessPolicy from '../harness/policy.json'

type OperationKind = 'extract' | 'compact' | 'day' | 'week' | 'month'
export function createMemoryService(options: { clock: Clock; scheduler: Scheduler; store: SessionStore; repository: MemoryRepository; model: MemoryModel | null;
  development?: ReturnType<typeof createFakeMemoryModel>; isBusy(): boolean; rolled(): void; changed(): void; failed?(): void;
  limits?: { idleMs?: number; compactChars?: number; hardChars?: number; dailyChars?: number; dailyCalls?: number };
  includeContextEntries?(seqs: readonly number[]): ReadonlySet<number>;
  beforeRoll?(): Promise<void>;
}) {
  const { clock, store, scheduler, repository } = options
  const records = () => store.history?.() ?? store.records()
  let worker: Promise<void> | undefined; let active: AbortController | undefined; let disposed = false; let enabled = true
  let status: MemoryView['status'] = options.model ? 'idle' : 'unconfigured'
  let error: { code: PublicErrorCode; retryable: boolean } | undefined
  const idleMs = options.limits?.idleMs ?? 120_000
  const lastUserAt = () => records().reduce((time, row) => row.type === 'user/message' ? Math.max(time, row.atMs) : time, 0)
  const allowed = () => !disposed && enabled && !store.projection().lightsOut
  const backgroundAllowed = () => allowed() && !options.isBusy() && clock.nowMs() - lastUserAt() >= idleMs
  const normalEntries = () => { const entries = store.projection().contextEntries; const allowed = options.includeContextEntries?.(entries.map((entry) => entry.seq)); return allowed ? entries.filter((entry) => allowed.has(entry.seq)) : entries }
  const contextChars = () => JSON.stringify(normalEntries().map((entry) => entry.message)).length
  const dayKey = () => store.dayKey?.() ?? sessionDayKey(clock)
  const pendingDay = () => sessionDayKey(clock) > dayKey()
  const reserve = (kind: OperationKind, chars: number) => {
    const started = records().filter((row) => row.type === 'memory/operation' && row.status === 'started' && sessionDayKey(clock, row.atMs) === sessionDayKey(clock))
    const used = started.reduce((sum, row) => sum + (row.type === 'memory/operation' ? row.reservedChars : 0), 0)
    if (started.length >= (options.limits?.dailyCalls ?? 32) || used + chars > (options.limits?.dailyChars ?? 240_000)) throw new MemoryFailure('budget-exceeded')
    const operationId = randomUUID()
    repository.append({ type: 'memory/operation', operationId, kind, source: options.model!.source, status: 'started', reservedChars: chars })
    return operationId
  }
  const call = async <T>(kind: OperationKind, input: readonly SeenFragment[], signal: AbortSignal, validate: (output: unknown) => T): Promise<T> => {
    const operationId = reserve(kind, JSON.stringify(input).length)
    try {
      const output = await boundedMemoryCall(options.model, kind === 'extract' ? 'extract' : 'summarize', input, clock, signal)
      signal.throwIfAborted(); const validated = validate(output)
      repository.append({ type: 'memory/operation', operationId, kind, source: options.model!.source, status: 'success', reservedChars: 0 })
      return validated
    } catch (cause) {
      repository.append({ type: 'memory/operation', operationId, kind, source: options.model!.source, status: 'failed', reservedChars: 0,
        error: { code: cause instanceof MemoryFailure ? cause.code : 'unavailable', retryable: true } })
      throw cause
    }
  }
  const inputLimit = (input: readonly SeenFragment[], chars = 28_000) => {
    const result: SeenFragment[] = []; let used = 0
    for (const fragment of input) { if (used + fragment.text.length > chars) break; result.push(fragment); used += fragment.text.length }
    return result
  }
  const extractCore = async (signal: AbortSignal) => {
    repository.refresh(); const before = repository.view(); const known = new Set(before.keys)
    const input = inputLimit(seenFragments(records()).filter((source) => !known.has(source.key)).slice(0, 5))
    if (!input.length) return
    const entries = await call('extract', input, signal, (output) => validateMemories(output, input, store.scope, before.items))
    signal.throwIfAborted()
    repository.append({ type: 'memory/batch', batchId: memoryDigest(input.map((source) => source.key).join(':')), keys: input.map((source) => source.key), entries, source: options.model!.source })
  }
  const compactCore = async (signal: AbortSignal, force = false) => {
    if (!force && contextChars() < (options.limits?.compactChars ?? 24_000)) return
    const rows = store.records(); const ended = rows.filter((row) => row.type === 'turn/end')
    const cutoff = ended.at(-3)?.seq
    if (!cutoff) { if (force) throw new MemoryFailure('unavailable'); return }
    const selected = normalEntries().filter((entry) => entry.seq <= cutoff)
    if (!selected.length) { if (force) throw new MemoryFailure('unavailable'); return }
    const oldSummarySources = new Set(rows.flatMap((row) => row.type === 'context/compact' && row.seq <= cutoff ? (row.sources ?? []).map((source) => source.id) : []))
    const input = inputLimit(seenFragments(rows).filter((fragment) => oldSummarySources.has(fragment.id) || selected.some((entry) => entry.message.role === fragment.role && redactFixed(entry.message.content).includes(fragment.text))))
    if (!input.length) throw new MemoryFailure('unavailable')
    const summarized = await call('compact', input, signal, (output) => validateSummary(output, input))
    const summary = JSON.stringify({ conversationSummary: summarized.text, reviewStatus: 'unreviewed' })
    if (summary.length >= selected.reduce((sum, entry) => sum + entry.message.content.length, 0)) throw new MemoryFailure('unavailable')
    signal.throwIfAborted()
    repository.append({ type: 'context/compact', fromSeq: Math.min(...selected.map((entry) => entry.seq)), toSeq: cutoff, summary, sources: summarized.sources })
  }
  const pages = () => store.pages?.() ?? [{ sessionId: store.scope.sessionId, dayKey: dayKey(), records: store.records() }]
  const summarizeDay = async (page: ReturnType<typeof pages>[number], signal: AbortSignal) => {
    if (repository.view().summaries.some((summary) => summary.level === 'day' && summary.sourceSessionIds.includes(page.sessionId))) return
    const input = inputLimit(seenFragments(page.records).slice(-24))
    if (!input.length) return
    const summarized = await call('day', input, signal, (output) => validateSummary(output, input))
    signal.throwIfAborted()
    repository.append({ type: 'memory/summary', summary: { id: 'sum:' + memoryDigest('day:' + page.sessionId), level: 'day', period: page.dayKey,
      ...summarized, sourceSessionIds: [page.sessionId], source: options.model!.source } })
  }
  const rollCore = async (signal: AbortSignal) => {
    if (!pendingDay() || !backgroundAllowed() || store.projection().pomodoro.status === 'running') throw new MemoryFailure('unavailable')
    const old = pages().find((page) => page.sessionId === store.scope.sessionId)!
    if (options.model) {
      try { for (let i = 0; i < 4; i++) await extractCore(signal); await summarizeDay(old, signal) }
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
    if (store.rotate?.()) { repository.refresh(); options.changed(); options.rolled() }
  }
  const consolidateCore = async (signal: AbortSignal, limit = 4) => {
    let calls = 0
    for (const group of closedSummaryGroups(repository.view().summaries, sessionDayKey(clock), clock)) {
      const id = 'sum:' + memoryDigest(JSON.stringify([group.level, group.period, group.children.map((child) => child.id)]))
      if (repository.view().summaries.some((summary) => summary.id === id)) continue
      if (calls++ >= limit) break
      const input: SeenFragment[] = group.children.slice(-40).flatMap((child) => child.sources[0] ? [{ ...child.sources[0], id: 'summary:' + child.id, key: memoryDigest(child.id), role: 'assistant' as const, text: child.text }] : [])
      if (!input.length) continue
      const summarized = await call(group.level, input, signal, (output) => validateSummary(output, input))
      const selected = group.children.filter((child) => summarized.sources.some((source) => source.id === 'summary:' + child.id))
      const sources = [...new Map(selected.flatMap((child) => child.sources).map((source) => [source.id, source])).values()].slice(0, 128)
      signal.throwIfAborted()
      repository.append({ type: 'memory/summary', summary: { id, level: group.level, period: group.period, text: summarized.text, sources,
        sourceSessionIds: [...new Set(selected.flatMap((child) => child.sourceSessionIds))].slice(0, 40), parentSummaryIds: group.children.map((child) => child.id).slice(-40), source: options.model!.source } })
    }
  }
  const run = (kind: OperationKind, work: (signal: AbortSignal) => Promise<void>) => {
    if (worker || !allowed() || !options.model && kind !== 'day') return worker ?? Promise.resolve()
    const abort = new AbortController(); active = abort; status = kind === 'compact' ? 'compacting' : 'extracting'; error = undefined; options.changed()
    worker = work(abort.signal).catch((cause: unknown) => {
      if (!abort.signal.aborted) { status = 'failed'; error = { code: cause instanceof MemoryFailure ? cause.code : 'internal', retryable: true } }
    }).finally(() => { active = undefined; worker = undefined; if (status !== 'failed') status = options.model ? 'idle' : 'unconfigured'; options.changed() })
    return worker
  }
  const maintenance = async () => {
    if (!backgroundAllowed() || worker) return
    if (pendingDay()) { await run('day', rollCore); return }
    if (!options.model) return
    const old = pages().filter((page) => page.dayKey < dayKey() && seenFragments(page.records).length && !repository.view().summaries.some((summary) => summary.sourceSessionIds.includes(page.sessionId))).at(-1)
    await run('extract', async (signal) => { if (old) await summarizeDay(old, signal); await extractCore(signal); await compactCore(signal); await consolidateCore(signal, 1) })
  }
  scheduler.schedule('memory.maintenance', clock.nowMs() + 30_000, () => { void maintenance().catch(() => options.failed?.()) }, { everyMs: 30_000 })
  const search = (query: string, requestId: string) => {
    const matches = searchMemories(repository.view().items, query.slice(-1200), clock.nowMs())
    if (matches.length) repository.append({ type: 'memory/access', ids: matches.map((match) => match.item.id), requestId, sessionId: store.scope.sessionId })
    return matches.map(({ item }) => ({ id: item.id, text: item.text, kind: item.kind, tier: item.tier, atMs: item.lastMentionedAtMs, reviewStatus: item.reviewStatus, sources: item.sources.map((source) => source.id) }))
  }
  return { maintenance,
    view: (): MemoryView => {
      const state = repository.view(); const valid = state.items.filter((item) => !item.supersededBy)
      return { status, source: options.model?.source ?? 'none', shortTermCount: valid.filter((item) => item.tier === 'short_term').length, longTermCount: valid.filter((item) => item.tier === 'long_term').length,
        summaryCounts: Object.fromEntries((['day', 'week', 'month'] as const).map((level) => [level, latestSummaries(state.summaries).filter((summary) => summary.level === level).length])) as { day: number; week: number; month: number },
        contextChars: contextChars(), lastExtractedAtMs: state.lastExtractedAtMs, lastCompactedAtMs: state.lastCompactedAtMs,
        items: state.items.slice(-20).map((item) => ({ id: item.id, text: item.text, kind: item.kind, tier: item.tier, reviewStatus: item.reviewStatus, createdAtMs: item.createdAtMs,
          accessCount: item.accessCount, sourceSessionCount: new Set(item.sources.map((source) => source.sessionId)).size, ...(item.supersededBy ? { supersededBy: item.supersededBy } : {}) })),
        ...(options.development ? { scenarioId: options.development.scenario() } : {}), ...(error ? { error } : {}) }
    },
    sessionView: (): SessionView => ({ dayKey: dayKey(), rolloverPending: pendingDay(), pages: pages().slice(-30).map((page) => ({ sessionId: page.sessionId, dayKey: page.dayKey,
      messageCount: page.records.filter((row) => row.type === 'user/message' || row.type === 'assistant/message' && row.text).length,
      summarized: repository.view().summaries.some((summary) => summary.sourceSessionIds.includes(page.sessionId)) })) }),
    readSession: (id: string): SessionPage => {
      const page = pages().find((page) => page.sessionId === id); if (!page) throw new Error('SESSION_UNAVAILABLE')
      const delivered = new Map(projectJournal(page.records).messages.map((message) => [message.id, message]))
      // Explicit user archive access also includes public replies held until rest. It never returns tool results.
      const messages = page.records.flatMap((row): MessageView[] => {
        if (row.type === 'user/message') return [delivered.get(row.id) ?? { id: row.id, role: 'user', text: row.text, createdAtMs: row.atMs, status: 'complete' }]
        if (row.type === 'assistant/message' && row.text) return [{ id: row.id, role: 'assistant', text: row.text, createdAtMs: row.atMs, status: row.status }]
        return []
      })
      const selected = messages.slice(-200); let chars = 0
      const bounded = selected.filter((message) => { chars += message.text.length; return chars <= 200_000 })
      return { sessionId: page.sessionId, dayKey: page.dayKey, messages: bounded, truncated: bounded.length !== messages.length }
    },
    search,
    prepareContext: async (turnId: string, signal: AbortSignal) => {
      active?.abort(); await worker; signal.throwIfAborted()
      if (allowed() && options.model && contextChars() >= (options.limits?.compactChars ?? 24_000)) await run('compact', (abort) => compactCore(AbortSignal.any([abort, signal])))
      signal.throwIfAborted()
      const base = normalEntries()
      const rows = store.records(); const policies = base.filter((entry) => rows.some((row) => row.seq === entry.seq && row.type === 'context/inject' && row.source === 'policy'))
      const memoryCalls = new Set(rows.flatMap((row) => row.type === 'tool/call' && (row.name === 'search_memory' || row.name === 'recall_seen') ? [row.callId] : []))
      const today = base.filter((entry) => !policies.includes(entry))
      const recall = allowed() ? search(today.filter((entry) => entry.message.role === 'user').slice(-3).map((entry) => entry.message.content).join('\n'), turnId) : []
      const summaries = summaryReferences(allowed() ? validSummaries(repository.view().summaries) : [], store.scope.sessionId, sessionDayKey(clock), clock).map((summary) => ({ level: summary.level, dayKey: summary.period, text: summary.text, sourceSessionIds: summary.sourceSessionIds, reviewStatus: 'unreviewed' }))
      const messages: ContextMessage[] = [{ role: 'system', content: harnessPolicy.system }, ...policies.map((entry) => entry.message), ...profileContext(store.projection().onboarding)]; const eligibleIndexes: number[] = []
      const character = records().findLast((row) => row.type === 'character/definition')
      if (character?.type === 'character/definition') messages.push({ role: 'system', content: JSON.stringify({ characterCard: { name: character.definition.name, persona: character.definition.persona }, scope: 'character-configuration-only', authority: 'personality-never-tool-permission' }) })
      if (summaries.length) messages.push({ role: 'user', content: JSON.stringify({ previousDaysReference: summaries }) })
      const lastUser = today.findLastIndex((entry) => entry.message.role === 'user')
      today.forEach((entry, index) => {
        if (index === lastUser && recall.length) messages.push({ role: 'user', content: JSON.stringify({ memoryReference: recall, trust: 'unreviewed-reference' }) })
        if (entry.message.role !== 'system' && !(entry.message.role === 'tool' && memoryCalls.has(entry.message.toolCallId ?? ''))) eligibleIndexes.push(messages.length)
        messages.push(entry.message)
      })
      if (JSON.stringify(messages).length > (options.limits?.hardChars ?? 96_000)) throw new MemoryFailure('context-too-large')
      return { messages, eligibleIndexes }
    },
    foreground: () => { active?.abort() },
    setEnabled: (value: boolean) => { enabled = value; if (!value) active?.abort(); options.changed() },
    stateChanged: () => { if (store.projection().lightsOut) active?.abort() },
    dispatch: (command: AppCommand): PublicErrorCode | undefined => {
      if (command.type === 'developer.memory') {
        if (!options.development) return 'permission-denied'
        if (worker) return 'unavailable'; options.development.select(command.scenarioId); error = undefined; status = 'idle'; options.changed(); return
      }
      if (!allowed() || options.isBusy() || worker) return 'unavailable'
      if (command.type === 'session.rollover') {
        if (!pendingDay() || !backgroundAllowed() || store.projection().pomodoro.status === 'running') return 'unavailable'
        void run('day', rollCore); return
      }
      if (!options.model) return 'not-configured'
      if (command.type === 'memory.extract') { void run('extract', extractCore); return }
      if (command.type === 'memory.consolidate') { void run('week', (signal) => consolidateCore(signal)); return }
      if (command.type === 'context.compact') { void run('compact', (signal) => compactCore(signal, true)); return }
      return 'unavailable'
    },
    idle: async () => { await worker },
    close: async () => { disposed = true; active?.abort(); scheduler.cancel('memory.maintenance'); await worker },
  }
}
export type MemoryService = ReturnType<typeof createMemoryService>
