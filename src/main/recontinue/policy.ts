import type { JournalRecord } from '../journal/schema'
import type { JournalInput } from '../journal/schema'

export function validateRecontinue(records: readonly JournalRecord[], input: JournalInput) {
  if (input.type !== 'conversation/recontinued') return
  const policy = continuationPolicy(records)
  const target = records[input.fromSeq - 1]
  if (input.fromSeq < 2 || input.throughSeq !== records.length || input.fromSeq > input.throughSeq ||
    input.parentRevision !== policy.revision || target?.type !== 'user/message' || target.id !== input.targetMessageId || policy.ids.has(target.id) ||
    policy.commits.some(row => row.operationId === input.operationId) || input.sourceRootId === input.nextRootId) throw new Error('JOURNAL_INVALID_RECONTINUE')
}

/** One authority for projection eligibility. Never remove physical/external facts. */
export function continuationPolicy(records: readonly JournalRecord[]) {
  const commits = records.filter(row => row.type === 'conversation/recontinued')
  const ranges = new Map<string, { from: number; through: number }[]>()
  let sessionId = ''
  for (const row of records) {
    if (row.type === 'session/header') sessionId = row.sessionId
    if (row.type === 'conversation/recontinued') ranges.set(sessionId, [...(ranges.get(sessionId) ?? []), { from: row.fromSeq, through: row.throughSeq }])
  }
  const withdrawn = (day: string, seq: number) => ranges.get(day)?.some(range => seq >= range.from && seq <= range.through) ?? false
  const ids = new Set<string>(), turns = new Set<string>(), texts = new Map<string, Set<string>>()
  sessionId = ''
  for (const row of records) {
    if (row.type === 'session/header') sessionId = row.sessionId
    if (!withdrawn(sessionId, row.seq)) continue
    if (row.type === 'user/message' || row.type === 'assistant/message' || row.type === 'inbox/event') {
      ids.add(row.id)
      if (row.text) { const values = texts.get(sessionId) ?? new Set(); values.add(row.text); texts.set(sessionId, values) }
    }
    if (row.type === 'work/turn' || row.type === 'turn/start') turns.add(row.turnId)
  }
  return { withdrawn, ids, turns, texts, revision: commits.at(-1)?.operationId ?? 'initial', commits }
}
