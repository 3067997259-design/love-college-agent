import { existsSync, lstatSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import type { Clock } from '../clock'
import { BackupFailure, DATABASES, manifestSchema, type SaveManifest } from './schema'
import { checkDatabase, mergeOtherOwners, sha256 } from './archive'
import { directory, inside, regular } from './paths'

const pendingSchema = z.strictObject({ restoreId: z.string().uuid(), manifestHash: z.string().regex(/^[a-f0-9]{64}$/), safetyBackupId: z.string().uuid() })
const transactionSchema = z.strictObject({ phase: z.enum(['applying', 'committed', 'rolled-back']), targets: z.array(z.string().max(240)).max(2100), previous: z.array(z.string().max(240)).max(2100) })
export interface RestoreReceipt { status: 'restored' | 'failed'; restoreId: string; safetyBackupId: string; restoredAtMs: number; manifest: SaveManifest }
const receiptSchema = z.strictObject({ status: z.enum(['restored', 'failed']), restoreId: z.string().uuid(), safetyBackupId: z.string().uuid(), restoredAtMs: z.number().int().nonnegative(), manifest: manifestSchema })
const writeJson = (path: string, value: unknown) => { writeFileSync(path + '.tmp', JSON.stringify(value), { mode: 0o600 }); renameSync(path + '.tmp', path) }
export function queueRestore(root: string, restoreId: string, safetyBackupId: string) {
  const stage = join(root, '.backup-staging', z.string().uuid().parse(restoreId))
  const bytes = readFileSync(regular(root, join(stage, 'manifest.json'), 1024 * 1024))
  writeJson(join(root, '.restore-pending.json'), { restoreId, safetyBackupId, manifestHash: sha256(bytes) })
}
export function readRestoreReceipt(root: string): RestoreReceipt | null {
  const path = join(root, '.restore-receipt.json'); if (!existsSync(path)) return null
  try { return receiptSchema.parse(JSON.parse(readFileSync(regular(root, path, 1024 * 1024), 'utf8'))) } catch { return null }
}
export function dismissRestoreReceipt(root: string) { for (const name of ['.restore-receipt.json', '.restore-error.json']) { const path = join(root, name); if (existsSync(path)) { regular(root, path, 1024 * 1024); unlinkSync(path) } } }
/** Runs before opening any application SQLite connection. Every replacement is reversible. */
function applyPendingRestoreUnchecked(root: string, owner: SaveManifest['owner'], source: SaveManifest['source'], clock: Clock): RestoreReceipt | null {
  const pendingPath = join(root, '.restore-pending.json'); if (!existsSync(pendingPath)) return null
  const pending = pendingSchema.parse(JSON.parse(readFileSync(regular(root, pendingPath, 2048), 'utf8')))
  const stage = directory(root, join(root, '.backup-staging', pending.restoreId)); const payload = join(stage, 'payload'); const rollback = directory(root, join(stage, 'rollback')); const failed = directory(root, join(stage, 'failed'))
  const bytes = readFileSync(regular(root, join(stage, 'manifest.json'), 1024 * 1024)); if (sha256(bytes) !== pending.manifestHash) throw new BackupFailure('backup-invalid')
  const manifest = manifestSchema.parse(JSON.parse(bytes.toString('utf8')))
  if (manifest.owner.userId !== owner.userId || manifest.owner.characterId !== owner.characterId || manifest.source !== source) throw new BackupFailure('backup-scope-mismatch')
  const key = sha256(JSON.stringify([owner.userId, owner.characterId]))
  const targets = ['journals/' + key, ...DATABASES, ...DATABASES.flatMap((name) => [name + '-wal', name + '-shm']), ...manifest.files.filter((file) => file.path.startsWith('artifacts/')).map((file) => file.path)]
  const ledgerPath = join(stage, 'transaction.json')
  let transaction: z.infer<typeof transactionSchema> | undefined
  if (existsSync(ledgerPath)) { transaction = transactionSchema.parse(JSON.parse(readFileSync(regular(root, ledgerPath, 1024 * 1024), 'utf8'))); if (JSON.stringify(transaction.targets) !== JSON.stringify(targets)) throw new BackupFailure('backup-invalid') }
  const move = (from: string, to: string) => { inside(root, from); inside(root, to); directory(root, dirname(to)); renameSync(from, to) }
  const recover = () => {
    if (!transaction) return
    for (const name of transaction.targets.slice().reverse()) {
      const current = join(root, name); const old = join(rollback, name)
      if (existsSync(old)) { if (existsSync(current)) move(current, join(failed, name)); move(old, current) }
      else if (!transaction.previous.includes(name) && existsSync(current) && !existsSync(join(payload, name))) move(current, join(failed, name))
    }
    transaction.phase = 'rolled-back'; writeJson(ledgerPath, transaction)
  }
  let success = transaction?.phase === 'committed'
  try {
    if (transaction?.phase === 'applying') { recover(); throw new BackupFailure('restore-failed') }
    if (transaction?.phase === 'rolled-back') throw new BackupFailure('restore-failed')
    if (!success) {
      for (const file of manifest.files) {
        const data = readFileSync(regular(root, join(payload, file.path), file.bytes))
        if (data.length !== file.bytes || sha256(data) !== file.sha256) throw new BackupFailure('backup-invalid')
      }
      for (const name of DATABASES) if (existsSync(join(payload, name))) {
        checkDatabase(join(payload, name), name, owner)
        if (existsSync(join(root, name))) mergeOtherOwners(join(payload, name), regular(root, join(root, name), 128 * 1024 * 1024), name, owner)
      }
      const previous = targets.filter((name) => existsSync(join(root, name)))
      for (const name of previous) if (lstatSync(join(root, name)).isSymbolicLink()) throw new BackupFailure('backup-invalid')
      transaction = { phase: 'applying', targets, previous }; writeJson(ledgerPath, transaction)
      for (const name of previous) move(join(root, name), join(rollback, name))
      for (const name of targets) if (existsSync(join(payload, name))) move(join(payload, name), join(root, name))
      transaction.phase = 'committed'; writeJson(ledgerPath, transaction); success = true
    }
  } catch { if (transaction?.phase === 'applying') recover() }
  const receipt: RestoreReceipt = { status: success ? 'restored' : 'failed', restoreId: pending.restoreId, safetyBackupId: pending.safetyBackupId, restoredAtMs: clock.nowMs(), manifest }
  writeJson(join(root, '.restore-receipt.json'), receipt); regular(root, pendingPath, 2048); unlinkSync(pendingPath)
  return receipt
}
export function applyPendingRestore(root: string, owner: SaveManifest['owner'], source: SaveManifest['source'], clock: Clock): RestoreReceipt | null {
  try { return applyPendingRestoreUnchecked(root, owner, source, clock) }
  catch {
    // If rollback itself was interrupted, keep the pending transaction for a safe retry. Never open a mixed data set.
    const activePending = join(root, '.restore-pending.json')
    if (existsSync(activePending)) {
      const parsed = pendingSchema.safeParse(JSON.parse(readFileSync(regular(root, activePending, 2048), 'utf8')))
      if (parsed.success) {
        const ledger = join(root, '.backup-staging', parsed.data.restoreId, 'transaction.json')
        if (existsSync(ledger) && transactionSchema.parse(JSON.parse(readFileSync(regular(root, ledger, 1024 * 1024), 'utf8'))).phase === 'applying') throw new BackupFailure('restore-failed')
      }
    }
    // A rejected pending plan must not trap the application in a restart loop. Preserve data and the rejected material.
    const pendingPath = join(root, '.restore-pending.json')
    if (existsSync(pendingPath)) {
      const rejected = directory(root, join(root, '.backup-staging', 'rejected'))
      regular(root, pendingPath, 2048); renameSync(pendingPath, join(rejected, 'pending-' + clock.nowMs() + '.json'))
    }
    writeJson(join(root, '.restore-error.json'), { code: 'restore-failed' }); return null
  }
}
