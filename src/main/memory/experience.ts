import type { MessageView, SessionPage, SessionView } from '../../shared'
import type { Clock } from '../clock'
import type { SessionStore } from '../store/session'
import { sessionDayKey } from '../journal/file'
import { projectJournal } from '../journal/projection'
import { projectFailure } from '../harness/failure'
import type { MemoryRepository } from './repository'
import { seenFragments, memoryDigest, memoryInputBytes, type SeenFragment } from './seen'
import { latestSummaries, validSummaries, summaryReferences, closedSummaryGroups, summaryPeriod } from './hierarchy'
import type { MemorySource, MemorySummary } from './schema'
import { MemoryFailure } from './model'
import { continuationPolicy } from '../recontinue/policy'

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
  policy?(): { revision: string; excludedSourceIds: string[]; historicalSourceIds?: string[]; legacyCutoff: number }
}) {
  const { store, clock, repository } = options
  const records = () => store.history?.() ?? store.records()
  const dayKey = () => store.dayKey?.() ?? sessionDayKey(clock)
  const pages = () => store.pages?.() ?? [{ sessionId: store.scope.sessionId, dayKey: dayKey(), records: store.records() }]
  let seenCache: { key: string; retired: Set<string>; allowed: Map<string, SeenFragment[]> } | undefined
  const seenState = () => {
    const rows = records(), key = `${store.scope.sessionId}:${rows.length}:${rows.at(-1)?.seq ?? 0}`
    if (seenCache?.key === key) return seenCache
    const retired = new Set<string>(), canonicalAllowed = seenFragments(rows, true, true), allowedBySession = new Map<string, SeenFragment[]>()
    for (const fragment of canonicalAllowed) { const group = allowedBySession.get(fragment.sessionId) ?? []; group.push(fragment); allowedBySession.set(fragment.sessionId, group) }
    for (const canonical of [false, true]) {
      const allowed = new Set((canonical ? canonicalAllowed : seenFragments(rows, true)).map(fragment => fragment.id))
      for (const fragment of seenFragments(rows, false, canonical, true, true)) if (!allowed.has(fragment.id)) retired.add(fragment.id)
    }
    return seenCache = { key, retired, allowed: allowedBySession }
  }
  const retiredSourceIds = () => new Set(seenState().retired)
  const policy = () => {
    const facts = options.policy?.() ?? { revision: 'initial', excludedSourceIds: [], legacyCutoff: 0 }, retired = [...retiredSourceIds()].sort()
    return { ...facts, retired: new Set(retired), stamp: facts.revision }
  }
  const sourceId = (fragment: SeenFragment) => fragment.sourceEventId ? `event:${fragment.sourceEventId}` : fragment.id
  const fragments = (sessionId: string, state = policy(), includeSuperseded = false) => (seenState().allowed.get(sessionId) ?? []).filter(fragment => fragment.atMs > state.legacyCutoff
    && (!state.excludedSourceIds.includes(sourceId(fragment)) || includeSuperseded && state.historicalSourceIds?.includes(sourceId(fragment))))
  const digest = (input: readonly SeenFragment[]) => memoryDigest(JSON.stringify(input.map(item => item.key)))
  const headOf = (page: ReturnType<typeof pages>[number]) => latestSummaries(repository.view().summaries).find(summary => summary.level === 'day' && summary.period === page.dayKey && summary.sourceSessionIds.includes(page.sessionId))
  const covered = (head: MemorySummary | undefined, input: readonly SeenFragment[], stamp: string) => head?.sourcePolicy === stamp && head.coverage
    && head.coverage.count <= input.length && head.coverage.digest === digest(input.slice(0, head.coverage.count)) ? head.coverage.count : 0
  const needsSummary = (page: ReturnType<typeof pages>[number]) => {
    const state = policy(), input = fragments(page.sessionId, state)
    return input.length > covered(headOf(page), input, state.stamp)
  }
  const eligibleSummaries = () => {
    const state = policy()
    const all = repository.view().summaries
    const continuedDays = new Set(continuationPolicy(records()).commits.map(commit => pages().find(page => page.records.includes(commit))?.sessionId).filter(Boolean))
    const base = validSummaries(all).filter(summary => (summary.sourcePolicy ?? 'initial') === state.stamp
      && (!summary.sourceSessionIds.some(id => continuedDays.has(id)) || !!summary.coverage && (summary.level === 'day' || !!summary.parentSummaryIds?.length))
      && summary.sources.every(source => !state.retired.has(source.id))
      && (summary.level !== 'day' || !summary.coverage || summary.sourceSessionIds.every(id => covered(summary, fragments(id, state), state.stamp) === summary.coverage!.count)))
    const ids = new Set(base.map(summary => summary.id)), known = new Set(all.map(summary => summary.id))
    for (let previous = -1; previous !== ids.size;) { previous = ids.size; for (const summary of base) if (summary.parentSummaryIds?.some(id => (known.has(id) || summary.sourceSessionIds.some(day => continuedDays.has(day))) && !ids.has(id))) ids.delete(summary.id) }
    return base.filter(summary => ids.has(summary.id))
  }
  const summarizeDay = async (page: ReturnType<typeof pages>[number], signal: AbortSignal) => {
    const state = policy(), all = fragments(page.sessionId, state), previous = headOf(page), count = covered(previous, all, state.stamp)
    if (count >= all.length) return
    const prefix: SeenFragment[] = count && previous?.sources[0] ? [{ ...previous.sources[0], id: `summary:${previous.id}`, key: memoryDigest(previous.id), role: 'assistant', origin: 'model', text: previous.text }] : []
    const input = boundedSeenInput([...prefix, ...all.slice(count)])
    const nextCount = count + input.length - prefix.length
    if (nextCount <= count) throw new MemoryFailure('budget-exceeded')
    const summarized = await options.summarize('day', input, signal)
    signal.throwIfAborted()
    const coveredDigest = digest(all.slice(0, nextCount))
    if (policy().stamp !== state.stamp || digest(fragments(page.sessionId).slice(0, nextCount)) !== coveredDigest) throw new MemoryFailure('unavailable')
    const sources = [...new Map(summarized.sources.flatMap(source => source.id === prefix[0]?.id ? previous!.sources : [source]).map(source => [source.id, source])).values()].slice(0, 128)
    repository.append({ type: 'memory/summary', summary: { id: 'sum:' + memoryDigest(JSON.stringify(['day', page.sessionId, state.stamp, coveredDigest])), level: 'day', period: page.dayKey,
      text: summarized.text, sources, sourceSessionIds: [page.sessionId], source: options.source(), sourcePolicy: state.stamp,
      coverage: { count: nextCount, digest: coveredDigest, complete: nextCount === all.length }, ...(count && previous ? { previousSummaryId: previous.id } : {}) } })
  }
  const consolidate = async (signal: AbortSignal, limit = 4) => {
    let calls = 0
    const state = policy()
    const complete = eligibleSummaries().filter(summary => summary.level !== 'day' || summary.sourceSessionIds.every(id => { const page = pages().find(page => page.sessionId === id); return !page || !needsSummary(page) }))
    for (const group of closedSummaryGroups(complete, sessionDayKey(clock), clock)) {
      const previous = latestSummaries(eligibleSummaries()).find(summary => summary.level === group.level && summary.period === group.period)
      const previousIds = previous?.parentSummaryIds ?? []
      const count = previous?.sourcePolicy === state.stamp && previous.coverage && previousIds.every((id, index) => group.children[index]?.id === id) ? previousIds.length : 0
      if (count >= group.children.length) continue
      if (calls++ >= limit) break
      const prefix: SeenFragment[] = count && previous?.sources[0] ? [{ ...previous.sources[0], id: `summary:${previous.id}`, key: memoryDigest(previous.id), role: 'assistant', origin: 'model', text: previous.text }] : []
      const input = boundedSeenInput([...prefix, ...group.children.slice(count).flatMap(child => child.sources[0]
        ? [{ ...child.sources[0], id: 'summary:' + child.id, key: memoryDigest(child.id), role: 'assistant' as const, origin: 'model' as const, text: child.text }] : [])])
      const nextCount = count + input.length - prefix.length
      if (nextCount <= count) continue
      const children = group.children.slice(0, nextCount)
      const childDigest = memoryDigest(JSON.stringify(children.map(child => child.id)))
      const id = 'sum:' + memoryDigest(JSON.stringify([group.level, group.period, childDigest, state.stamp]))
      if (repository.view().summaries.some(summary => summary.id === id)) continue
      const summarized = await options.summarize(group.level, input, signal)
      const selected = [...children, ...(prefix.length && previous ? [previous] : [])].filter(child => summarized.sources.some(source => source.id === 'summary:' + child.id))
      const sources = [...new Map(selected.flatMap(child => child.sources).map(source => [source.id, source])).values()].slice(0, 128)
      signal.throwIfAborted()
      if (policy().stamp !== state.stamp || !children.every(child => latestSummaries(repository.view().summaries).some(head => head.id === child.id))) throw new MemoryFailure('unavailable')
      repository.append({ type: 'memory/summary', summary: { id, level: group.level, period: group.period, text: summarized.text, sources,
        sourceSessionIds: [...new Set(children.flatMap(child => child.sourceSessionIds))].slice(0, 40), parentSummaryIds: children.map(child => child.id), source: options.source(), sourcePolicy: state.stamp,
        coverage: { count: nextCount, digest: childDigest, complete: nextCount === group.children.length }, ...(count && previous ? { previousSummaryId: previous.id } : {}) } })
    }
  }
  const index = () => {
    const state = policy(), summaries = latestSummaries(eligibleSummaries())
    const days = pages().map(page => {
      const input = fragments(page.sessionId, state), head = summaries.find(item => item.level === 'day' && item.sourceSessionIds.includes(page.sessionId))
      const count = covered(head, input, state.stamp)
      return { sessionId: page.sessionId, period: page.dayKey, revision: memoryDigest(JSON.stringify([state.stamp, digest(input), page.records.filter(row => row.type === 'work/checkpoint').map(row => row.seq)])),
        summaryId: head?.id ?? null, coverage: { count, total: input.length, complete: count === input.length },
        historicalFragments: fragments(page.sessionId, state, true).length - input.length,
        checkpointCount: page.records.filter(row => row.type === 'work/checkpoint').length,
        workCheckpoints: page.records.flatMap(row => row.type === 'work/checkpoint' ? [{ id: row.id, workId: row.workId, revision: row.revision, outcome: row.outcome, evidenceCount: row.evidenceCount }] : []).slice(-16) }
    })
    const periods = (['week', 'month'] as const).flatMap(level => [...new Set(days.map(day => summaryPeriod(day.period, level, clock)))].map(period => ({ level, period,
      dayKeys: [...new Set(days.filter(day => summaryPeriod(day.period, level, clock) === period).map(day => day.period))],
      summaryId: summaries.find(summary => summary.level === level && summary.period === period)?.id ?? null })))
    return { days, periods, authority: 'historical-index-not-current-facts' }
  }
  return {
    pages, dayKey, summarizeDay, consolidate, index,
    expand: (sessionId: string, revision: string, offset: number, includeSuperseded = false) => {
      const entry = index().days.find(day => day.sessionId === sessionId)
      if (!entry || entry.revision !== revision) throw new Error('EXPERIENCE_REVISION_CHANGED')
      const state = policy(), all = fragments(sessionId, state, includeSuperseded), selected = boundedSeenInput(all.slice(offset, offset + 12), 20_000)
      return { ...entry, fragments: selected.map(fragment => ({ id: fragment.id, text: fragment.text, role: fragment.role, origin: fragment.origin, atMs: fragment.atMs,
        superseded: state.excludedSourceIds.includes(sourceId(fragment)) })),
        nextOffset: offset + selected.length < all.length ? offset + selected.length : null, authority: 'historical-successful-input-not-current-permission-or-new-experience' }
    },
    pendingDay: () => sessionDayKey(clock) > dayKey(),
    retiredSourceIds,
    currentPage: () => pages().find(page => page.sessionId === store.scope.sessionId)!,
    unsummarizedPage: () => pages().filter(page => page.dayKey < dayKey()).find(needsSummary),
    previousDays: () => {
      return summaryReferences(eligibleSummaries(), store.scope.sessionId, sessionDayKey(clock), clock)
        .map(summary => ({ id: summary.id, level: summary.level, dayKey: summary.period, text: summary.text, sourceSessionIds: summary.sourceSessionIds, reviewStatus: 'unreviewed' as const,
          ...(summary.coverage ? { coverage: summary.coverage } : {}), authority: 'historical-summary-current-decisions-and-reviewed-facts-take-precedence' }))
    },
    summaryCounts: () => Object.fromEntries((['day', 'week', 'month'] as const).map(level => [level, latestSummaries(repository.view().summaries).filter(summary => summary.level === level).length])) as { day: number; week: number; month: number },
    sessionView: (): SessionView => ({ dayKey: dayKey(), rolloverPending: sessionDayKey(clock) > dayKey(), pages: pages().slice(-30).map(page => ({ sessionId: page.sessionId, dayKey: page.dayKey,
      messageCount: page.records.filter(row => row.type === 'user/message' || row.type === 'narrator/failure' || row.type === 'assistant/message' && row.text).length,
      summarized: !needsSummary(page) && eligibleSummaries().some(summary => summary.sourceSessionIds.includes(page.sessionId)) })) }),
    readSession: (id: string): SessionPage => {
      const page = pages().find(page => page.sessionId === id); if (!page) throw new Error('SESSION_UNAVAILABLE')
      const policy = continuationPolicy(page.records)
      const delivered = new Map(projectJournal(page.records).messages.map(message => [message.id, message]))
      // Explicit archive access includes public replies held until rest, never tool results.
      const messages = page.records.flatMap((row): MessageView[] => {
        if (row.type === 'user/message') return [delivered.get(row.id) ?? { id: row.id, role: 'user', text: row.text, createdAtMs: row.atMs, status: 'complete' }]
        if (row.type === 'assistant/message' && row.text) return [{ id: row.id, role: 'assistant', text: row.text, createdAtMs: row.atMs, status: row.status }]
        if (row.type === 'narrator/failure') return [{ id: row.id, role: 'narrator', text: row.text, createdAtMs: row.atMs, status: 'complete', failure: projectFailure(page.records, row.failure, row.seq) }]
        return []
      })
      for (const message of messages) if (policy.ids.has(message.id)) message.withdrawn = true
      const selected = messages.slice(-200); let chars = 0
      const bounded = selected.filter(message => { chars += message.text.length; return chars <= 200_000 })
      return { sessionId: page.sessionId, dayKey: page.dayKey, messages: bounded, truncated: bounded.length !== messages.length }
    },
  }
}
