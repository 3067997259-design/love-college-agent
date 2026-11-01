import { mkdtempSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createManualClock } from '../../../src/main/clock'
import { createNativeMemoryDatabase } from '../../../src/main/memory/storage/neo'
import { createMemoryDatabaseClient } from '../../../src/main/memory/storage/client'
import { runMemoryStorageContract } from '../../../scripts/fixtures/memory-storage-contract'

describe('AIRI memory on native DuckDB', () => {
  it('passes the real-file storage contract, including transactions and reopens', async () => {
    const root = mkdtempSync(join(resolve(process.env.LCA_TEST_ARTIFACTS_DIR ?? 'test-results'), 'memory-node-'))
    const report = await runMemoryStorageContract(async () => {
      const db = createMemoryDatabaseClient(createNativeMemoryDatabase(), createManualClock(100))
      await db.open(join(root, 'memory.duckdb'))
      return db
    })
    expect(report.ok).toBe(true)
    expect(report.checks).toHaveLength(6)
  }, 60_000)
})
