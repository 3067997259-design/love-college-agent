import type { DeliveryView, MailboxView } from '../../shared'
import type { JournalRecord } from '../journal/schema'
import type { CampusArtifact, CampusCandidate } from './schema'
import type { JournalInput } from '../journal/schema'

export interface CampusItem {
  current: CampusCandidate
  calendarUid: string
  originalCreatedAtMs: number
  accepted?: CampusCandidate
  acceptedAtMs?: number
  sequence: number
  exportedRevision?: number
}
export interface CampusProjection {
  items: CampusItem[]
  processed: Omit<Extract<JournalInput, { type: 'mail/processed' }>, 'type'>[]
  artifacts: CampusArtifact[]
  deliveryFailures: DeliveryView[]
  mailbox?: MailboxView
}
/** Global campus projection replays only scoped facts; no source payload or evidence text is an input. */
export function projectCampus(records: readonly JournalRecord[]): CampusProjection {
  const state: CampusProjection = { items: [], processed: [], artifacts: [], deliveryFailures: [] }
  for (const row of records) {
    if (row.type === 'mail/state') state.mailbox = row.view
    else if (row.type === 'mail/processed') {
      if (!state.processed.some((item) => item.sourceKey === row.sourceKey)) state.processed.push({ sharedWithMain: row.sharedWithMain, sourceKey: row.sourceKey, contentHash: row.contentHash, evidenceRef: row.evidenceRef, result: row.result, ...(row.candidateId ? { candidateId: row.candidateId } : {}), ...(row.facts ? { facts: row.facts } : {}) })
    } else if (row.type === 'campus/proposed') {
      const existing = state.items.find((item) => item.current.id === row.candidate.id)
      if (existing) {
        if (row.candidate.revision <= existing.current.revision || row.calendarUid !== existing.calendarUid) throw new Error('CAMPUS_REVISION_INVALID')
        existing.current = row.candidate
      } else state.items.push({ current: row.candidate, calendarUid: row.calendarUid, originalCreatedAtMs: row.candidate.createdAtMs, sequence: 0 })
    } else if (row.type === 'campus/confirmed' || row.type === 'campus/ignored') {
      const item = state.items.find((item) => item.current.id === row.candidateId)
      if (!item || item.current.revision !== row.revision) throw new Error('CAMPUS_CONFIRMATION_INVALID')
      if (row.type === 'campus/ignored') item.current = item.accepted && item.current.status === 'changed'
        ? { ...item.accepted, revision: row.revision, status: 'confirmed', change: undefined }
        : { ...item.current, status: 'ignored' }
      else {
        if (item.accepted && item.accepted.revision !== row.revision) item.sequence++
        item.current = { ...item.current, status: 'confirmed', plannedCompletionIso: row.plannedCompletionIso }
        item.accepted = structuredClone(item.current)
        item.acceptedAtMs = row.atMs
      }
    } else if (row.type === 'campus/exported') {
      const item = state.items.find((item) => item.current.id === row.candidateId)
      if (!item?.accepted || item.accepted.revision !== row.revision || item.sequence !== row.sequence) throw new Error('CAMPUS_EXPORT_INVALID')
      item.exportedRevision = row.revision
      for (const artifact of row.artifacts) if (!state.artifacts.some((entry) => entry.view.artifactId === artifact.view.artifactId)) state.artifacts.push(artifact)
      state.deliveryFailures = state.deliveryFailures.filter((view) => !row.artifacts.some((entry) => entry.view.id === view.id))
    } else if (row.type === 'campus/export-failed') {
      for (const delivery of row.deliveries) {
        state.deliveryFailures = state.deliveryFailures.filter((view) => view.id !== delivery.id)
        state.deliveryFailures.push(delivery)
      }
    }
  }
  return state
}
