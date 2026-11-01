import { join } from 'node:path'
import type { Clock } from '../clock'
import type { ContinuityOwner } from '../../shared/continuity'
import { createAiriMemoryRuntime, type MemoryDreamAgent, type MemoryHostPort } from './airi/runtime'
import { createMemoryEmbeddingRuntime, type MemoryEmbeddingSource } from './airi/embedding'
import { createMemoryRuntimeState } from './storage/state'
import type { MemoryDatabaseClient } from './storage/client'
import { createMemoryCommitCoordinator, type MemoryCommitCoordinator } from './storage/commits'

/** One main-owned engine per profile/character. Runtime, receipts and mirror
 * recovery share the same file-backed owner; production has no unjournaled seam. */
export function createMemoryEngine(options: {
  root: string; owner: ContinuityOwner; clock: Clock
  embedding(): MemoryEmbeddingSource | undefined
  mirror?: MemoryHostPort; dreamAgent?: MemoryDreamAgent
  held(): boolean; waitForRestore(): Promise<void>
  journal(sessionId: string, event: Record<string, unknown>): void
  openDatabase?(path: string): Promise<MemoryDatabaseClient>
}) {
  let alive = true
  let commits: MemoryCommitCoordinator | undefined
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
        commits = await createMemoryCommitCoordinator({ database, clock: options.clock, scope, logPath: join(options.root, 'operations.log') })
        return database
      } catch (error) { await database.close(); throw error }
    },
    repository: () => { if (!commits) throw new Error('MEMORY_COMMITS_UNAVAILABLE'); return commits.repository },
    commits: () => { if (!commits) throw new Error('MEMORY_COMMITS_UNAVAILABLE'); return commits },
  })
  return {
    runtime,
    async reconcile() { await runtime.initialize(); if (!commits) throw new Error('MEMORY_COMMITS_UNAVAILABLE'); return commits.recover() },
    async dispose() { alive = false; await commits?.idle(); await runtime.dispose() },
  }
}
