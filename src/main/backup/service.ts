import { randomUUID } from 'node:crypto'
import { existsSync, fsyncSync, closeSync, openSync, renameSync, writeFileSync, lstatSync, realpathSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import type { AppCommand, BackupView, PublicErrorCode } from '../../shared'
import type { Clock } from '../clock'
import type { SessionStore } from '../store/session'
import { BackupFailure, type SaveManifest } from './schema'
import { directory } from './paths'
import { exportPrivateSave, readArchiveFile, stagePrivateSave } from './archive'
import { dismissRestoreReceipt, queueRestore, readRestoreReceipt } from './restore'

function writeArchive(file: string, bytes: Buffer) {
  const path = resolve(file); const parent = dirname(path)
  if (realpathSync(parent) !== parent || existsSync(path) && (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink() || lstatSync(path).nlink !== 1)) throw new BackupFailure('export-failed')
  const temporary = join(parent, '.' + randomUUID() + '.lca-save.tmp'); const fd = openSync(temporary, 'wx', 0o600)
  try { writeFileSync(fd, bytes); fsyncSync(fd) } finally { closeSync(fd) }
  renameSync(temporary, path)
}
export function createBackupService(options: { root: string; store: SessionStore; clock: Clock; source: 'real' | 'fake'; fileFilteringEnabled(): boolean; credentials?: readonly string[];
  canStart(): boolean; freeze(): Promise<() => void>; chooseExport(name: string): Promise<string | null>; chooseImport(): Promise<string | null>; restart(): void; changed(): void }) {
  const receipt = readRestoreReceipt(options.root)
  let view: BackupView = existsSync(join(options.root, '.restore-error.json')) ? { status: 'failed', error: { code: 'restore-failed', retryable: true } } : receipt ? { status: receipt.status, operationId: receipt.restoreId, archiveId: receipt.manifest.archiveId, safetyBackupId: receipt.safetyBackupId,
    incoming: { ...receipt.manifest.counts, savedAtMs: receipt.manifest.savedAtMs, source: receipt.manifest.source }, ...(receipt.status === 'failed' ? { error: { code: 'restore-failed', retryable: true } } : {}) } : { status: 'idle' }
  let worker: Promise<void> | undefined; let disposed = false; let staged: { restoreId: string; manifest: SaveManifest } | undefined; let restarting = false
  const run = (status: BackupView['status'], work: () => Promise<void>) => {
    view = { status, operationId: randomUUID() }; options.changed()
    worker = work().catch((cause: unknown) => { view = { ...view, status: 'failed', error: { code: cause instanceof BackupFailure ? cause.code : 'internal', retryable: true } } }).finally(() => { worker = undefined; options.changed() })
  }
  const exportNow = () => exportPrivateSave({ ...options, fileFilteringEnabled: options.fileFilteringEnabled() })
  return {
    view: () => structuredClone(view), isBusy: () => !!worker || restarting,
    dispatch: (command: AppCommand): PublicErrorCode | undefined => {
      if (disposed || worker || restarting) return 'unavailable'
      if (command.type === 'backup.cancel') { staged = undefined; dismissRestoreReceipt(options.root); view = { status: 'idle' }; options.changed(); return }
      if (!options.canStart()) return 'unavailable'
      if (command.type === 'backup.export') {
        run('exporting', async () => {
          const file = await options.chooseExport('Love-College-Agent-' + randomUUID().slice(0, 8) + '.lca-save')
          if (!file || disposed) { view = { status: 'idle' }; return }
          const release = await options.freeze()
          try { const result = await exportNow(); writeArchive(file, result.bytes); view = { status: 'exported', operationId: view.operationId, archiveId: result.manifest.archiveId, exportedAtMs: result.manifest.savedAtMs } }
          finally { release() }
        }); return
      }
      if (command.type === 'backup.import') {
        staged = undefined
        run('validating', async () => {
          const file = await options.chooseImport(); if (!file || disposed) { view = { status: 'idle' }; return }
          const result = await stagePrivateSave(options.root, readArchiveFile(file), options.store.scope, options.source)
          staged = result; view = { status: 'awaiting-confirmation', operationId: view.operationId, restoreId: result.restoreId,
            incoming: { ...result.manifest.counts, savedAtMs: result.manifest.savedAtMs, source: result.manifest.source } }
        }); return
      }
      if (command.type === 'backup.restore') {
        if (!staged || command.restoreId !== staged.restoreId || view.status !== 'awaiting-confirmation') return 'invalid-command'
        const candidate = staged
        run('restoring', async () => {
          const release = await options.freeze()
          try {
            const safety = await exportNow(); const folder = directory(options.root, join(options.root, 'backups'))
            writeArchive(join(folder, 'pre-restore-' + safety.manifest.archiveId + '.lca-save'), safety.bytes)
            queueRestore(options.root, candidate.restoreId, safety.manifest.archiveId)
            view = { status: 'restoring', operationId: view.operationId, restoreId: candidate.restoreId, safetyBackupId: safety.manifest.archiveId }; restarting = true; options.changed(); options.restart()
          } finally { if (!restarting) release() }
        }); return
      }
      return 'invalid-command'
    },
    idle: async () => { await worker }, close: async () => { disposed = true; await worker },
  }
}
export type BackupService = ReturnType<typeof createBackupService>
