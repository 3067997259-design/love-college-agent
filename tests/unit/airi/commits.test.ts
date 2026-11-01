import { appendFileSync, mkdtempSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createManualClock } from '../../../src/main/clock'
import { createNativeMemoryDatabase } from '../../../src/main/memory/storage/neo'
import { createMemoryDatabaseClient } from '../../../src/main/memory/storage/client'
import { createMemoryCommitCoordinator, type MemoryCommitPoint } from '../../../src/main/memory/storage/commits'
import { proposeMemoryOperation, reviewMemoryOperation } from '../../../src/main/memory/airi/repository/interactions'

const scope = { userId: 'commit-owner', characterId: 'taozi' }
const clock = createManualClock(1_790_000_000_000)
const input = { scope, sessionId: 'day-1', memoryType: 'long_term' as const, content: 'Tea is preferred.', category: 'chat', importance: 5, valence: 0, arousal: 0, tags: [], reviewStatus: 'approved' as const }
const create = async (root: string, interrupt?: (point: MemoryCommitPoint, id: string) => void) => {
  const database = createMemoryDatabaseClient(createNativeMemoryDatabase(), clock)
  await database.open(join(root, 'facts.duckdb'))
  const commits = await createMemoryCommitCoordinator({ database, clock, scope, logPath: join(root, 'operations.log'), interrupt })
  return { database, commits }
}

describe('durable memory commit and publication', () => {
  it('refuses a published log whose database receipt is missing instead of replaying it', async () => {
    const root = mkdtempSync(join(resolve(process.env.LCA_TEST_ARTIFACTS_DIR ?? 'test-results'), 'memory-log-conflict-')); const host = await create(root)
    try {
      await host.commits.commit({ operationId: 'published-one', kind: 'remember', input }, tx => tx.insert(input))
      await host.database.execute("DELETE FROM lca_memory_commits WHERE operation_id = 'published-one'")
      await expect(host.commits.recover()).rejects.toThrow('MEMORY_COMMIT_LOG_CONFLICT')
      expect(await host.commits.repository.list()).toHaveLength(1)
    } finally { await host.database.close() }
  })

  for (const point of ['intent', 'before-commit', 'committed', 'published'] as const) {
    it(`reconciles a stop at ${point} without duplicating facts or mirror work`, async () => {
      const root = mkdtempSync(join(resolve(process.env.LCA_TEST_ARTIFACTS_DIR ?? 'test-results'), `memory-commit-${point}-`))
      let host = await create(root, at => { if (at === point) throw new Error('INTERRUPTED') })
      const identity = { operationId: 'remember-original-1', kind: 'remember', input }
      try {
        await expect(host.commits.commit(identity, tx => tx.insert(input))).rejects.toThrow('INTERRUPTED')
        await host.database.close()
        host = await create(root)
        const applied = point === 'committed' || point === 'published'
        expect((await host.commits.repository.list()).length).toBe(applied ? 1 : 0)
        expect((await host.commits.receipt(identity.operationId)).state).toBe(applied ? 'published' : 'not-applied')
        let writes = 0
        const fact = await host.commits.commit(identity, tx => { writes++; return tx.insert(input) })
        const replay = await host.commits.commit<typeof fact>(identity, () => { throw new Error('MUST_NOT_REPLAY') })
        expect(replay.id).toBe(fact.id)
        expect(writes).toBe(applied ? 0 : 1)
        expect(await host.commits.repository.list()).toHaveLength(1)
        expect(await host.commits.mirrorChanges()).toHaveLength(1)
        await expect(host.commits.commit({ ...identity, input: { ...input, content: 'different' } }, tx => tx.insert(input))).rejects.toThrow('MEMORY_COMMIT_ID_CONFLICT')
        const log = readFileSync(join(root, 'operations.log'), 'utf8')
        expect(log).not.toContain(input.content)
        expect(log.match(/"phase":"published"/g)).toHaveLength(1)
      } finally { await host.database.close() }
    })
  }

  it('commits explicit facts and operation receipts together; newer dirty revisions survive old acknowledgements', async () => {
    const root = mkdtempSync(join(resolve(process.env.LCA_TEST_ARTIFACTS_DIR ?? 'test-results'), 'memory-commit-review-'))
    const host = await create(root)
    try {
      const context = { scope, sessionId: 'day-1', turnId: 'turn-1', sourceContext: { sessionId: 'day-1', messageId: 'user-1', neighbors: [] }, isCurrent: () => true }
      const operation = await host.commits.commit({ operationId: 'propose:user-1', kind: 'propose', input: 'tea' }, tx => proposeMemoryOperation(tx, context, 'user-1', { kind: 'remember', content: 'Tea' }, clock))
      await host.commits.commit({ operationId: 'review:user-1', kind: 'review', input: true }, tx => reviewMemoryOperation(tx, scope, 'user-1', true, () => true, clock))
      await host.commits.repository.update(operation.fragmentId!, { memoryType: 'long_term' })
      const old = (await host.commits.mirrorChanges())[0]!
      await host.commits.repository.update(operation.fragmentId!, { content: 'Coffee' })
      await host.commits.acknowledgeMirrorChange(old)
      const newer = (await host.commits.mirrorChanges())[0]!
      expect(newer.fragment?.content).toBe('Coffee')
      expect(newer.version).not.toBe(old.version)
      await host.commits.repository.remove(operation.fragmentId!)
      expect((await host.commits.mirrorChanges())[0]?.deleted).toBe(true)
      expect((await host.commits.repository.operation('user-1'))?.status).toBe('applied')
    } finally { await host.database.close() }
  })

  it('preserves a crash-torn log frame and resumes on a new frame boundary', async () => {
    const root = mkdtempSync(join(resolve(process.env.LCA_TEST_ARTIFACTS_DIR ?? 'test-results'), 'memory-commit-torn-'))
    let host = await create(root)
    await host.database.close()
    appendFileSync(join(root, 'operations.log'), '\x1e{"event":{"operationId":"partial')
    host = await create(root)
    try {
      await host.commits.repository.insert(input)
      expect(readFileSync(join(root, 'operations.log'), 'utf8')).toContain('"partial\x1e')
      await host.database.close()
      host = await create(root)
      expect(await host.commits.repository.list()).toHaveLength(1)
    } finally { await host.database.close() }
  })
})
