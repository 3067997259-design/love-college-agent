import type { JournalRecord } from '../journal/schema'
import { continuationPolicy } from '../recontinue/policy'

/** The conversation keeps readable multi-question headings. Those headings
 * were authored by the model, so they cannot become a user decision or memory.
 * Only recorded heading prefixes are removed; answer bytes and IDs are kept. */
export function authoredUserMessage(rows: readonly JournalRecord[], id: string) {
  if (continuationPolicy(rows).ids.has(id)) return null
  const row = rows.find(item => item.type === 'user/message' && item.id === id)
  if (row?.type !== 'user/message') return null
  const answer = rows.find(item => item.type === 'question/answered' && item.answerMessageId === id)
  const asked = answer?.type === 'question/answered' ? rows.find(item => item.type === 'question/requested' && item.id === answer.id) : undefined
  if (asked?.type === 'question/requested' && asked.approval) return null
  const headings = asked?.type === 'question/requested' && (asked.items?.length ?? 0) > 1 ? asked.items!.map(item => (item.header ?? item.question) + '：') : []
  const text = row.text.split('\n').map(line => {
    const prefix = headings.find(heading => line.startsWith(heading))
    return prefix ? line.slice(prefix.length) : line
  }).join('\n')
  return text.trim() ? { id, text, atMs: row.atMs } : null
}
