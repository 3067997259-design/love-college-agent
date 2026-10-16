import type { JournalRecord } from '../journal/schema'
export function appliedDeskChanges(rows: readonly JournalRecord[]) {
  const outcomes = new Map(rows.flatMap((row) => row.type === 'desk/settled' ? [[row.id, row.status] as const] : []))
  return rows.filter((row): row is JournalRecord & Extract<JournalRecord, { type: 'desk/change' }> => row.type === 'desk/change' && (!row.pending || outcomes.get(row.id) === 'applied'))
}
