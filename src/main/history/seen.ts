import type { JournalRecord } from '../journal/schema'
import type { SessionStore } from '../store/session'
import { redactFixed } from '../privacy/redact'
import { flowContexts } from '../legacy-flow/context'
export interface WitnessedMessage { messageId: string; role: 'user' | 'assistant'; text: string; original: string; atMs: number; frameSeq: number; index: number }
export function witnessedPage(store: SessionStore, sessionId: string): WitnessedMessage[] {
  const page = (store.pages?.() ?? [{ sessionId: store.scope.sessionId, records: store.records() }]).find((page) => page.sessionId === sessionId)
  if (!page) return []
  const { positions, spans } = flowContexts(store, false)
  const frames = page.records.filter((row) => row.type === 'model/seen')
  const messages: WitnessedMessage[] = []
  for (const row of page.records) {
    if ((row.type !== 'user/message' && row.type !== 'assistant/message') || !row.text) continue
    const position = positions.get(sessionId + ':' + row.seq) ?? -1
    if (spans.some((span) => position > span.start && (span.end < 0 || position < span.end))) continue
    const role = row.type === 'user/message' ? 'user' : 'assistant'
    const deliveredAt = role === 'user' ? page.records.find((entry) => entry.type === 'inbox/drain' && entry.seq > row.seq && entry.ids.includes(row.id))?.seq : row.seq
    if (!deliveredAt) continue
    let found: { frame: Extract<JournalRecord, { type: 'model/seen' }>; index: number } | undefined
    for (const frame of frames) {
      if (frame.seq <= deliveredAt) continue
      const index = frame.eligibleIndexes.find((index) => frame.messages[index]?.role === role && frame.messages[index]?.content === row.text)
      if (index !== undefined) { found = { frame, index }; break }
    }
    if (found) messages.push({ messageId: row.id, role, text: redactFixed(row.text), original: row.text, atMs: row.atMs, frameSeq: found.frame.seq, index: found.index })
  }
  return messages
}
