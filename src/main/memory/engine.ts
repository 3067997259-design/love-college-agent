import { join, resolve } from 'node:path'
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs'
import type { Clock } from '../clock'
import type { ContinuityOwner } from '../../shared/continuity'
import { createAiriMemoryRuntime, type MemoryDreamAgent, type MemoryHostPort } from './airi/runtime'
import { createMemoryEmbeddingRuntime, type MemoryEmbeddingSource } from './airi/embedding'
import { createMemoryRuntimeState } from './storage/state'
import type { MemoryDatabaseClient } from './storage/client'
import { createMemoryCommitCoordinator, type MemoryCommitCoordinator } from './storage/commits'
import { migrateLegacyMemory } from './migration'
import type { JournalRecord } from '../journal/schema'
import { createMemorySnapshots, type MemorySnapshotEntry } from './storage/snapshots'
import { validateMemoryState } from './storage/state-schema'

/** One main-owned engine per profile/character. Runtime, receipts and mirror
 * recovery share the same file-backed owner; production has no unjournaled seam. */
export function createMemoryEngine(options: {
  root: string; owner: ContinuityOwner; clock: Clock
  embedding(): MemoryEmbeddingSource | undefined
  mirror?: MemoryHostPort; dreamAgent?: MemoryDreamAgent
  held(): boolean; waitForRestore(): Promise<void>
  journal(sessionId: string, event: Record<string, unknown>): void
  openDatabase?(path: string): Promise<MemoryDatabaseClient>
  interrupt?: Parameters<typeof createMemoryCommitCoordinator>[0]['interrupt']
}) {
  let alive = true
  let commits: MemoryCommitCoordinator | undefined
  let databaseClient: MemoryDatabaseClient | undefined
  const scope = { userId: options.owner.userId, characterId: options.owner.characterId }
  const runtime = createAiriMemoryRuntime({
    clock: options.clock, scope: () => scope, isOwner: () => alive, effectsHeld: options.held,
    waitForRestore: options.waitForRestore, state: createMemoryRuntimeState(join(options.root, 'runtime.json')),
    embedding: createMemoryEmbeddingRuntime(options.clock, options.embedding), mirror: options.mirror, dreamAgent: options.dreamAgent, journal: options.journal,
    openDatabase: async () => {
      const path = join(options.root, 'memory.duckdb')
      const database = options.openDatabase ? await options.openDatabase(path)
        : await (await import('./storage/host')).openUtilityMemoryDatabase({ path, clock: options.clock })
      try {
        commits = await createMemoryCommitCoordinator({ database, clock: options.clock, scope, logPath: join(options.root, 'operations.log'), interrupt: options.interrupt })
        databaseClient = database
        return database
      } catch (error) { await database.close(); throw error }
    },
    repository: () => { if (!commits) throw new Error('MEMORY_COMMITS_UNAVAILABLE'); return commits.repository },
    commits: () => { if (!commits) throw new Error('MEMORY_COMMITS_UNAVAILABLE'); return commits },
  })
  return {
    runtime,
    async migrateLegacy(records: readonly JournalRecord[]) {
      await runtime.initialize(); if (!commits) throw new Error('MEMORY_COMMITS_UNAVAILABLE')
      return migrateLegacyMemory({ records, scope, commits, halfLife: { shortTerm: runtime.shortTermHalfLifeHours.value, longTerm: runtime.longTermHalfLifeHours.value } })
    },
    async reconcile() { await runtime.initialize(); if (!commits) throw new Error('MEMORY_COMMITS_UNAVAILABLE'); return commits.recover() },
    async archive(credentials: readonly string[] = []) {
      if (!alive || !options.held()) throw new Error('MEMORY_ARCHIVE_FREEZE_REQUIRED')
      await runtime.idle(); await runtime.initialize()
      if (!commits || !databaseClient) throw new Error('MEMORY_COMMITS_UNAVAILABLE')
      await commits.recover(); await commits.idle(); await databaseClient.checkpoint()
      const entries: MemorySnapshotEntry[] = await createMemorySnapshots(databaseClient, join(options.root, '.snapshot-staging'), true, scope, credentials).exportSnapshot()
      for (const name of ['runtime.json', 'capture.json', 'operations.log'] as const) {
        const path = join(options.root, name)
        if (existsSync(path)) {
          const stat = lstatSync(path)
          if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 128 * 1024 * 1024 || realpathSync(path) !== resolve(path)) throw new Error('MEMORY_ARCHIVE_FILE_INVALID')
        }
        const data = existsSync(path) ? readFileSync(path) : Buffer.from(name === 'operations.log' ? '' : '{}')
        if (name !== 'operations.log') validateMemoryState(data, name === 'runtime.json' ? 'runtime' : 'capture', scope)
        entries.push({ path: `memory/${name}`, domain: 'memory', data })
      }
      const rows = await databaseClient.execute('SELECT count(*) AS count FROM memory_fragments WHERE deleted_at IS NULL') as { count: bigint }[]
      if (!options.held()) throw new Error('MEMORY_ARCHIVE_FREEZE_REQUIRED')
      return { entries, count: Number(rows[0]?.count ?? 0) }
    },
    async dispose() { alive = false; await commits?.idle(); await runtime.dispose() },
  }
}
