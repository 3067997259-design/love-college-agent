import { z } from 'zod'
import type { RecallAnchor, RecallView, PublicErrorCode } from '../../shared'
import type { SessionStore } from '../store/session'
import type { MemoryRepository } from '../memory/repository'
import type { ContextMessage } from '../journal/schema'
import type { HarnessTool } from '../harness/tools'
import { seenFragments } from '../memory/seen'
import { validSummaries } from '../memory/hierarchy'
import { redactFixed } from '../privacy/redact'
import { recallAnchorSchema } from './schema'
import { witnessedPage, type WitnessedMessage } from './seen'
import type { HistoryPhotos } from './photos'
import policy from './policy.json'
type Prepared = { messages: readonly ContextMessage[]; eligibleIndexes: readonly number[] }
const toolInput = z.strictObject({ requestId: z.string().min(1).max(128), relativeStart: z.number().int().min(-20).max(20), count: z.number().int().min(1).max(4) })
export function createHistoryRecall(options: { store: SessionStore; repository: Pick<MemoryRepository, 'view'>; photos: Pick<HistoryPhotos, 'photo'>; changed(): void; canRecall(): boolean; busy(): boolean;
  send(question: string, requestId: string, hash: string): void }) {
  const { store } = options; const rows = () => store.history?.() ?? store.records()
  let enabled = true
  const pages = () => store.pages?.() ?? [{ sessionId: store.scope.sessionId, dayKey: store.dayKey?.() ?? '', records: store.records() }]
  const latest = () => rows().findLast((row) => row.type === 'history/recall-request')
  const resolve = (input: RecallAnchor) => {
    const anchor = recallAnchorSchema.parse(input); const page = pages().find((page) => page.sessionId === anchor.sessionId)
    if (!page || page.sessionId === store.scope.sessionId) throw new Error('RECALL_UNAVAILABLE')
    const messages = witnessedPage(store, page.sessionId); const at = messages.findIndex((message) => message.messageId === anchor.messageId); const message = messages[at]
    if (!message || anchor.end > message.original.length) throw new Error('RECALL_UNWITNESSED')
    const original = message.original.slice(anchor.start, anchor.end)
    if (!original.trim() || Buffer.from(original, 'utf8').toString('utf8') !== original) throw new Error('RECALL_RANGE_INVALID')
    const quote = redactFixed(original); const offset = redactFixed(message.original.slice(0, anchor.start)).length
    if (!quote.trim() || message.text.slice(offset, offset + quote.length) !== quote) throw new Error('RECALL_RANGE_INVALID')
    return { anchor, page, messages, at, quote, offset }
  }
  const excerpt = (message: WitnessedMessage, sessionId: string, around = 0) => {
    let start = Math.max(0, around - 500); let end = Math.min(message.text.length, start + 1600)
    if (start > 0 && /[\uDC00-\uDFFF]/.test(message.text[start])) start++
    if (end < message.text.length && /[\uD800-\uDBFF]/.test(message.text[end - 1])) end--
    return { messageId: message.messageId, role: message.role, text: message.text.slice(start, end), atMs: message.atMs,
      source: { sessionId, frameSeq: message.frameSeq, index: message.index, start, end } }
  }
  const used = (requestId: string) => rows().findLast((row) => row.type === 'history/recall-used' && row.requestId === requestId)
  const requestById = (requestId: string) => rows().findLast((row) => row.type === 'history/recall-request' && row.requestId === requestId)
  /**
   * A recall belongs to the turn that first injected it, not to whichever user message happens to be last.
   * An interjection during the recall turn (a new user message with its own requestId) must not drop the
   * reference mid-turn or make `recall_seen` unavailable (issue #12). Before that first injection the
   * request is still the one carried by the newest user message.
   */
  const relevantRequest = (turnId: string) => {
    const bound = rows().findLast((row) => row.type === 'history/recall-used' && row.turnId === turnId)
    if (bound?.type === 'history/recall-used') return requestById(bound.requestId)
    const user = store.records().findLast((row) => row.type === 'user/message')
    return user?.type === 'user/message' ? requestById(user.requestId) : undefined
  }
  const summaries = (sessionId: string) => {
    const candidates = validSummaries(options.repository.view().summaries).filter((summary) => (summary.level === 'day' || summary.level === 'week') && summary.sourceSessionIds.includes(sessionId))
    if (!candidates.length) return []
    const sessions = new Set(candidates.flatMap((summary) => summary.sources.map((source) => source.sessionId)))
    const proofs = new Set([...sessions].flatMap((id) => witnessedPage(store, id).map((message) => id + ':' + message.frameSeq + ':' + message.index)))
    const fragments = seenFragments(rows()).filter((fragment) => (fragment.origin === 'user' || fragment.origin === 'model') && fragment.role !== 'tool' && proofs.has(fragment.sessionId + ':' + fragment.frameSeq + ':' + fragment.index))
    const allowed = new Map(fragments.map((fragment) => [fragment.id, fragment.text]))
    const safe = candidates.filter((summary) => summary.sourceSessionIds.includes(sessionId)
      && summary.sources.length && summary.sources.every((source) => allowed.has(source.id)) && summary.text.split('\n').every((line) => summary.sources.some((source) => allowed.get(source.id)?.includes(line))))
    return (['day', 'week'] as const).flatMap((level) => { const summary = safe.findLast((summary) => summary.level === level); return summary ? [{ id: summary.id, level: summary.level, text: summary.text.slice(0, 3000), historical: true }] : [] })
  }
  /** The quoted old page as a reference block for her DSH session (it has no LCA context assembly). */
  const reference = (requestId: string): Record<string, unknown> | null => {
    const request = rows().findLast((row) => row.type === 'history/recall-request' && row.requestId === requestId)
    if (!enabled || request?.type !== 'history/recall-request') return null
    const found = resolve(request.anchor)
    const excerpts = found.messages.slice(Math.max(0, found.at - 2), found.at + 3).map((message) => excerpt(message, found.page.sessionId, message.messageId === found.anchor.messageId ? found.offset : 0))
    const value = { recalledSeenReference: { requestId, dayKey: found.page.dayKey, quote: found.quote, excerpts, summaries: summaries(found.page.sessionId), policy: policy.referencePolicy } }
    // The turn has no LCA id yet; the request id marks the use so it is never offered twice, and bind() moves it to the turn.
    if (!used(requestId)) store.append({ type: 'history/recall-used', requestId, turnId: requestId, chars: JSON.stringify(value).length })
    return value
  }
  /** The DSH turn your recall message opened: recall_seen and the recall's status follow that turn. */
  const bind = (requestId: string, turnId: string) => {
    const previous = used(requestId)
    if (previous?.type === 'history/recall-used' && previous.turnId === requestId && turnId !== requestId) store.append({ type: 'history/recall-used', requestId, turnId, chars: previous.chars })
  }
  const prepare = (turnId: string, prepared: Prepared): Prepared => {
    const request = relevantRequest(turnId); if (!enabled || request?.type !== 'history/recall-request') return prepared
    const previous = used(request.requestId)
    if (previous?.type === 'history/recall-used' && previous.turnId !== turnId) return prepared
    const found = resolve(request.anchor)
    const excerpts = found.messages.slice(Math.max(0, found.at - 2), found.at + 3).map((message) => excerpt(message, found.page.sessionId, message.messageId === found.anchor.messageId ? found.offset : 0))
    const reference = { recalledSeenReference: { requestId: request.requestId, dayKey: found.page.dayKey, quote: found.quote, excerpts, summaries: summaries(found.page.sessionId), policy: policy.referencePolicy } }
    const content = JSON.stringify(reference)
    if (!previous) store.append({ type: 'history/recall-used', requestId: request.requestId, turnId, chars: content.length })
    const insertion = Math.max(0, prepared.messages.findLastIndex((message) => message.role === 'user'))
    return { messages: [...prepared.messages.slice(0, insertion), { role: 'user', content }, ...prepared.messages.slice(insertion)], eligibleIndexes: prepared.eligibleIndexes.map((index) => index >= insertion ? index + 1 : index) }
  }
  return {
    prepare, reference, bind,
    recallable: (sessionId: string) => sessionId === store.scope.sessionId ? [] : witnessedPage(store, sessionId).map((message) => message.messageId),
    setEnabled: (value: boolean) => { enabled = value },
    request: (anchor: RecallAnchor, question: string, requestId: string, hash: string): PublicErrorCode | undefined => {
      if (!enabled || !options.canRecall()) return 'unavailable'
      try {
        const found = resolve(anchor)
        store.append({ type: 'history/recall-request', requestId, anchor: found.anchor, sourceCount: Math.min(found.messages.length, found.at + 3) - Math.max(0, found.at - 2) })
        options.send(question, requestId, hash); options.changed(); return
      } catch { return 'invalid-command' }
    },
    view: (): RecallView => {
      const request = latest(); if (request?.type !== 'history/recall-request') return { status: 'idle' }
      const started = used(request.requestId); const end = started?.type === 'history/recall-used' ? rows().findLast((row) => row.type === 'turn/end' && row.turnId === started.turnId) : undefined
      const status = end?.type === 'turn/end' ? end.reason === 'completed' ? 'ready' : 'failed' : options.busy() ? 'recalling' : 'failed'
      const dayKey = pages().find((page) => page.sessionId === request.anchor.sessionId)?.dayKey
      return { status, requestId: request.requestId, anchor: request.anchor, dayKey, sourceCount: request.sourceCount, photo: options.photos.photo(request.anchor.sessionId), ...(status === 'failed' ? { error: { code: 'unavailable', retryable: true } } : {}) }
    },
    tool: (): HarnessTool => ({ definition: { name: 'recall_seen', description: policy.toolDescription, parameters: z.toJSONSchema(toolInput) }, templateId: 'memory.recall', validate: (input) => toolInput.safeParse(input).success,
      run: async (input, context) => {
        context.signal.throwIfAborted(); const parsed = toolInput.parse(input); const request = relevantRequest(context.turnId); const started = used(parsed.requestId)
        if (!enabled || request?.type !== 'history/recall-request' || request.requestId !== parsed.requestId || started?.type !== 'history/recall-used' || started.turnId !== context.turnId) throw new Error('RECALL_UNAVAILABLE')
        const found = resolve(request.anchor); const offset = found.at + parsed.relativeStart
        if (offset < 0 || offset >= found.messages.length) throw new Error('RECALL_RANGE_INVALID')
        const excerpts = found.messages.slice(offset, offset + parsed.count).map((message) => excerpt(message, found.page.sessionId))
        const value = { requestId: parsed.requestId, dayKey: found.page.dayKey, excerpts, policy: policy.referencePolicy }; const chars = JSON.stringify(value).length
        const reads = rows().filter((row) => row.type === 'history/recall-read' && row.requestId === request.requestId)
        if (reads.length >= 8 || started.chars + reads.reduce((sum, row) => sum + (row.type === 'history/recall-read' ? row.chars : 0), 0) + chars > 24_000) throw new Error('RECALL_BUDGET_EXCEEDED')
        store.append({ type: 'history/recall-read', requestId: request.requestId, turnId: context.turnId, chars })
        const result = JSON.parse(JSON.stringify(value)) as Record<string, never>; return { ok: true, raw: result, visible: result }
      } }),
  }
}
export type HistoryRecall = ReturnType<typeof createHistoryRecall>
