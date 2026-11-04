import { randomUUID } from 'node:crypto'
import { recordWorkInterruption } from './result'
import { isAbsolute } from 'node:path'
import type { Clock } from '../clock'
import type { ContinuityOwner } from '../../shared/continuity'
import { openWorkJournal, parseWorkJournal, workDigest, workOwnerSchema, workRecordSchema, type WorkRecord } from './journal'

/** Read-only archive inspection shares the live journal's checksum and framing
 * rules. Nested checkpoints may predate a restore, but never belong to a
 * different person, character, project, or task. */
export function inspectWorkArchive(bytes: Uint8Array, expected: Pick<ContinuityOwner, 'userId' | 'characterId'> & Partial<Pick<ContinuityOwner, 'dataRootId'>>) {
  const content = Buffer.from(bytes).toString('utf8')
  if (!content.startsWith('\x1e') || bytes.byteLength > 128 * 1024 * 1024) throw new Error('WORK_ARCHIVE_INVALID')
  const first = content.split('\x1e', 2)[1]
  const owner = workOwnerSchema.parse((JSON.parse(first) as { row?: { owner?: unknown } }).row?.owner)
  if (owner.userId !== expected.userId || owner.characterId !== expected.characterId || expected.dataRootId && owner.dataRootId !== expected.dataRootId) throw new Error('WORK_ARCHIVE_SCOPE_MISMATCH')
  const rows = parseWorkJournal(content, owner)
  const latest = new Map<string, WorkRecord>()
  for (const row of rows) if (row.work) {
    const work = row.work
    if (!isAbsolute(work.projectPath)) throw new Error('WORK_ARCHIVE_PROJECT_INVALID')
    for (const item of [...work.evidence ?? [], ...work.checkpoints ?? []]) {
      const identity = item.identity
      if (identity.owner.userId !== owner.userId || identity.owner.characterId !== owner.characterId || identity.projectId !== work.identity.projectId || identity.workId !== work.identity.workId) throw new Error('WORK_ARCHIVE_SCOPE_MISMATCH')
    }
    for (const evidence of work.evidence ?? []) if (evidence.relativePath && (isAbsolute(evidence.relativePath) || evidence.relativePath.split(/[\\/]/).some(part => part === '..'))) throw new Error('WORK_ARCHIVE_PATH_INVALID')
    const evidenceIds = new Set(work.evidence?.map(item => item.id) ?? [])
    if (work.checkpoints?.some(checkpoint => checkpoint.evidenceIds.some(id => !evidenceIds.has(id)))) throw new Error('WORK_ARCHIVE_EVIDENCE_MISSING')
    const checkpointIds = new Set(work.checkpoints?.map(item => item.id) ?? [])
    if (work.status === 'completed' && (!work.checkpointId || !checkpointIds.has(work.checkpointId))
      || [...work.deliveries ?? [], ...work.delivery ? [work.delivery] : []].some(item => !checkpointIds.has(item.checkpointId) || item.eventId !== `checkpoint:${item.checkpointId}`)) throw new Error('WORK_ARCHIVE_CHECKPOINT_MISSING')
    latest.set(work.identity.workId, work)
  }
  if (rows.some(row => row.receiptWorkId && !latest.has(row.receiptWorkId))) throw new Error('WORK_ARCHIVE_RECEIPT_MISSING')
  return { owner, works: [...latest.values()], rows }
}

/** Original bytes remain in the archive/history directory. This new owning log
 * starts a fresh generation and subscription; no approval, DSH session or
 * uncertain worker input can run merely because an archive was restored. */
export function restoreWorkArchive(options: { path: string; bytes: Uint8Array; from: ContinuityOwner; owner: ContinuityOwner; clock: Clock; restoreId: string }) {
  const snapshot = inspectWorkArchive(options.bytes, options.from)
  const journal = openWorkJournal(options.path, options.owner, options.clock)
  for (const original of snapshot.works) {
    const work = structuredClone(original)
    if (work.status === 'running' || work.status === 'stopping') recordWorkInterruption(work, 'restarted', options.clock.nowMs())
    work.identity = { ...work.identity, owner: options.owner, generation: work.identity.generation + 1 }
    work.revision++; work.subscriptionId = randomUUID(); work.runStartedAt = options.clock.nowMs(); work.updatedAt = options.clock.nowMs()
    for (const input of work.inputs) if (input.state === 'pending' || input.state === 'accepted') input.state = 'unknown'
    work.consumedThrough = work.inputs.at(-1)?.sequence ?? 0
    if (work.status !== 'completed' && work.status !== 'stopped') { work.status = 'review_required'; work.waitingFor = 'recovery' }
    journal.append({ kind: 'archive-restored', operationId: `restore:${options.restoreId}:${work.identity.workId}`, digest: workDigest({ restoreId: options.restoreId, original: original.identity }), work: workRecordSchema.parse(work) })
  }
  // A restored create-event can be delivered again by a caller whose receipt
  // was lost. Keep its command digest and task identity without importing an
  // executable old generation or rewriting the original journal bytes.
  const receipts = new Map<string, { digest: string; workId: string | null }>()
  for (const row of snapshot.rows) if (row.kind !== 'owner') {
    const receipt = { digest: row.digest, workId: row.work?.identity.workId ?? row.receiptWorkId ?? null }
    const previous = receipts.get(row.operationId)
    if (previous && (previous.digest !== receipt.digest || previous.workId !== receipt.workId)) throw new Error('WORK_ARCHIVE_RECEIPT_CONFLICT')
    receipts.set(row.operationId, receipt)
  }
  for (const [operationId, receipt] of receipts) journal.append({ kind: 'archive-receipt', operationId, digest: receipt.digest, receiptWorkId: receipt.workId, work: null })
  return snapshot.works.length
}
