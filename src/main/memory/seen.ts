import { createHash } from 'node:crypto'
import type { JournalRecord } from '../journal/schema'
import { redactFixed } from '../privacy/redact'
import type { MemorySource } from './schema'

export const memoryDigest = (text: string) => createHash('sha256').update(text).digest('hex')
/**
 * Where a visible fragment actually came from. `role` only says how the message was transported to the
 * model, so it must never be used as an authority: an inbox notice is projected as role user.
 */
export type SeenOrigin = 'user' | 'mail' | 'document' | 'pomodoro' | 'autonomous' | 'model' | 'tool' | 'unknown'
/** Optional so message-transport snapshots built outside this module keep compiling; absent means unknown. */
export interface SeenFragment extends MemorySource { key: string; text: string; role: 'user' | 'assistant' | 'tool'; origin?: SeenOrigin; source?: string }
/** Origins that carry the user's own explicit statement, and only those, may replace an established fact. */
export const userOrigins = (origin: SeenOrigin | undefined) => origin === undefined || origin === 'user'
const EVENT_ORIGINS: readonly SeenOrigin[] = ['user', 'mail', 'document', 'pomodoro', 'autonomous']
const EVENT_ORIGIN = new Set<SeenOrigin>(EVENT_ORIGINS)
/**
 * The sole memory input surface: successful model input snapshots, never tool/raw or any private store.
 * Origin comes from the journal record that produced the context entry, not from the message body.
 */
export function seenFragments(records: readonly JournalRecord[]): SeenFragment[] {
  let sessionId = ''; const seen = new Set<string>(); const result: SeenFragment[] = []
  const origins = new Map<string, SeenOrigin>()
  for (const row of records) {
    if (row.type !== 'inbox/event') continue
    origins.set(row.id, EVENT_ORIGIN.has(row.source) ? row.source : 'unknown')
  }
  for (const row of records) {
    if (row.type === 'session/header') { sessionId = row.sessionId; continue }
    if (row.type !== 'model/seen') continue
    for (const index of row.eligibleIndexes) {
      const message = row.messages[index]
      if (!message || message.role === 'system' || !message.content.trim()) continue
      const text = redactFixed(message.content)
      const declared = declaredSource(message.content)
      let origin: SeenOrigin
      if (message.role === 'assistant') origin = 'model'
      else if (message.role === 'tool') origin = 'tool'
      else if (declared && EVENT_ORIGINS.includes(declared as SeenOrigin)) origin = declared as SeenOrigin
      else if (message.toolCallId) origin = origins.get(message.toolCallId) ?? 'unknown'
      else origin = 'user'
      for (let offset = 0; offset < text.length; offset += 2000) {
        const key = memoryDigest(JSON.stringify([sessionId, message.role, text, offset]))
        if (seen.has(key)) continue
        seen.add(key)
        result.push({ id: `${sessionId}:${row.seq}:${index}:${offset}`, key, sessionId, frameSeq: row.seq, index, offset, atMs: row.atMs, role: message.role, origin, text: text.slice(offset, offset + 2000), source: text })
      }
    }
  }
  return result
}
/** Inbox notices reach the model as `{"source":"mail","facts":"…"}`. Read only that declared source field. */
function declaredSource(content: string): string | undefined {
  if (!content.startsWith('{')) return undefined
  try { const parsed = JSON.parse(content); return typeof parsed?.source === 'string' ? parsed.source : undefined } catch { return undefined }
}
