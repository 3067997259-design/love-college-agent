import { createHash } from 'node:crypto'
import type { JournalRecord } from '../journal/schema'
import { redactFixed } from '../privacy/redact'
import type { MemorySource } from './schema'
import { isSourceTool } from '../campus/context'

export const memoryDigest = (text: string) => createHash('sha256').update(text).digest('hex')
/**
 * Where a visible fragment actually came from. `role` only says how the message was transported to the
 * model, so it must never be used as an authority: an inbox notice is projected as role user.
 */
export type SeenOrigin = 'user' | 'mail' | 'document' | 'pomodoro' | 'autonomous' | 'model' | 'tool' | 'unknown'
/** Optional so message-transport snapshots built outside this module keep compiling; absent means unknown. */
export interface SeenFragment extends MemorySource { key: string; text: string; role: 'user' | 'assistant' | 'tool'; origin?: SeenOrigin; source?: string }
/** Model DTO: the full grounding source stays local rather than repeating once per 2k fragment.
 * Small neighboring windows help the extractor notice operators across a split; only text is quotable.
 * Validation still checks the complete local source, including operators outside these windows.
 */
export function memoryModelInput(input: readonly SeenFragment[]) {
  return input.map((fragment) => {
    const source = fragment.source
    const context = source && source.slice(fragment.offset, fragment.offset + fragment.text.length) === fragment.text
      ? { before: source.slice(Math.max(0, fragment.offset - 256), fragment.offset), after: source.slice(fragment.offset + fragment.text.length, fragment.offset + fragment.text.length + 256) } : undefined
    return { id: fragment.id, role: fragment.role, origin: fragment.origin ?? 'unknown', text: fragment.text, ...(context ? { context } : {}) }
  })
}
export const memoryInputBytes = (input: readonly SeenFragment[]) => Buffer.byteLength(JSON.stringify(memoryModelInput(input)), 'utf8')
/** Origins that carry the user's own explicit statement, and only those, may replace an established fact. */
export const userOrigins = (origin: SeenOrigin | undefined) => origin === undefined || origin === 'user'
const EVENT_ORIGINS: readonly SeenOrigin[] = ['user', 'mail', 'document', 'pomodoro', 'autonomous']
const EVENT_ORIGIN = new Set<SeenOrigin>(EVENT_ORIGINS)
const DSH_WORKSPACE = new Set(['dsh.read', 'dsh.write', 'dsh.edit', 'dsh.search', 'dsh.shell', 'dsh.agent'])
/**
 * The sole memory input surface: successful model input snapshots, never tool/raw or any private store.
 * Origin comes from the journal record that produced the context entry, not from the message body.
 */
export function seenFragments(records: readonly JournalRecord[], memoryOnly = false): SeenFragment[] {
  let sessionId = ''; const seen = new Set<string>(); const result: SeenFragment[] = []
  const externalCalls = records.flatMap((row) => row.type === 'tool/call' && isSourceTool(row.templateId) ? [row] : [])
  const externalIds = new Set(externalCalls.map((row) => row.callId))
  // DSH turns keep their tool traffic in DSH's log; the journal says which ones read third-party
  // content (turn/degraded) or did project work (work/activity), and the same D2 rules apply.
  const dshTurns = new Set(records.flatMap((row) => row.type === 'work/turn' ? [row.turnId] : []))
  const externalTurns = new Set([...externalCalls.map((row) => row.turnId), ...records.flatMap((row) => row.type === 'turn/degraded' && dshTurns.has(row.turnId) ? [row.turnId] : [])])
  const externalReplies = new Set(records.flatMap((row) => row.type === 'assistant/message' && externalTurns.has(row.turnId) ? [row.text] : []))
  // D2: workspace tool results (legacy flow desk tools and task desk tools) are work data, never experience memory.
  const workspaceCalls = records.flatMap((row) => row.type === 'tool/call' && (row.templateId.startsWith('desk_') || row.templateId.startsWith('desk.')) ? [row] : [])
  const workspaceIds = new Set(workspaceCalls.map((row) => row.callId))
  const workspaceTurns = new Set([...workspaceCalls.map((row) => row.turnId), ...records.flatMap((row) => row.type === 'work/activity' && DSH_WORKSPACE.has(row.templateId) ? [row.turnId] : [])])
  const workspaceReplies = new Set(records.flatMap((row) => row.type === 'assistant/message' && workspaceTurns.has(row.turnId) ? [row.text] : []))
  const ignored = new Set<string>(); const titles = new Map<string, string>()
  for (const row of records) {
    if (row.type === 'campus/proposed') { titles.set(row.candidate.id, row.candidate.title); ignored.delete(row.candidate.id) }
    if (row.type === 'campus/ignored') ignored.add(row.candidateId)
  }
  const ignoredTitles = [...ignored].map((id) => titles.get(id) ?? '').filter((title) => title.length >= 4)
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
      if (memoryOnly && (message.role === 'tool' && externalIds.has(message.toolCallId ?? '') || message.role === 'assistant' && (externalReplies.has(message.content) || ignoredTitles.some((title) => message.content.includes(title))))) continue
      if (memoryOnly && (message.role === 'tool' && workspaceIds.has(message.toolCallId ?? '') || message.role === 'assistant' && workspaceReplies.has(message.content))) continue
      if (memoryOnly && message.role === 'assistant' && workspaceTurns.has(row.turnId)) continue
      const text = redactFixed(message.content)
      const declared = declaredSource(message.content)
      let origin: SeenOrigin
      if (message.role === 'assistant') origin = 'model'
      else if (message.role === 'tool') origin = 'tool'
      else if (declared && EVENT_ORIGINS.includes(declared as SeenOrigin)) origin = declared as SeenOrigin
      else if (message.toolCallId) origin = origins.get(message.toolCallId) ?? 'unknown'
      else origin = 'user'
      if (memoryOnly && (origin === 'mail' || origin === 'document')) continue
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
