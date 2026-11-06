import type { JournalRecord } from '../journal/schema'
import type { JournalInput } from '../journal/schema'

export function validateRecontinue(records: readonly JournalRecord[], input: JournalInput) {
  if (input.type === 'conversation/recontinue-undone') {
    const policy = continuationPolicy(records), target = policy.allCommits.find(commit => commit.operationId === input.operationId)
    if (!target || policy.commits.at(-1)?.operationId !== target.operationId) throw new Error('JOURNAL_INVALID_RECONTINUE')
    if (records.slice(target.seq).some(row => row.type === 'user/message' || row.type === 'assistant/message')) throw new Error('JOURNAL_INVALID_RECONTINUE')
    return
  }
  if (input.type !== 'conversation/recontinued') return
  const policy = continuationPolicy(records)
  const target = records[input.fromSeq - 1]
  if (input.fromSeq < 2 || input.throughSeq !== records.length || input.fromSeq > input.throughSeq ||
    input.parentRevision !== policy.revision || target?.type !== 'user/message' || target.id !== input.targetMessageId || policy.ids.has(target.id) ||
    policy.allCommits.some(row => row.operationId === input.operationId) || input.sourceRootId === input.nextRootId) throw new Error('JOURNAL_INVALID_RECONTINUE')
}

/** One authority for projection eligibility. Never remove physical/external facts. */
export function continuationPolicy(records: readonly JournalRecord[]) {
  const allCommits = records.filter(row => row.type === 'conversation/recontinued')
  const undone = new Set(records.flatMap(row => row.type === 'conversation/recontinue-undone' ? [row.operationId] : []))
  const commits = allCommits.filter(commit => !undone.has(commit.operationId))
  const ranges = new Map<string, { from: number; through: number }[]>()
  let sessionId = ''
  for (const row of records) {
    if (row.type === 'session/header') sessionId = row.sessionId
    if (row.type === 'conversation/recontinued' && !undone.has(row.operationId)) ranges.set(sessionId, [...(ranges.get(sessionId) ?? []), { from: row.fromSeq, through: row.throughSeq }])
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
  return { withdrawn, ids, turns, texts, revision: commits.at(-1)?.operationId ?? 'initial', commits, allCommits, undone }
}
