// LCA owns the cut; DSH still builds/replays the exact native event prefix.
// Original logs are never edited. A user message inside a running turn is not
// an independent rewind boundary (steering/queued batches fail closed).
import { createHash } from 'node:crypto'

const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const text = content => (content ?? []).filter(block => block.type === 'text').map(block => block.text).join('')
export function planRecontinue(session, target) {
  const events = session.snapshotEvents()
  const human = event => event.type === 'user/message' && event.surfaceOp?.op !== 'replace' && event.data.source?.kind === 'user'
  const identified = events.filter(event => human(event) && (event.data.source?.lcaEventId === target.messageId || event.data.source?.lcaEventIds?.includes(target.messageId)))
  // Older LCA did not transmit the original id. Exact unique trailing user
  // content is an auditable fallback; repeated text is deliberately refused.
  const candidates = identified.length ? identified : events.filter(event => human(event) && event.data.content?.at(-1)?.type === 'text' && event.data.content.at(-1).text === target.text)
  if (candidates.length !== 1) throw new Error('RECONTINUE_TARGET_AMBIGUOUS')
  const message = candidates[0]
  if (message.data.content?.at(-1)?.text !== target.text || (message.data.source?.lcaEventIds?.length ?? 0) > 1) throw new Error('RECONTINUE_TARGET_MISMATCH')
  const start = events.slice(0, message.seq).findLast(event => event.type === 'turn/start')
  const end = events.slice(0, message.seq).findLast(event => event.type === 'turn/end')
  if (!start || end && end.seq > start.seq || events.slice(start.seq, message.seq).some(human)) throw new Error('RECONTINUE_NOT_TURN_START')
  const boundary = events.slice(0, start.seq).findLast(event => event.type === 'turn/end')?.seq ?? null
  // A queued user input before the chosen turn start must not enter the prefix.
  if (events.slice((boundary ?? -1) + 1, start.seq).some(human)) throw new Error('RECONTINUE_PENDING_PREFIX')
  return { messageSeq: message.seq, boundary, prefixDigest: digest(events.slice(0, (boundary ?? -1) + 1)), messageDigest: digest(text(message.data.content)) }
}
