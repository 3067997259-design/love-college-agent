import { createHash } from 'node:crypto'
import type { JournalRecord } from '../journal/schema'
import { redactFixed } from '../privacy/redact'
import type { MemorySource } from './schema'

export const memoryDigest = (text: string) => createHash('sha256').update(text).digest('hex')
export interface SeenFragment extends MemorySource { key: string; text: string; role: 'user' | 'assistant' | 'tool' }
/** The sole memory input surface: successful model input snapshots, never tool/raw or any private store. */
export function seenFragments(records: readonly JournalRecord[]): SeenFragment[] {
  let sessionId = ''; const seen = new Set<string>(); const result: SeenFragment[] = []
  for (const row of records) {
    if (row.type === 'session/header') { sessionId = row.sessionId; continue }
    if (row.type !== 'model/seen') continue
    for (const index of row.eligibleIndexes) {
      const message = row.messages[index]
      if (!message || message.role === 'system' || !message.content.trim()) continue
      const text = redactFixed(message.content)
      for (let offset = 0; offset < text.length; offset += 2000) {
        const key = memoryDigest(JSON.stringify([sessionId, message.role, text, offset]))
        if (seen.has(key)) continue
        seen.add(key)
        result.push({ id: `${sessionId}:${row.seq}:${index}:${offset}`, key, sessionId, frameSeq: row.seq, index, offset, atMs: row.atMs, role: message.role, text: text.slice(offset, offset + 2000) })
      }
    }
  }
  return result
}
