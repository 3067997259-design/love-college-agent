import type { HeartFlowInspection } from '../../shared'
import type { SessionStore } from '../store/session'
import type { createDesk } from './desk'
import { contentHash } from './desk'
import { flowContexts } from './context'
import { appliedDeskChanges } from './changes'
export function inspectHeartFlow(store: SessionStore, desk: ReturnType<typeof createDesk>, booth: boolean, input: { section: HeartFlowInspection['section']; flowId: string }): HeartFlowInspection {
  const { rows, spans, context } = flowContexts(store)
  const span = spans.find((item) => item.id === input.flowId); const flow = span ? rows[span.start] : undefined
  if (!span || flow?.type !== 'flow/open') throw new Error('FLOW_UNAVAILABLE')
  const end = span.end < 0 ? rows.length : span.end
  const within = rows.slice(span.start + 1, end)
  const compactIndex = rows.findLastIndex((row, index) => index > span.start && index < end && row.type === 'flow/compact' && row.id === flow.id)
  const compact = rows[compactIndex]
  const current = context.filter((entry) => entry.position > Math.max(span.start, compactIndex) && entry.position < end && rows[entry.position]?.type !== 'context/inject')
  const mode = within.findLast((row) => row.type === 'flow/mode')
  const turnIds = new Set(within.flatMap((row) => row.type === 'turn/start' ? [row.turnId] : []))
  const usage = within.flatMap((row) => row.type === 'model/attempt' && row.status === 'success' && turnIds.has(row.turnId) ? [row] : [])
  const tokens = (field: 'inputTokens' | 'outputTokens') => usage.length && usage.every((row) => row[field] !== undefined) ? usage.reduce((sum, row) => sum + row[field]!, 0) : null
  const applied = appliedDeskChanges(rows); let truncated = false; let remaining = 96000
  const changes: HeartFlowInspection['changes'][number][] = []
  if (input.section === 'diff') for (const row of applied.filter((row) => row.flowId === flow.id && !row.undoes).slice().reverse()) {
    if (changes.length >= 50 || remaining < 16000) { truncated = true; break }
    const bounded = (text: string | null) => { if (text !== null && text.length > 8000) truncated = true; return text?.slice(0, 8000) ?? null }
    const before = bounded(row.before); const after = bounded(row.after); remaining -= (before?.length ?? 0) + (after?.length ?? 0)
    let current = false; try { current = contentHash(desk.read(row.path)) === contentHash(row.after) } catch { /* A missing/unreadable current file is not evidence of an applied current version. */ }
    changes.push({ id: row.id, path: row.path, before, after, current, undone: applied.some((item) => item.undoes === row.id) })
  }
  return { flowId: flow.id, section: input.section, mode: mode?.type === 'flow/mode' ? mode.mode : flow.mode, scope: 'desk-only', approval: 'each-run', execution: booth ? 'disabled' : 'javascript-sandbox',
    contextChars: JSON.stringify([...flow.prefix, ...(compact?.type === 'flow/compact' ? [{ role: 'user', content: compact.summary }] : []), ...current.map((entry) => entry.message)]).length,
    inputTokens: tokens('inputTokens'), outputTokens: tokens('outputTokens'), cost: null, changes, truncated }
}
