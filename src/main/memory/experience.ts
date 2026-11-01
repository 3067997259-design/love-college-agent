import type { MessageView, SessionPage, SessionView } from '../../shared'
import type { Clock } from '../clock'
import type { SessionStore } from '../store/session'
import { sessionDayKey } from '../journal/file'
import { projectJournal } from '../journal/projection'
import { projectFailure } from '../harness/failure'
import type { MemoryRepository } from './repository'
import { seenFragments, memoryDigest, memoryInputBytes, type SeenFragment } from './seen'
import { latestSummaries, validSummaries, summaryReferences, closedSummaryGroups } from './hierarchy'
import type { MemorySource } from './schema'

export type ExperienceSummaryKind = 'day' | 'week' | 'month'
export function boundedSeenInput(input: readonly SeenFragment[], bytes = 28_000) {
  const result: SeenFragment[] = []
  for (const fragment of input) { if (memoryInputBytes([...result, fragment]) > bytes) break; result.push(fragment) }
  return result
}

/** Append-only experience/day-page projection. It never writes or retrieves a
 * factual memory and never edits DSH history. Diary still reads its own inputs. */
export function createExperienceIndex(options: {
  store: SessionStore; clock: Clock; repository: MemoryRepository
  summarize(kind: ExperienceSummaryKind, input: readonly SeenFragment[], signal: AbortSignal): Promise<{ text: string; sources: MemorySource[] }>
  source(): 'real' | 'fake'
}) {
  const { store, clock, repository } = options
  const records = () => store.history?.() ?? store.records()
  const dayKey = () => store.dayKey?.() ?? sessionDayKey(clock)
  const pages = () => store.pages?.() ?? [{ sessionId: store.scope.sessionId, dayKey: dayKey(), records: store.records() }]
  const retiredSourceIds = () => {
    const rows = records(); const allowed = new Set(seenFragments(rows, true).map(fragment => fragment.id))
    return new Set(seenFragments(rows).filter(fragment => !allowed.has(fragment.id)).map(fragment => fragment.id))
  }
  const summarizeDay = async (page: ReturnType<typeof pages>[number], signal: AbortSignal) => {
    if (repository.view().summaries.some(summary => summary.level === 'day' && summary.sourceSessionIds.includes(page.sessionId))) return
    const input = boundedSeenInput(seenFragments(page.records, true).slice(-24))
    if (!input.length) return
    const summarized = await options.summarize('day', input, signal)
    signal.throwIfAborted()
    repository.append({ type: 'memory/summary', summary: { id: 'sum:' + memoryDigest('day:' + page.sessionId), level: 'day', period: page.dayKey,
      ...summarized, sourceSessionIds: [page.sessionId], source: options.source() } })
  }
  const consolidate = async (signal: AbortSignal, limit = 4) => {
    let calls = 0
    for (const group of closedSummaryGroups(repository.view().summaries, sessionDayKey(clock), clock)) {
      const id = 'sum:' + memoryDigest(JSON.stringify([group.level, group.period, group.children.map(child => child.id)]))
      if (repository.view().summaries.some(summary => summary.id === id)) continue
      if (calls++ >= limit) break
      const input: SeenFragment[] = group.children.slice(-40).flatMap(child => child.sources[0] ? [{ ...child.sources[0], id: 'summary:' + child.id, key: memoryDigest(child.id), role: 'assistant' as const, text: child.text }] : [])
      if (!input.length) continue
      const summarized = await options.summarize(group.level, input, signal)
      const selected = group.children.filter(child => summarized.sources.some(source => source.id === 'summary:' + child.id))
      const sources = [...new Map(selected.flatMap(child => child.sources).map(source => [source.id, source])).values()].slice(0, 128)
      signal.throwIfAborted()
      repository.append({ type: 'memory/summary', summary: { id, level: group.level, period: group.period, text: summarized.text, sources,
        sourceSessionIds: [...new Set(selected.flatMap(child => child.sourceSessionIds))].slice(0, 40), parentSummaryIds: group.children.map(child => child.id).slice(-40), source: options.source() } })
    }
  }
  return {
    pages, dayKey, summarizeDay, consolidate,
    pendingDay: () => sessionDayKey(clock) > dayKey(),
    retiredSourceIds,
    currentPage: () => pages().find(page => page.sessionId === store.scope.sessionId)!,
    unsummarizedPage: () => pages().filter(page => page.dayKey < dayKey() && seenFragments(page.records, true).length
      && !repository.view().summaries.some(summary => summary.sourceSessionIds.includes(page.sessionId))).at(-1),
    previousDays: () => {
      const retired = retiredSourceIds()
      return summaryReferences(validSummaries(repository.view().summaries).filter(summary => summary.sources.every(source => !retired.has(source.id))), store.scope.sessionId, sessionDayKey(clock), clock)
        .map(summary => ({ id: summary.id, level: summary.level, dayKey: summary.period, text: summary.text, sourceSessionIds: summary.sourceSessionIds, reviewStatus: 'unreviewed' as const }))
    },
    summaryCounts: () => Object.fromEntries((['day', 'week', 'month'] as const).map(level => [level, latestSummaries(repository.view().summaries).filter(summary => summary.level === level).length])) as { day: number; week: number; month: number },
    sessionView: (): SessionView => ({ dayKey: dayKey(), rolloverPending: sessionDayKey(clock) > dayKey(), pages: pages().slice(-30).map(page => ({ sessionId: page.sessionId, dayKey: page.dayKey,
      messageCount: page.records.filter(row => row.type === 'user/message' || row.type === 'narrator/failure' || row.type === 'assistant/message' && row.text).length,
      summarized: repository.view().summaries.some(summary => summary.sourceSessionIds.includes(page.sessionId)) })) }),
    readSession: (id: string): SessionPage => {
      const page = pages().find(page => page.sessionId === id); if (!page) throw new Error('SESSION_UNAVAILABLE')
      const delivered = new Map(projectJournal(page.records).messages.map(message => [message.id, message]))
      // Explicit archive access includes public replies held until rest, never tool results.
      const messages = page.records.flatMap((row): MessageView[] => {
        if (row.type === 'user/message') return [delivered.get(row.id) ?? { id: row.id, role: 'user', text: row.text, createdAtMs: row.atMs, status: 'complete' }]
        if (row.type === 'assistant/message' && row.text) return [{ id: row.id, role: 'assistant', text: row.text, createdAtMs: row.atMs, status: row.status }]
        if (row.type === 'narrator/failure') return [{ id: row.id, role: 'narrator', text: row.text, createdAtMs: row.atMs, status: 'complete', failure: projectFailure(page.records, row.failure, row.seq) }]
        return []
      })
      const selected = messages.slice(-200); let chars = 0
      const bounded = selected.filter(message => { chars += message.text.length; return chars <= 200_000 })
      return { sessionId: page.sessionId, dayKey: page.dayKey, messages: bounded, truncated: bounded.length !== messages.length }
    },
  }
}
