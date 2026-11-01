import { mkdtempSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { expect, it } from 'vitest'
import { createManualClock } from '../../src/main/clock'
import { createMemoryDatabaseClient } from '../../src/main/memory/storage/client'
import { createNativeMemoryDatabase } from '../../src/main/memory/storage/neo'
import { probeContinuityRecovery } from '../../src/main/validation/continuity-recovery'
import { probeBackup } from '../../src/main/validation/backup'

it('round-trips the nonempty book, native memory, original outbox and persistent work with recoverable retirement', async () => {
  const root = mkdtempSync(join(resolve(process.env.LCA_TEST_ARTIFACTS_DIR ?? 'test-results'), 'continuity-recovery-')), clock = createManualClock(1790000000000)
  const result = await probeContinuityRecovery(root, async path => {
    const database = createMemoryDatabaseClient(createNativeMemoryDatabase(), clock); await database.open(path); return database
  })
  expect(result.ok).toBe(true); expect(result.checks).toContain('interrupted_identity_move_rolls_back')
})

it('retains the existing private-save owner, credential, session retirement and crash rollback guarantees', async () => {
  const root = mkdtempSync(join(resolve(process.env.LCA_TEST_ARTIFACTS_DIR ?? 'test-results'), 'legacy-recovery-'))
  expect(await probeBackup(root)).toMatchObject({ ok: true, actualRestore: true, interruptedRestoreRolledBack: true, interruptedSessionRetirementRolledBack: true })
})
