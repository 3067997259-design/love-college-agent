import type { JournalRecord } from '../journal/schema'
import { deskPathSchema, validateDeskText } from './desk'
export function appliedDeskChanges(rows: readonly JournalRecord[]) {
  const outcomes = new Map(rows.flatMap((row) => row.type === 'desk/settled' ? [[row.id, row.status] as const] : []))
  const changes = rows.filter((row): row is JournalRecord & Extract<JournalRecord, { type: 'desk/change' }> => row.type === 'desk/change' && (!row.pending || outcomes.get(row.id) === 'applied'))
  // Old saves recorded only normal writes in `rewinds`. The persisted boundary also
  // identifies compensations in that range, including an undo of an earlier write.
  const boundaries = new Map(rows.flatMap((row) => row.type === 'flow/rewind' ? [[row.id, row] as const] : []))
  const first = new Map<string, number>()
  changes.forEach((row, index) => { if (row.rewindId && !first.has(row.rewindId)) first.set(row.rewindId, index) })
  return changes.map((row) => {
    const boundary = row.rewindId && boundaries.get(row.rewindId)
    if (!boundary) return row
    const start = changes.findIndex((change) => change.id === boundary.changeId && change.flowId === row.flowId)
    const end = first.get(row.rewindId!)!
    if (start < 0 || start >= end) return row
    return { ...row, rewinds: changes.slice(start, end).filter((change) => change.flowId === row.flowId && change.path === row.path).map((change) => change.id) }
  })
}
export function changeUndone(changes: ReturnType<typeof appliedDeskChanges>, id: string) {
  const inactive = new Set<string>()
  // Only an effective compensation reverses its targets. Reversing an undo
  // reactivates the original write; historical membership alone is insufficient.
  for (const change of [...changes].reverse()) {
    if (inactive.has(change.id)) continue
    for (const target of change.undoes ? [change.undoes] : change.rewinds ?? []) inactive.add(target)
  }
  return inactive.has(id)
}
export function validateDeskChanges(rows: readonly JournalRecord[]) {
  // Failed/pending intents from older versions are not file snapshots to replay.
  for (const row of appliedDeskChanges(rows)) {
    deskPathSchema.parse(row.path); validateDeskText(row.before); validateDeskText(row.after)
  }
}
