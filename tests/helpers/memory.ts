import { mkdirSync, mkdtempSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { Clock } from '../../src/main/clock'
import type { SessionStore } from '../../src/main/store/session'
import { createMemoryFacts } from '../../src/main/memory/facts'
import { createMemoryDatabaseClient } from '../../src/main/memory/storage/client'
import { createNativeMemoryDatabase } from '../../src/main/memory/storage/neo'

/** Same owning engine as production, with an in-process native file connection
 * and a deterministic 768-dimensional embedding. No network or model account. */
export function testMemoryFacts(store: SessionStore, clock: Clock, parent?: string) {
  const base = resolve(parent ?? process.env.LCA_TEST_ARTIFACTS_DIR ?? 'test-results'); mkdirSync(base, { recursive: true })
  const root = mkdtempSync(join(base, 'facts-'))
  return createMemoryFacts({ root, clock, store, owner: { ...store.scope, dataRootId: root },
    held: () => store.projection().lightsOut, waitForRestore: async () => {}, changed: () => {},
    embedding: () => ({ provider: 'fixture', model: 'synthetic', fingerprint: 'fixture-native', embed: async () => Array.from({ length: 768 }, (_, index) => index === 0 ? 1 : 0) }),
    openDatabase: async path => { const db = createMemoryDatabaseClient(createNativeMemoryDatabase(), clock); await db.open(path); return db } })
}
