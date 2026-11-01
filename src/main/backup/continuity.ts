import { createHash, randomUUID } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { ContinuityOwner } from '../../shared/continuity'
import type { Clock } from '../clock'
import { continuityIdentityName, ensureContinuityIdentity, restoredContinuityIdentity } from '../continuity/identity'
import type { MemoryDatabaseClient } from '../memory/storage/client'
import { createMemoryCommitCoordinator, initializeMemoryCommitSchema } from '../memory/storage/commits'
import { createMemorySnapshots, type MemorySnapshotEntry } from '../memory/storage/snapshots'
import { validateMemoryState } from '../memory/storage/state-schema'
import { inspectWorkArchive, restoreWorkArchive } from '../work/archive'
import { BackupFailure, type SaveManifest } from './schema'
import { directory, privateWriteParent, regular } from './paths'

const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex')
const memoryFiles = ['memory_fragments.parquet', 'memory_tags.parquet', 'memory_episodic.parquet', 'memory_long_term_goals.parquet', 'memory_short_term_ideas.parquet', 'memory_operations.parquet', 'lca_memory_commits.parquet', 'lca_memory_mirror_dirty.parquet', 'schema.json', 'runtime.json', 'capture.json', 'operations.log']
const historyPath = /^continuity\/work\/restored-history\/([a-f0-9]{64})\.log$/
export type OpenRestoreDatabase = (path: string) => Promise<MemoryDatabaseClient>
export interface ContinuityArchive { metadata: NonNullable<SaveManifest['continuity']>; files: Map<string, Buffer> }
export const validContinuityPath = (path: string) => memoryFiles.some(name => path === `continuity/memory/${name}`) || path === 'continuity/work/events.log' || historyPath.test(path)
export function continuityTargets(owner: ContinuityOwner) {
  return [`memory/${hash(JSON.stringify({ userId: owner.userId, characterId: owner.characterId }))}`, `continuous-work/${hash(JSON.stringify(owner))}`, continuityIdentityName]
}

/** Called only while the main-owned memory and work services are held. */
export async function exportContinuity(options: { root: string; owner: ContinuityOwner; memory(): Promise<{ entries: MemorySnapshotEntry[]; count: number }> }): Promise<ContinuityArchive> {
  const memory = await options.memory(); const files = new Map<string, Buffer>()
  for (const entry of memory.entries) {
    const path = `continuity/${entry.path}`
    if (entry.domain !== 'memory' || !validContinuityPath(path) || files.has(path)) throw new BackupFailure('export-failed')
    files.set(path, Buffer.from(entry.data))
  }
  const workRoot = join(options.root, continuityTargets(options.owner)[1])
  const work = readFileSync(regular(options.root, join(workRoot, 'events.log'), 128 * 1024 * 1024))
  const inspected = inspectWorkArchive(work, options.owner); files.set('continuity/work/events.log', work)
  const history = join(workRoot, 'restored-history')
  if (existsSync(history)) {
    directory(options.root, history)
    for (const name of readdirSync(history)) {
      if (!/^[a-f0-9]{64}\.log$/.test(name)) throw new BackupFailure('export-failed')
      const bytes = readFileSync(regular(options.root, join(history, name), 128 * 1024 * 1024))
      if (hash(bytes) + '.log' !== name) throw new BackupFailure('export-failed')
      inspectWorkArchive(bytes, { userId: options.owner.userId, characterId: options.owner.characterId })
      files.set('continuity/work/restored-history/' + name, bytes)
    }
  }
  const result = { metadata: { dataRootId: options.owner.dataRootId, memoryCount: memory.count, workCount: inspected.works.length }, files }
  inspectContinuity(result, options.owner)
  return result
}

export function inspectContinuity(archive: ContinuityArchive, owner: SaveManifest['owner']) {
  for (const name of memoryFiles) if (!archive.files.has('continuity/memory/' + name)) throw new BackupFailure('backup-invalid')
  if ([...archive.files.keys()].some(path => !validContinuityPath(path)) || archive.files.get('continuity/memory/schema.json')?.toString('utf8') !== '{"version":3}') throw new BackupFailure('backup-invalid')
  validateMemoryState(archive.files.get('continuity/memory/runtime.json')!, 'runtime', owner)
  validateMemoryState(archive.files.get('continuity/memory/capture.json')!, 'capture', owner)
  const bytes = archive.files.get('continuity/work/events.log'); if (!bytes) throw new BackupFailure('backup-invalid')
  if (inspectWorkArchive(bytes, { ...owner, dataRootId: archive.metadata.dataRootId }).works.length !== archive.metadata.workCount) throw new BackupFailure('backup-invalid')
  for (const [path, bytes] of archive.files) {
    const match = historyPath.exec(path)
    if (match) {
      if (hash(bytes) !== match[1]) throw new BackupFailure('backup-invalid')
      inspectWorkArchive(bytes, owner)
    }
  }
}

/** Build a closed native database and a new owning work log before replacing
 * any live data. A failed or interrupted preparation is kept for inspection. */
export async function prepareContinuityRestore(options: { root: string; stage: string; payload: string; manifest: SaveManifest; clock: Clock; restoreId: string; openDatabase?: OpenRestoreDatabase }) {
  const { root, stage, payload, manifest, clock } = options
  const owner = ensureContinuityIdentity(root, manifest.owner).owner
  const targets = continuityTargets(owner)
  const prepared = directory(root, join(stage, 'prepare-' + randomUUID()))
  if (manifest.formatVersion === 2) {
    const files = new Map(manifest.files.filter(file => file.path.startsWith('continuity/')).map(file => [file.path, readFileSync(regular(root, join(payload, file.path), file.bytes))]))
    const archive = { metadata: manifest.continuity!, files }; inspectContinuity(archive, manifest.owner)
    const memoryRoot = directory(root, join(prepared, targets[0]))
    const database = options.openDatabase ? await options.openDatabase(join(memoryRoot, 'memory.duckdb'))
      : await (await import('../memory/storage/host')).openUtilityMemoryDatabase({ path: join(memoryRoot, 'memory.duckdb'), clock })
    try {
      await initializeMemoryCommitSchema(database)
      const snapshots: MemorySnapshotEntry[] = [...files].filter(([path]) => path.startsWith('continuity/memory/') && (path.endsWith('.parquet') || path.endsWith('/schema.json'))).map(([path, data]) => ({ path: path.slice('continuity/'.length), domain: 'memory', data }))
      await createMemorySnapshots(database, join(prepared, '.snapshot-staging'), true, manifest.owner).importSnapshot(snapshots)
      for (const name of ['runtime.json', 'capture.json', 'operations.log']) writeFileSync(join(memoryRoot, name), files.get('continuity/memory/' + name)!, { flag: 'wx', mode: 0o600 })
      const coordinator = await createMemoryCommitCoordinator({ database, clock, scope: manifest.owner, logPath: join(memoryRoot, 'operations.log') })
      await coordinator.recover(); await coordinator.idle()
      const rows = await database.execute('SELECT count(*) AS count FROM memory_fragments WHERE deleted_at IS NULL') as { count: bigint }[]
      if (Number(rows[0]?.count ?? 0) !== manifest.continuity!.memoryCount) throw new BackupFailure('backup-invalid')
      await database.checkpoint()
    } finally { await database.close() }
    const workRoot = directory(root, join(prepared, targets[1])); const workBytes = files.get('continuity/work/events.log')!
    restoreWorkArchive({ path: join(workRoot, 'events.log'), bytes: workBytes, from: { ...manifest.owner, dataRootId: manifest.continuity!.dataRootId }, owner, clock, restoreId: options.restoreId })
    const history = directory(root, join(workRoot, 'restored-history'))
    const originals = new Map([...files].filter(([path]) => historyPath.test(path)).map(([, bytes]) => [hash(bytes), bytes]))
    originals.set(hash(workBytes), workBytes)
    for (const [digest, bytes] of originals) writeFileSync(join(history, digest + '.log'), bytes, { flag: 'wx', mode: 0o600 })
  }
  // Local credentials are never imported. A fresh remote schema generation
  // prevents a pre-restore remote fact from reappearing in this installation.
  writeFileSync(join(prepared, continuityIdentityName), restoredContinuityIdentity(root, manifest.owner), { flag: 'wx', mode: 0o600 })
  for (const target of targets) {
    if (existsSync(join(payload, target))) {
      const previous = join(stage, 'prepared-history', randomUUID(), target)
      directory(root, dirname(previous)); renameSync(join(payload, target), previous)
    }
    if (existsSync(join(prepared, target))) renameSync(join(prepared, target), privateWriteParent(root, join(payload, target)))
  }
  return targets
}
