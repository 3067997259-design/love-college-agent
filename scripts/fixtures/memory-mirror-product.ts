import assert from 'node:assert/strict'
import { join } from 'node:path'
import { createManualClock } from '../../src/main/clock'
import { ensureContinuityIdentity } from '../../src/main/continuity/identity'
import { continuityTargets } from '../../src/main/backup/continuity'
import { createMemoryEngine } from '../../src/main/memory/engine'
import { createMemoryDatabaseClient } from '../../src/main/memory/storage/client'
import { createNativeMemoryDatabase } from '../../src/main/memory/storage/neo'

/** Closed, fresh test profile only. This supplies pre-existing long-term facts;
 * promotion quality is not part of the mirror/settings/restore scenario. */
export async function seedMirrorProductFacts(root: string, scope: { userId: string; characterId: string; sessionId: string }, now: number) {
  const clock = createManualClock(now), identity = ensureContinuityIdentity(root, scope)
  const engine = createMemoryEngine({ root: join(root, continuityTargets(identity.owner)[0]), owner: identity.owner, clock,
    embedding: () => undefined, held: () => false, waitForRestore: async () => {}, journal: () => {},
    openDatabase: async path => {
      const db = createMemoryDatabaseClient(createNativeMemoryDatabase(), clock)
      await db.open(path); return db
    } })
  try {
    const repository = await engine.runtime.initialize()
    assert.ok(repository)
    assert.equal((await repository.list({ limit: 10 })).length, 0, 'FRESH_MIRROR_FIXTURE_REQUIRED')
    const result: Record<string, { id: string; content: string }> = {}
    for (const [name, content] of Object.entries({ kept: '镜像夹具：每天检查课程安排。', corrected: '镜像夹具：任务目标最初为茶。', forgotten: '镜像夹具：旧地点需要遗忘。' })) {
      const fact = await repository.insert({ scope: { userId: scope.userId, characterId: scope.characterId }, sessionId: scope.sessionId,
        content, memoryType: 'long_term', category: 'chat', importance: 5, valence: 0, arousal: 0, tags: ['synthetic-mirror-fixture'], reviewStatus: 'approved' })
      result[name] = { id: fact.id, content }
    }
    return result
  } finally { await engine.dispose() }
}
