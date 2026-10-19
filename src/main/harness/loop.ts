import { randomUUID } from 'node:crypto'
import type { AppEvent, PublicErrorCode } from '../../shared'
import type { Clock } from '../clock'
import type { SessionStore } from '../store/session'
import type { JournalInput } from '../journal/schema'
import type { ContextMessage } from '../journal/schema'
import { ModelFailure, type ModelClient } from '../model/types'
import type { HarnessTool } from './tools'
import { MemoryFailure } from '../memory/model'
import { ResourceFailure, type ResourceAdmissions } from '../resources/ledger'
import { failureNarration } from './failure'

class GuardFailure extends Error {
  constructor(readonly reason: 'max-steps' | 'loop' | 'budget', readonly code: PublicErrorCode) { super('EXECUTION_GUARD') }
}
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]))
  return value
}
function errorCode(error: unknown): PublicErrorCode {
  if (error instanceof GuardFailure) return error.code
  if (error instanceof MemoryFailure) return error.code
  if (error instanceof ResourceFailure) return error.code
  if (!(error instanceof ModelFailure)) return 'internal'
  return ({ configuration: 'configuration-failed', network: 'connection-failed', timeout: 'connection-failed', upstream: 'upstream-busy', quota: 'quota-exhausted',
    cancelled: 'internal', 'invalid-output': 'invalid-model-output', interrupted: 'stream-interrupted', 'content-filtered': 'content-filtered' } as const)[error.kind]
}

export function createHarness(options: {
  store: SessionStore; clock: Clock; model: ModelClient; tools: readonly HarnessTool[]; getTools?: () => readonly HarnessTool[]
  changed?: (reason: AppEvent['reason']) => void
  failed?: () => void
  enabled?: () => boolean
  backgroundQuiet?: () => boolean
  limits?: { steps?: number; dailyTokens?: number; autonomousTokens?: number; outputTokens?: number }
  /** D3: during focus, the in-hand approved task may continue on its own under per-focus caps. */
  taskRun?: { available(): boolean; focusKey(): string; steps?: number; tokens?: number; turns?: number }
  budget?: ResourceAdmissions
  prepareContext?(turnId: string, signal: AbortSignal): Promise<{ messages: readonly ContextMessage[]; eligibleIndexes: readonly number[] }>
  privateContext?(signal: AbortSignal): Promise<readonly ContextMessage[]>
  contextVersion?(): string
  foreground?(): void
  userWork?(): void
  settled?(): void
  afterTools?(turnId: string, callIds: readonly string[]): void
  turnSettled?(turnId: string): void
}) {
  const { store, clock, model } = options
  const currentTools = () => {
    const list = options.getTools?.() ?? options.tools
    const tools = new Map(list.map((tool) => [tool.definition.name, tool]))
    if (tools.size !== list.length) throw new Error('DUPLICATE_TOOL')
    return tools
  }
  currentTools()
  const inbox: { id: string; source: 'user' | 'pomodoro' | 'mail' | 'document' | 'autonomous' }[] = []
  let active: { id: string; abort: AbortController; stopping: boolean; pauseRequested: boolean } | undefined
  let worker: Promise<void> | undefined
  let disposed = false
  let resumeGate: (() => void) | undefined
  const record = (input: JournalInput) => { store.append(input); if (input.type !== 'model/attempt') options.changed?.(input.type === 'user/message' || input.type === 'assistant/message' || input.type === 'narrator/failure' ? 'message' : 'task') }
  const quiet = () => { const view = store.projection(); return options.backgroundQuiet?.() || view.sleeping || view.mode === 'quiet' || view.pomodoro.phase === 'focus' }
  const eligible = () => !disposed && (options.enabled?.() ?? true) && !store.projection().lightsOut && inbox.some((entry) => entry.source === 'user' || !quiet())
  // D3: a running turn receives every pending event; the focus/quiet beat only decides whether an
  // event may wake an idle harness. Delivery wording may still be held for rest by projection.
  const drain = () => {
    const entries = [...inbox]
    for (const entry of entries) inbox.splice(inbox.indexOf(entry), 1)
    if (entries.length) record({ type: 'inbox/drain', ids: entries.map((entry) => entry.id) })
    return entries.some((entry) => entry.source === 'user')
  }
  // D3 continuation accounting: caps are per focus segment and derived from durable facts, so a
  // restart inside the same focus cannot reset the budget invisibly.
  let focusKey = ''
  let focusStartSeq = 0
  const syncFocus = () => { const key = options.taskRun?.focusKey() ?? ''; if (key === focusKey) return; focusKey = key; focusStartSeq = store.records().length }
  const focusUsage = () => {
    const rows = store.records().slice(focusStartSeq)
    const attempts = rows.flatMap((row) => row.type === 'model/attempt' && row.status === 'success' ? [row] : [])
    return { tokens: attempts.reduce((sum, row) => sum + (row.inputTokens ?? 0) + (row.outputTokens ?? 0), 0),
      turns: rows.filter((row) => row.type === 'turn/start' && row.trigger === 'autonomous').length }
  }
  const continuation = () => {
    const port = options.taskRun
    if (!port || disposed || store.projection().lightsOut) return false
    syncFocus()
    if (!port.available() || store.projection().task?.status === 'waiting-user') return false
    // A question awaiting the user blocks autonomous continuation even after its turn ended.
    const lastQuestion = store.records().findLast((row) => row.type === 'question/requested' || row.type === 'question/answered' || row.type === 'question/closed' || row.type === 'question/committed')
    if (lastQuestion?.type === 'question/requested') return false
    const lastEnd = store.records().findLast((row) => row.type === 'turn/end')
    if (lastEnd && lastEnd.reason !== 'completed') return false
    const used = focusUsage()
    return used.tokens < (port.tokens ?? 40_000) && used.turns < (port.turns ?? 4)
  }
  const finishOpenCalls = (turnId: string) => {    const rows = store.records()
    const results = new Set(rows.filter((row) => row.type === 'tool/result' && row.turnId === turnId).map((row) => row.type === 'tool/result' ? row.callId : ''))
    const started = new Set(rows.filter((row) => row.type === 'tool/call' && row.turnId === turnId).map((row) => row.type === 'tool/call' ? row.callId : ''))
    for (const row of rows) if (row.type === 'assistant/message' && row.turnId === turnId) for (const call of row.toolCalls ?? []) if (!results.has(call.id)) {
      const outcome = { error: 'interrupted', execution: started.has(call.id) ? 'unknown' : 'not-started' }
      record({ type: 'tool/result', turnId, callId: call.id, ok: false, raw: outcome, visible: outcome, elapsedMs: 0 })
      results.add(call.id)
    }
  }
  // Never resume external effects or model calls implicitly after a crash.
  const previous = store.projection().task
  if (previous && ['running', 'cancelling', 'queued', 'waiting-user'].includes(previous.status)) {
    finishOpenCalls(previous.id)
    record({ type: 'turn/end', turnId: previous.id, reason: 'aborted' })
  }
  const consumed = new Set(store.records().flatMap((row) => row.type === 'inbox/drain' || row.type === 'inbox/drop' ? row.ids : []))
  const pending = store.records().filter((row) => (row.type === 'user/message' || row.type === 'inbox/event') && !consumed.has(row.id))
  // Deterministic phase facts survive restart; interrupted user work still requires resubmission.
  for (const row of pending) if (row.type === 'inbox/event' && (row.source === 'pomodoro' || row.source === 'mail' || row.source === 'document')) inbox.push({ id: row.id, source: row.source })
  for (const event of store.projection().pendingEvents) if (!inbox.some((entry) => entry.id === event.id)) inbox.push({ id: event.id, source: event.source })
  const undelivered = pending.filter((row) => row.type !== 'inbox/event' || (row.source !== 'pomodoro' && row.source !== 'mail' && row.source !== 'document')).map((row) => 'id' in row ? row.id : '')
  for (let index = 0; index < undelivered.length; index += 32) record({ type: 'inbox/drop', ids: undelivered.slice(index, index + 32) })

  const run = async (trigger: 'user' | 'pomodoro' | 'mail' | 'document' | 'autonomous') => {
    const turn = { id: randomUUID(), abort: new AbortController(), stopping: false, pauseRequested: false }
    active = turn
    record({ type: 'turn/start', turnId: turn.id, trigger })
    const repeated = new Map<string, number>()
    const callIds = new Set<string>()
    let toolsExecuted = false
    let userEngaged = trigger === 'user'
    const delivery = () => !userEngaged && (quiet() || store.projection().lightsOut) ? { delivery: 'rest' as const } : {}
    let reason: Extract<JournalInput, { type: 'turn/end' }>['reason'] = 'completed'
    let failure: PublicErrorCode | undefined
    let failureHttpStatus: number | undefined
    try {
      for (let step = 0; ; step++) {
        try {
          turn.abort.signal.throwIfAborted()
          if (step >= (trigger === 'autonomous' ? (options.taskRun?.steps ?? 6) : (options.limits?.steps ?? 12))) throw new GuardFailure('max-steps', 'step-limit')
          userEngaged = drain() || userEngaged
          const prepared = options.prepareContext ? await options.prepareContext(turn.id, turn.abort.signal) : undefined
          const recordedMessages = prepared?.messages ?? store.projection().context
          const seen = { messages: structuredClone([...recordedMessages]), eligibleIndexes: prepared ? [...prepared.eligibleIndexes] : recordedMessages.flatMap((message, index) => message.role === 'system' ? [] : [index]) }
          const contextVersion = options.contextVersion?.()
          const supplement = options.privateContext ? await options.privateContext(turn.abort.signal) : []
          const messages = [...recordedMessages, ...supplement]
          const definitions = [...currentTools().values()].map((tool) => tool.definition)
          const outputTokens = options.limits?.outputTokens ?? 2048
          const reservation = Buffer.byteLength(JSON.stringify({ messages, tools: definitions }), 'utf8') + messages.reduce((n, message) => n + (message.imageRefs?.length ?? 0) * 16384, 0) + outputTokens + 1024
          const reply = await model.complete({ messages, tools: definitions, signal: turn.abort.signal, toolsExecuted, maxOutputTokens: outputTokens }, (attempt) => {
            const bucket = trigger === 'user' ? 'work' : 'autonomous'
            let resourceReservationId: string | undefined
            if (attempt.status === 'started') {
              const reservations = store.records().filter((row) => row.type === 'model/attempt' && row.status === 'started')
              const used = reservations.reduce((sum, row) => sum + (row.type === 'model/attempt' ? row.reservedTokens ?? 0 : 0), 0)
              const autonomous = reservations.reduce((sum, row) => sum + (row.type === 'model/attempt' && row.bucket === 'autonomous' ? row.reservedTokens ?? 0 : 0), 0)
              if ((!options.budget || options.limits?.dailyTokens !== undefined) && used + reservation > (options.limits?.dailyTokens ?? 500_000) || bucket === 'autonomous' && (!options.budget || options.limits?.autonomousTokens !== undefined) && autonomous + reservation > (options.limits?.autonomousTokens ?? 100_000)) throw new GuardFailure('budget', 'budget-exceeded')
              resourceReservationId = options.budget?.reserveModel(reservation, bucket)
            }
            record({ type: 'model/attempt', turnId: turn.id, ...attempt, bucket, ...(attempt.status === 'started' ? { reservedTokens: reservation, ...(resourceReservationId ? { resourceReservationId } : {}) } : {}) })
          })
          turn.abort.signal.throwIfAborted()
          if (options.contextVersion?.() !== contextVersion) continue
          record({ type: 'model/seen', turnId: turn.id, source: model.source, ...seen, tools: definitions.map((tool) => tool.name) })
          if (new Set(reply.toolCalls.map((call) => call.id)).size !== reply.toolCalls.length || reply.toolCalls.some((call) => callIds.has(call.id))) throw new GuardFailure('loop', 'repeat-limit')
          record({ type: 'assistant/message', turnId: turn.id, id: randomUUID(), text: reply.text, status: 'complete',
            ...delivery(), ...(reply.toolCalls.length ? { toolCalls: reply.toolCalls } : {}) })
          for (const call of reply.toolCalls) {
            turn.abort.signal.throwIfAborted()
            if (callIds.has(call.id)) throw new GuardFailure('loop', 'repeat-limit')
            callIds.add(call.id)
            let args: Record<string, unknown> | undefined
            try { const parsed: unknown = JSON.parse(call.arguments); if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) args = parsed as Record<string, unknown> } catch { /* A tool error, never execute concatenated/non-object JSON. */ }
            const tool = currentTools().get(call.name)
            const signature = JSON.stringify([call.name, canonical(args ?? call.arguments)])
            const count = (repeated.get(signature) ?? 0) + 1
            repeated.set(signature, count)
            if (count >= 3) throw new GuardFailure('loop', 'repeat-limit')
            const valid = Boolean(args && tool?.validate(args))
            record({ type: 'tool/call', turnId: turn.id, callId: call.id, name: call.name, arguments: (args ?? {}) as Record<string, never>, templateId: tool?.templateId ?? 'tool.unavailable' })
            const started = clock.nowMs()
            let result
            try {
              if (!valid || !tool || !args) result = { ok: false, raw: { error: 'invalid-tool-arguments' }, visible: { error: 'invalid-tool-arguments', requirement: 'one JSON object matching the tool schema' } }
              else { toolsExecuted = true; result = await tool.run(args, { clock, store, turnId: turn.id, callId: call.id, signal: turn.abort.signal }) }
            } catch {
              result = { ok: false, raw: { error: turn.abort.signal.aborted ? 'cancelled' : 'tool-failed' }, visible: { error: turn.abort.signal.aborted ? 'cancelled' : 'tool-failed' } }
            }
            record({ type: 'tool/result', turnId: turn.id, callId: call.id, ...result, elapsedMs: Math.max(0, clock.nowMs() - started) })
            turn.abort.signal.throwIfAborted()
          }
          options.afterTools?.(turn.id, reply.toolCalls.map((call) => call.id))
          if (!reply.toolCalls.length && !eligible()) break
        } catch (error) {
          if (turn.pauseRequested && !turn.stopping && !disposed) {
            if (error instanceof ModelFailure && error.partialText) record({ type: 'assistant/message', turnId: turn.id, id: randomUUID(), text: error.partialText, status: 'interrupted', ...delivery() })
            finishOpenCalls(turn.id)
            record({ type: 'turn/paused', turnId: turn.id })
            if (store.projection().lightsOut) await new Promise<void>((resolve) => { resumeGate = resolve })
            resumeGate = undefined
            if (turn.stopping || disposed) throw new ModelFailure('cancelled')
            turn.abort = new AbortController()
            turn.pauseRequested = false
            record({ type: 'turn/resumed', turnId: turn.id })
            continue
          }
          throw error
        }
      }
    } catch (error) {
      reason = turn.abort.signal.aborted ? 'aborted' : error instanceof GuardFailure ? error.reason : 'error'
      if (error instanceof ModelFailure && error.partialText) record({ type: 'assistant/message', turnId: turn.id, id: randomUUID(), text: error.partialText, status: 'interrupted', ...delivery() })
      if (reason !== 'aborted') failure = errorCode(error)
      if (error instanceof ModelFailure) failureHttpStatus = error.httpStatus
    } finally {
      options.turnSettled?.(turn.id)
      active = undefined
      finishOpenCalls(turn.id)
      record({ type: 'turn/end', turnId: turn.id, reason, ...(failure ? { error: { code: failure, retryable: failure === 'upstream-busy' || failure === 'connection-failed' } } : {}) })
      if (failure) record({ ...failureNarration(store, turn.id, failure, toolsExecuted, failureHttpStatus), ...delivery() })
    }
  }
  const kick = () => {
    if (worker || (!eligible() && !continuation())) return
    options.foreground?.()
    worker = (async () => {
      while (eligible()) {
        const trigger = inbox.find((entry) => entry.source === 'user')?.source ?? inbox[0].source
        await run(trigger)
      }
      // D3: focused work on the in-hand task continues until the per-focus cap, a user decision or a failure.
      while (continuation()) await run('autonomous')
    })().catch(() => { disposed = true; options.failed?.() /* Never print private exceptions. */ }).finally(() => { worker = undefined; options.settled?.(); if (eligible() || continuation()) kick() })
  }
  return {
    source: model.source,
    send: (text: string, requestId: string, commandHash: string) => {
      if (disposed || inbox.length >= 32 || store.projection().lightsOut) throw new Error('INBOX_UNAVAILABLE')
      options.foreground?.()
      options.userWork?.()
      const id = randomUUID()
      record({ type: 'user/message', id, text, requestId, commandHash })
      inbox.push({ id, source: 'user' }); kick()
    },
    postEvent: (source: 'pomodoro' | 'mail' | 'document' | 'autonomous', text: string, eventId: string = randomUUID()) => {
      if (store.records().some((row) => row.type === 'inbox/event' && row.id === eventId || row.type === 'session/carry' && row.pendingEvents?.some((event) => event.id === eventId))) return false
      if (disposed || inbox.length >= 32) return false
      record({ type: 'inbox/event', id: eventId, source, text }); inbox.push({ id: eventId, source }); kick(); return true
    },
    stop: (taskId: string) => {
      if (!active || active.id !== taskId) return false
      if (!active.stopping) {
        active.stopping = true
        record({ type: 'turn/cancelling', turnId: taskId })
        if (inbox.length) record({ type: 'inbox/drop', ids: inbox.splice(0).map((entry) => entry.id) })
        active.abort.abort()
        resumeGate?.()
      }
      return true
    },
    stateChanged: () => { if (store.projection().lightsOut && active) { active.pauseRequested = true; active.abort.abort() } else { resumeGate?.(); kick() } },
    idle: async () => { await worker },
    isBusy: () => !!worker || !!active || inbox.some((item) => item.source === 'user'),
    sessionChanged: () => { if (worker || active) throw new Error('SESSION_BUSY'); inbox.splice(0); inbox.push(...store.projection().pendingEvents.map(({ id, source }) => ({ id, source }))); kick() },
    dispose: async () => { disposed = true; active?.abort.abort(); resumeGate?.(); await worker },
  }
}
