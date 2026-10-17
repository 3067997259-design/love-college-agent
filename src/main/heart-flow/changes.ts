import type { JournalRecord } from '../journal/schema'
import { deskPathSchema, validateDeskText } from './desk'
export function appliedDeskChanges(rows: readonly JournalRecord[]) {
  const outcomes = new Map(rows.flatMap((row) => row.type === 'desk/settled' ? [[row.id, row.status] as const] : []))
  return rows.filter((row): row is JournalRecord & Extract<JournalRecord, { type: 'desk/change' }> => row.type === 'desk/change' && (!row.pending || outcomes.get(row.id) === 'applied'))
}
export function changeUndone(changes: ReturnType<typeof appliedDeskChanges>, id: string) {
  return changes.some((change) => change.undoes === id || change.rewinds?.includes(id))
}
export function validateDeskChanges(rows: readonly JournalRecord[]) {
  // Failed/pending intents from older versions are not file snapshots to replay.
  for (const row of appliedDeskChanges(rows)) {
    deskPathSchema.parse(row.path); validateDeskText(row.before); validateDeskText(row.after)
  }
}
