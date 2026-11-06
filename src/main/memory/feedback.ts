import type { JournalRecord } from '../journal/schema'

export interface ReplyFeedbackPolicy {
  /** Replies the user marked as not a memory source; assistant words only. */
  badTurns: Set<string>
  revision: string
}

/** Latest verdict per assistant message wins. Archived feedback rows stay auditable. */
export function replyFeedbackPolicy(records: readonly JournalRecord[]): ReplyFeedbackPolicy {
  const verdicts = new Map<string, 'good' | 'bad'>()
  for (const row of records) if (row.type === 'reply/feedback') verdicts.set(row.messageId, row.verdict)
  const turnByMessage = new Map<string, string>()
  for (const row of records) if (row.type === 'assistant/message') turnByMessage.set(row.id, row.turnId)
  const badTurns = new Set<string>()
  for (const [messageId, verdict] of verdicts) if (verdict === 'bad') {
    const turn = turnByMessage.get(messageId)
    if (turn) badTurns.add(turn)
  }
  const last = [...records].reverse().find(row => row.type === 'reply/feedback')
  return { badTurns, revision: last?.id ?? 'initial' }
}
