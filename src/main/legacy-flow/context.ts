import type { SessionStore } from '../store/session'
import { projectJournal } from '../journal/projection'
export function flowContexts(store: SessionStore, includeEntries = true) {
  const rows = store.history?.() ?? store.records(); const positions = new Map<string, number>(); let session = ''
  rows.forEach((row, index) => { if (row.type === 'session/header') session = row.sessionId; positions.set(session + ':' + row.seq, index) })
  const pages = includeEntries ? store.pages?.() ?? [{ sessionId: store.scope.sessionId, records: store.records() }] : []
  const context = pages.flatMap((page) => projectJournal(page.records).contextEntries.map((entry) => ({ ...entry, sessionId: page.sessionId, position: positions.get(page.sessionId + ':' + entry.seq) ?? -1 })))
  const spans = rows.flatMap((row, start) => row.type === 'flow/open' ? [{ id: row.id, start, end: rows.findIndex((other) => other.type === 'flow/close' && other.id === row.id) }] : [])
  return { rows, context, spans, positions }
}
