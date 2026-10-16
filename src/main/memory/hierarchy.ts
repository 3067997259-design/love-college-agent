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
/** Total summary slots admitted into one context. Seven of them belong to the recent days. */
export const summaryReferenceBudget = 12
const recentDayBudget = 7
const dateDaysBefore = (day: string, days: number, clock: Clock) => clock.iso(clock.parse(day + 'T12:00:00+08:00') - days * 86_400_000).slice(0, 10)

/** Prefer wider references, but never feed the same source session through overlapping summaries. */
export function summaryReferences(summaries: readonly MemorySummary[], currentSessionId: string, today?: string, clock?: Clock) {
  const covered = new Set<string>(); const selected: MemorySummary[] = []; const rank = { month: 0, week: 1, day: 2 }
  const latest = latestSummaries(summaries); const days = new Map(latest.filter((summary) => summary.level === 'day').flatMap((summary) => summary.sourceSessionIds.map((id) => [id, summary.period] as const)))
  const candidates = latest.filter((summary) => {
    if (summary.sourceSessionIds.includes(currentSessionId)) return false
    if (summary.level === 'day' || !today || !clock) return true
    const cutoff = clock.iso(clock.parse(today + 'T12:00:00+08:00') - (summary.level === 'week' ? 7 : 30) * 86400000).slice(0, 10)
    return summary.sourceSessionIds.every((id) => (days.get(id) ?? today) < cutoff)
  }).sort((a, b) => rank[a.level] - rank[b.level] || b.period.localeCompare(a.period))
  // The recent-day budget is spent first, so wider summaries cannot crowd out the last seven days; the
  // remaining budget then admits earlier weeks and months instead of losing them to a global truncation.
  const recentDay = (summary: MemorySummary) => summary.level === 'day' && !!today && !!clock && summary.period >= dateDaysBefore(today, 6, clock)
  const fill = (pool: readonly MemorySummary[]) => { for (const summary of pool) { if (selected.length >= summaryReferenceBudget) return; if (summary.sourceSessionIds.some((id) => covered.has(id))) continue; selected.push(summary); summary.sourceSessionIds.forEach((id) => covered.add(id)) } }
  fill(candidates.filter(recentDay).sort((a, b) => b.period.localeCompare(a.period)).slice(0, recentDayBudget))
  // `candidates` is already ranked wider-first, so earlier weeks and months win the remaining slots over
  // the day summaries they subsume; the covered set keeps both from representing one session twice.
  fill(candidates.filter((summary) => summary.level !== 'day'))
  fill(candidates.filter((summary) => summary.level === 'day'))
  return selected.sort((a, b) => b.period.localeCompare(a.period))
}

/**
 * Dependency freshness guard. A derived summary declares the child summaries it was built from in
 * `parentSummaryIds`; once one of those children is superseded by a newer version of the same period,
 * the derived text describes a state that no longer holds and must stop representing that period.
 *
 * A declared parent that is absent from `summaries` is treated as unknown, not stale: record loss is a
 * different problem, and the existing behaviour for that case is preserved. Because validity is decided
 * before `summaryReferences` deduplicates by source session, an invalidated wider summary no longer
 * suppresses the narrower current summary that covers the same session.
 */
export function validSummaries(summaries: readonly MemorySummary[]): MemorySummary[] {
  const byId = new Map(summaries.map((summary) => [summary.id, summary]))
  const heads = new Map(summaries.map((summary) => [summary.level + ':' + summary.period, summary.id]))
  const state = new Map<string, boolean>()
  const valid = (summary: MemorySummary, path: ReadonlySet<string>): boolean => {
    const cached = state.get(summary.id); if (cached !== undefined) return cached
    if (path.has(summary.id)) return false
    const next = new Set(path); next.add(summary.id)
    const result = (summary.parentSummaryIds ?? []).every((id) => {
      const parent = byId.get(id); if (!parent) return true
      if (heads.get(parent.level + ':' + parent.period) !== id) return false
      return valid(parent, next)
    })
    state.set(summary.id, result); return result
  }
  return summaries.filter((summary) => valid(summary, new Set()))
}
