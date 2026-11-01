import { createHash } from 'node:crypto'
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { z } from 'zod'
import type { ContinuityOwner } from '../../shared/continuity'
import type { Clock } from '../clock'

export const workOwnerSchema = z.strictObject({ userId: z.string().min(1).max(128), characterId: z.string().min(1).max(128), dataRootId: z.string().min(1).max(128) })
export const workIdentitySchema = z.strictObject({ owner: workOwnerSchema, projectId: z.string().min(1).max(128), workId: z.string().uuid(), generation: z.number().int().positive(), objectiveRevision: z.number().int().positive() })
export const workTargetSchema = z.strictObject({ identity: workIdentitySchema, expectedRevision: z.number().int().nonnegative() })
export const workDecisionSchema = z.strictObject({ id: z.string().min(1).max(128), text: z.string().min(1).max(20_000), atMs: z.number().int().nonnegative() })
const inputSchema = z.strictObject({ eventId: z.string().min(1).max(128), subscriptionId: z.string().uuid(), sequence: z.number().int().positive(), generation: z.number().int().positive(),
  revision: z.number().int().positive(), kind: z.enum(['start', 'supplement', 'resume']), state: z.enum(['pending', 'accepted', 'consumed', 'cancelled', 'unknown']), consumedAt: z.number().nullable(), decisionIds: z.array(z.string().max(128)).max(64) })
export const workEvidenceSchema = z.strictObject({ id: z.string().min(1).max(128), identity: workIdentitySchema, rootSessionId: z.string().min(1).max(160), callId: z.string().min(1).max(160),
  kind: z.enum(['artifact', 'command', 'tool']), status: z.enum(['passed', 'failed', 'unverified']), relativePath: z.string().max(4096).nullable(),
  beforeHash: z.string().regex(/^[a-f0-9]{64}$/).nullable(), afterHash: z.string().regex(/^[a-f0-9]{64}$/).nullable(), bytes: z.number().int().nonnegative().nullable(),
  exitCode: z.number().int().nullable(), restricted: z.boolean(), observedAt: z.number().int().nonnegative() })
export const checkpointProposalSchema = z.strictObject({ expectedObjectiveRevision: z.number().int().positive(), evidenceIds: z.array(z.string().min(1).max(128)).min(1).max(32),
  outcome: z.enum(['completed', 'partial']), explanation: z.string().max(4000), unresolved: z.array(z.string().min(1).max(1000)).max(16), nextStep: z.string().max(1000).nullable() })
export type CheckpointProposal = z.infer<typeof checkpointProposalSchema>
const checkpointSchema = z.strictObject({ id: z.string().min(1).max(128), identity: workIdentitySchema, objective: z.string().max(20_000), decisionIds: z.array(z.string().max(128)).max(64),
  evidenceIds: z.array(z.string().max(128)).max(32), outcome: z.enum(['completed', 'partial']), explanation: z.string().max(4000), unresolved: z.array(z.string().max(1000)).max(16), nextStep: z.string().max(1000).nullable(), createdAt: z.number().int().nonnegative() })
const deliverySchema = z.strictObject({ eventId: z.string().max(128), checkpointId: z.string().max(128), state: z.enum(['pending', 'accepted', 'consumed', 'unknown']) })
export const workRecordSchema = z.strictObject({ identity: workIdentitySchema, revision: z.number().int().positive(), label: z.string().max(120),
  status: z.enum(['queued', 'running', 'waiting', 'paused', 'stopping', 'stopped', 'review_required', 'completed', 'failed']),
  waitingFor: z.enum(['approval', 'user', 'budget', 'project', 'recovery']).nullable(), projectPath: z.string().min(1).max(4096),
  objective: z.string().min(1).max(20_000), acceptance: z.array(z.string().max(2000)).max(16), decisions: z.array(workDecisionSchema).max(64),
  createdAt: z.number().int().nonnegative(), updatedAt: z.number().int().nonnegative(), runStartedAt: z.number().int().nonnegative(),
  checkpointId: z.string().max(128).nullable(), subscriptionId: z.string().uuid(), consumedThrough: z.number().int().nonnegative(), inputs: z.array(inputSchema).max(256),
  evidence: z.array(workEvidenceSchema).max(512).optional(), checkpoints: z.array(checkpointSchema).max(128).optional(), observedInputs: z.array(z.string().max(128)).max(256).optional(),
  delivery: deliverySchema.optional(), deliveries: z.array(deliverySchema).max(128).optional() })
export type WorkRecord = z.infer<typeof workRecordSchema>
export type WorkDecision = z.infer<typeof workDecisionSchema>
export type WorkInput = WorkRecord['inputs'][number]
const rowSchema = z.strictObject({ version: z.literal(1), seq: z.number().int().positive(), operationId: z.string().min(1).max(160), digest: z.string().length(64),
  owner: workOwnerSchema, atMs: z.number().int().nonnegative(), kind: z.string().min(1).max(64), work: workRecordSchema.nullable() })
type Row = z.infer<typeof rowSchema>
export const workDigest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
export const sameOwner = (a: ContinuityOwner, b: ContinuityOwner) => a.userId === b.userId && a.characterId === b.characterId && a.dataRootId === b.dataRootId

/** Each frame is a complete state transition, including its subscription receipt.
 * Fsync precedes publication. A torn final frame stays in the file; only that
 * incomplete final frame may be ignored. No projection file can override this log. */
export function openWorkJournal(path: string, owner: ContinuityOwner, clock: Clock) {
  const rows: Row[] = []
  if (existsSync(path)) {
    const frames = readFileSync(path, 'utf8').split('\x1e')
    if (frames[0] !== '') throw new Error('WORK_JOURNAL_CORRUPT')
    for (let index = 1; index < frames.length; index++) {
      const frame = frames[index]
      if (!frame.endsWith('\n')) {
        // A previous torn tail can precede a fresh frame after recovery. It must
        // not be a valid complete JSON record with a missing newline.
        try { JSON.parse(frame); throw new Error('WORK_JOURNAL_INCOMPLETE_COMMIT') } catch (error) { if (error instanceof SyntaxError) continue; throw error }
      }
      const parsed = z.strictObject({ row: rowSchema, checksum: z.string().length(64) }).parse(JSON.parse(frame))
      const row = parsed.row
      if (workDigest(row) !== parsed.checksum || row.seq !== rows.length + 1 || !sameOwner(row.owner, owner) || row.work && !sameOwner(row.work.identity.owner, owner)) throw new Error('WORK_JOURNAL_CORRUPT')
      rows.push(row)
    }
  }
  let poisoned = false
  const append = (input: Omit<Row, 'version' | 'seq' | 'owner' | 'atMs'>) => {
    if (poisoned) throw new Error('WORK_JOURNAL_NOT_WRITABLE')
    const row = rowSchema.parse({ ...input, version: 1, seq: rows.length + 1, owner, atMs: clock.nowMs() })
    if (row.work && !sameOwner(row.work.identity.owner, owner)) throw new Error('WORK_OWNER_MISMATCH')
    const frame = `\x1e${JSON.stringify({ row, checksum: workDigest(row) })}\n`
    if (Buffer.byteLength(frame) > 2 * 1024 * 1024) throw new Error('WORK_EVENT_TOO_LARGE')
    mkdirSync(dirname(path), { recursive: true })
    const fd = openSync(path, 'a', 0o600)
    try { writeFileSync(fd, frame); fsyncSync(fd) } catch { poisoned = true; throw new Error('WORK_JOURNAL_WRITE_FAILED') } finally { closeSync(fd) }
    rows.push(row)
    return structuredClone(row)
  }
  if (!rows.length) append({ kind: 'owner', operationId: 'owner', digest: workDigest(owner), work: null })
  return { rows: () => structuredClone(rows), append }
}
