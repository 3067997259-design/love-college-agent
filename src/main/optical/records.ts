import type { SessionStore } from '../store/session'
import { opticalProof, validateOpticalImpression } from './sources'
import type { JournalRecord } from '../journal/schema'
export function opticalRecords(store: SessionStore) {
  const rows = store.history?.() ?? store.records()
  const frames = rows.flatMap((row) => row.type === 'optical/frame' ? [row.frame] : [])
  const impressions = rows.flatMap((row) => row.type === 'optical/impression' ? [row.impression] : [])
  const ids = new Set<string>()
  for (const frame of frames) {
    if (ids.has(frame.id) || !rows.some((row) => row.type === 'asset/stored' && row.asset.ref === frame.asset.ref)) throw new Error('OPTICAL_FRAME_INVALID')
    ids.add(frame.id); opticalProof(store, frame)
  }
  for (const impression of impressions) {
    const frame = frames.find((frame) => frame.id === impression.frameId); if (!frame) throw new Error('OPTICAL_FRAME_UNAVAILABLE')
    validateOpticalImpression(store, frame, impression)
  }
  return { frames, impressions }
}
/** Archive validation before extraction. No original private source DB or mutable projection is consulted. */
export function validateOpticalRecords(rows: readonly JournalRecord[]) {
  const pages: { sessionId: string; dayKey: string; records: JournalRecord[] }[] = []
  const header = rows[0]; if (header?.type !== 'session/header') throw new Error('OPTICAL_SCOPE_INVALID')
  for (const row of rows) {
    if (row.type === 'session/header') {
      if (row.userId !== header.userId || row.characterId !== header.characterId) throw new Error('OPTICAL_SCOPE_INVALID')
      pages.push({ sessionId: row.sessionId, dayKey: '', records: [] })
    }
    pages.at(-1)!.records.push(row)
  }
  const store: SessionStore = { scope: { userId: header.userId, characterId: header.characterId, sessionId: pages.at(-1)!.sessionId }, history: () => rows, records: () => pages.at(-1)!.records, pages: () => pages,
    projection: () => { throw new Error('OPTICAL_READ_ONLY_VALIDATION') }, append: () => { throw new Error('OPTICAL_READ_ONLY_VALIDATION') }, close: () => {} }
  return opticalRecords(store)
}
