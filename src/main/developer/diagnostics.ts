import type { DiagnosticsView } from '../../shared'
import type { Clock } from '../clock'
import type { SessionStore } from '../store/session'
import type { Scheduler } from '../scheduler'
import type { MemoryRepository } from '../memory/repository'
import { searchMemories } from '../memory/retrieval'
import { redactFixed } from '../privacy/redact'

/** Safe read-only projection. Never opens source vaults, artifacts, credentials, or configuration. */
export function buildDiagnostics(options: { clock: Clock; store: SessionStore; scheduler: Scheduler; memory: MemoryRepository; fileFilteringEnabled: boolean; mailStatus: string; pendingFiles: number }): DiagnosticsView {
  const { store, clock } = options; const rows = store.records(); const state = store.projection(); let chars = 0; let contextTruncated = false
  const input = state.lastModelContext ?? state.context
  const context: DiagnosticsView['context'][number][] = []
  for (const message of input.slice(-128)) {
    const text = redactFixed(message.content).slice(0, 6000); if (chars + text.length > 96_000) { contextTruncated = true; break }; chars += text.length
    contextTruncated ||= text.length !== redactFixed(message.content).length
    context.push({ role: message.role, layer: message.content.includes('previousDaysReference') || message.content.includes('conversationSummary') ? 'summary' : message.content.includes('memoryReference') ? 'recall' : message.role === 'system' ? 'policy' : 'conversation', text })
  }
  const starts = rows.filter((row) => row.type === 'turn/start').slice(-20)
  const turns = starts.map((start) => {
    const end = rows.findLast((row) => row.type === 'turn/end' && row.turnId === start.turnId)
    const usage = rows.filter((row) => row.type === 'model/attempt' && row.turnId === start.turnId && row.status === 'success')
    const values = usage.flatMap((row) => row.type === 'model/attempt' ? [row] : [])
    return { id: start.turnId, startedAtMs: start.atMs, endedAtMs: end?.atMs ?? null, status: end?.type === 'turn/end' ? end.reason : state.task?.id === start.turnId ? state.task.status : 'unknown',
      inputTokens: values.some((row) => row.inputTokens != null) ? values.reduce((sum, row) => sum + (row.inputTokens ?? 0), 0) : null,
      outputTokens: values.some((row) => row.outputTokens != null) ? values.reduce((sum, row) => sum + (row.outputTokens ?? 0), 0) : null,
      durationMs: end ? Math.max(0, end.atMs - start.atMs) : null, firstTokenLatencyMs: null, cachedInputTokens: null, cost: null }
  })
  const consumed = new Set(rows.flatMap((row) => row.type === 'inbox/drain' || row.type === 'inbox/drop' ? row.ids : []))
  const inbox = new Map(state.pendingEvents.map((event) => [event.id, { id: event.id, source: event.source as string }]))
  for (const row of rows) if ((row.type === 'user/message' || row.type === 'inbox/event') && !consumed.has(row.id)) inbox.set(row.id, { id: row.id, source: row.type === 'user/message' ? 'user' : row.source })
  const query = state.context.filter((message) => message.role === 'user').slice(-3).map((message) => message.content).join('\n')
  return { contextSource: state.lastModelContext ? 'last-successful-input' : 'not-yet-sent', context, contextTruncated: contextTruncated || input.length > 128,
    turns, queue: options.scheduler.queue().map(({ id, atMs, everyMs, paused }) => ({ id, atMs, ...(everyMs ? { everyMs } : {}), paused })), inbox: [...inbox.values()].slice(-32),
    memoryScores: searchMemories(options.memory.view().items, query, clock.nowMs()).map(({ item, similarity, score }) => ({ id: item.id, score, relevance: similarity, tier: item.tier })),
    privacy: { mailStatus: options.mailStatus, fileFilteringEnabled: options.fileFilteringEnabled, pendingFiles: options.pendingFiles, evidenceAccess: 'user-only' } }
}
