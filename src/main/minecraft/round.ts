import { randomUUID } from 'node:crypto'
import type { AppEvent, PublicErrorCode } from '../../shared'
import type { Clock } from '../clock'
import type { SessionStore } from '../store/session'
import type { ContextMessage, JournalInput } from '../journal/schema'
import { ModelFailure, type ModelClient } from '../model/types'
import type { HarnessTool } from '../harness/tools'
import { failureNarration } from '../harness/failure'
import { MemoryFailure } from '../memory/model'
import { ResourceFailure } from '../resources/ledger'

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

/**
 * One game round's own loop (chat.ts): her model calls and the game tools, journaled in the round's separate store.
 * Her day with you runs on DSH; a round is short and bounded (steps, tokens, output per call), sees only what the
 * round gives it, and starts from an empty store, so nothing from an earlier round or a crash is resumed. Your
 * messages and in-game chat wait in one inbox; a running turn takes them in at its next step.
 * Before 1.1 the same loop also ran her turns in the book.
 */
export function createRoundLoop(options: {
  store: SessionStore; clock: Clock; model: ModelClient; tools(): readonly HarnessTool[]
  enabled(): boolean
  changed?(reason: AppEvent['reason']): void
  /** Per turn: model calls; per round: reserved tokens (every call); per call: output tokens. */
  limits: { steps: number; tokens: number; outputTokens: number }
  prepareContext(turnId: string, signal: AbortSignal): Promise<{ messages: readonly ContextMessage[]; eligibleIndexes: readonly number[] }>
}) {
  const { store, clock, model, limits } = options
  const currentTools = () => {
    const list = options.tools()
    const tools = new Map(list.map((tool) => [tool.definition.name, tool]))
    if (tools.size !== list.length) throw new Error('DUPLICATE_TOOL')
    return tools
  }
  currentTools()
  const inbox: { id: string; source: 'user' | 'autonomous' }[] = []
  let active: { id: string; abort: AbortController; stopping: boolean } | undefined
  let worker: Promise<void> | undefined
  let disposed = false
  const record = (input: JournalInput) => { store.append(input); if (input.type !== 'model/attempt') options.changed?.(input.type === 'user/message' || input.type === 'assistant/message' || input.type === 'narrator/failure' ? 'message' : 'task') }
  const eligible = () => !disposed && options.enabled() && inbox.length > 0
  const drain = () => {
    const entries = inbox.splice(0)
    if (entries.length) record({ type: 'inbox/drain', ids: entries.map((entry) => entry.id) })
  }
  const finishOpenCalls = (turnId: string) => {
    const rows = store.records()
    const results = new Set(rows.filter((row) => row.type === 'tool/result' && row.turnId === turnId).map((row) => row.type === 'tool/result' ? row.callId : ''))
    const started = new Set(rows.filter((row) => row.type === 'tool/call' && row.turnId === turnId).map((row) => row.type === 'tool/call' ? row.callId : ''))
    for (const row of rows) if (row.type === 'assistant/message' && row.turnId === turnId) for (const call of row.toolCalls ?? []) if (!results.has(call.id)) {
      const outcome = { error: 'interrupted', execution: started.has(call.id) ? 'unknown' : 'not-started' }
      record({ type: 'tool/result', turnId, callId: call.id, ok: false, raw: outcome, visible: outcome, elapsedMs: 0 })
      results.add(call.id)
    }
  }

  const run = async (trigger: 'user' | 'autonomous') => {
    const turn = { id: randomUUID(), abort: new AbortController(), stopping: false }
    active = turn
    record({ type: 'turn/start', turnId: turn.id, trigger })
    const repeated = new Map<string, number>()
    const callIds = new Set<string>()
    let toolsExecuted = false
    let reason: Extract<JournalInput, { type: 'turn/end' }>['reason'] = 'completed'
    let failure: PublicErrorCode | undefined
    let failureHttpStatus: number | undefined
    try {
      for (let step = 0; ; step++) {
        turn.abort.signal.throwIfAborted()
        if (step >= limits.steps) throw new GuardFailure('max-steps', 'step-limit')
        drain()
        const prepared = await options.prepareContext(turn.id, turn.abort.signal)
        turn.abort.signal.throwIfAborted()
        const messages = prepared.messages
        const seen = { messages: structuredClone([...messages]), eligibleIndexes: [...prepared.eligibleIndexes] }
        const definitions = [...currentTools().values()].map((tool) => tool.definition)
        const reservation = Buffer.byteLength(JSON.stringify({ messages, tools: definitions }), 'utf8') + messages.reduce((n, message) => n + (message.imageRefs?.length ?? 0) * 16384, 0) + limits.outputTokens + 1024
        const bucket = trigger === 'user' ? 'work' : 'autonomous'
        const reply = await model.complete({ messages, tools: definitions, signal: turn.abort.signal, toolsExecuted, maxOutputTokens: limits.outputTokens }, (attempt) => {
          if (attempt.status === 'started') {
            const used = store.records().reduce((sum, row) => sum + (row.type === 'model/attempt' && row.status === 'started' ? row.reservedTokens ?? 0 : 0), 0)
            if (used + reservation > limits.tokens) throw new GuardFailure('budget', 'budget-exceeded')
          }
          record({ type: 'model/attempt', turnId: turn.id, ...attempt, bucket, ...(attempt.status === 'started' ? { reservedTokens: reservation } : {}) })
        })
        turn.abort.signal.throwIfAborted()
        record({ type: 'model/seen', turnId: turn.id, source: model.source, ...seen, tools: definitions.map((tool) => tool.name) })
        if (new Set(reply.toolCalls.map((call) => call.id)).size !== reply.toolCalls.length || reply.toolCalls.some((call) => callIds.has(call.id))) throw new GuardFailure('loop', 'repeat-limit')
        record({ type: 'assistant/message', turnId: turn.id, id: randomUUID(), text: reply.text, status: 'complete', ...(reply.toolCalls.length ? { toolCalls: reply.toolCalls } : {}) })
        for (const call of reply.toolCalls) {
          turn.abort.signal.throwIfAborted()
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
        if (!reply.toolCalls.length && !eligible()) break
      }
    } catch (error) {
      reason = turn.abort.signal.aborted ? 'aborted' : error instanceof GuardFailure ? error.reason : 'error'
      if (error instanceof ModelFailure && error.partialText) record({ type: 'assistant/message', turnId: turn.id, id: randomUUID(), text: error.partialText, status: 'interrupted' })
      if (reason !== 'aborted') failure = errorCode(error)
      if (error instanceof ModelFailure) failureHttpStatus = error.httpStatus
    } finally {
      active = undefined
      finishOpenCalls(turn.id)
      record({ type: 'turn/end', turnId: turn.id, reason, ...(failure ? { error: { code: failure, retryable: failure === 'upstream-busy' || failure === 'connection-failed' } } : {}) })
      if (failure) record(failureNarration(store, turn.id, failure, toolsExecuted, failureHttpStatus))
    }
  }
  const kick = () => {
    if (worker || !eligible()) return
    worker = (async () => {
      while (eligible()) await run(inbox.some((entry) => entry.source === 'user') ? 'user' : 'autonomous')
    })().catch(() => { disposed = true /* Never print private exceptions. */ }).finally(() => { worker = undefined; if (eligible()) kick() })
  }
  return {
    send: (text: string, requestId: string, commandHash: string) => {
      if (disposed || inbox.length >= 32) throw new Error('INBOX_UNAVAILABLE')
      const id = randomUUID()
      record({ type: 'user/message', id, text, requestId, commandHash })
      inbox.push({ id, source: 'user' }); kick()
    },
    /** Something in the game she may react to; the same id twice is refused. */
    postEvent: (text: string, eventId: string = randomUUID()) => {
      if (disposed || inbox.length >= 32 || store.records().some((row) => row.type === 'inbox/event' && row.id === eventId)) return false
      record({ type: 'inbox/event', id: eventId, source: 'autonomous', text }); inbox.push({ id: eventId, source: 'autonomous' }); kick(); return true
    },
    stop: (taskId: string) => {
      if (!active || active.id !== taskId) return false
      if (!active.stopping) {
        active.stopping = true
        record({ type: 'turn/cancelling', turnId: taskId })
        if (inbox.length) record({ type: 'inbox/drop', ids: inbox.splice(0).map((entry) => entry.id) })
        active.abort.abort()
      }
      return true
    },
    idle: async () => { await worker },
    dispose: async () => { disposed = true; active?.abort.abort(); await worker },
  }
}
export type RoundLoop = ReturnType<typeof createRoundLoop>
