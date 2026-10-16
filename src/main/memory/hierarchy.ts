import type { Clock } from '../clock'
import type { MemorySummary } from './schema'

/** Week label is its Shanghai calendar Monday; month label is YYYY-MM. No independent wall clock. */
export function summaryPeriod(day: string, level: 'week' | 'month', clock: Clock) {
  if (level === 'month') return day.slice(0, 7)
  const noon = clock.parse(day + 'T12:00:00+08:00'); const weekday = ((Math.floor(noon / 86_400_000) + 3) % 7 + 7) % 7
  return clock.iso(noon - weekday * 86_400_000).slice(0, 10)
}
export function latestSummaries(summaries: readonly MemorySummary[]) {
  const current = new Map<string, MemorySummary>(); for (const summary of summaries) current.set(summary.level + ':' + summary.period, summary); return [...current.values()]
}
export function closedSummaryGroups(summaries: readonly MemorySummary[], today: string, clock: Clock) {
  const days = latestSummaries(summaries).filter((summary) => summary.level === 'day' && summary.period < today).sort((a, b) => a.period.localeCompare(b.period))
  return (['week', 'month'] as const).flatMap((level) => {
    const groups = new Map<string, MemorySummary[]>()
    for (const day of days) { const period = summaryPeriod(day.period, level, clock); if (period >= summaryPeriod(today, level, clock)) continue; const group = groups.get(period) ?? []; group.push(day); groups.set(period, group) }
    return [...groups].map(([period, children]) => ({ level, period, children }))
  })
}
/** Prefer wider references, but never feed the same source session through overlapping summaries. */
export function summaryReferences(summaries: readonly MemorySummary[], currentSessionId: string) {
  const covered = new Set<string>(); const selected: MemorySummary[] = []; const rank = { month: 0, week: 1, day: 2 }
  const candidates = latestSummaries(summaries).filter((summary) => !summary.sourceSessionIds.includes(currentSessionId)).sort((a, b) => rank[a.level] - rank[b.level] || b.period.localeCompare(a.period))
  for (const summary of candidates) { if (summary.sourceSessionIds.some((id) => covered.has(id))) continue; selected.push(summary); summary.sourceSessionIds.forEach((id) => covered.add(id)) }
  return selected.sort((a, b) => b.period.localeCompare(a.period)).slice(0, 7)
}
