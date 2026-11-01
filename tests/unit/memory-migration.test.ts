import { mkdtempSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createManualClock } from '../../src/main/clock'
import { createMemoryEngine } from '../../src/main/memory/engine'
import { createMemoryDatabaseClient } from '../../src/main/memory/storage/client'
import { createNativeMemoryDatabase } from '../../src/main/memory/storage/neo'
import type { MemoryCommitPoint } from '../../src/main/memory/storage/commits'
import type { JournalInput, JournalRecord } from '../../src/main/journal/schema'
import { projectJournal } from '../../src/main/journal/projection'
import type { SessionStore } from '../../src/main/store/session'
import { seenFragments } from '../../src/main/memory/seen'
import { testMemoryFacts } from '../helpers/memory'

function history() {
  const clock = createManualClock(1790000000000)
  const scope = { userId: 'migrate-user', characterId: 'migrate-character', sessionId: 'legacy-day' }
  const rows: JournalRecord[] = [{ type: 'session/header', version: 1, seq: 1, atMs: clock.nowMs(), ...scope }]
  const append = (input: JournalInput) => { clock.advanceBy(1); rows.push({ ...input, version: 1, seq: rows.length + 1, atMs: clock.nowMs() }) }
  append({ type: 'model/seen', turnId: 'legacy-turn', source: 'fake', eligibleIndexes: [0, 1], messages: [{ role: 'user', content: 'I prefer tea.' }, { role: 'tool', content: 'A tool body must not migrate.', toolCallId: 'legacy-tool' }] })
  const seen = seenFragments(rows, true)
  const reference = (index: number) => { const { id, sessionId, frameSeq, index: messageIndex, offset, atMs } = seen[index]; return { id, sessionId, frameSeq, index: messageIndex, offset, atMs } }
  append({ type: 'memory/batch', source: 'fake', batchId: 'a'.repeat(64), keys: seen.map(item => item.key), entries: [
    { id: 'legacy-fact', text: 'I prefer tea.', kind: 'fact', topic: 'preference', sources: [reference(0)], supersedes: [] },
    { id: 'legacy-unsupported', text: 'A tool body must not migrate.', kind: 'fact', topic: null, sources: [reference(1)], supersedes: [] },
    { id: 'legacy-experience', text: 'We talked about tea.', kind: 'experience', topic: null, sources: [reference(0)], supersedes: [] },
  ] })
  append({ type: 'memory/access', requestId: 'old-recall', sessionId: scope.sessionId, ids: ['legacy-fact'] })
  const store: SessionStore = { scope, records: () => rows, history: () => rows, append, projection: () => projectJournal(rows), close: () => {} }
  return { clock, rows, store, scope: { userId: scope.userId, characterId: scope.characterId } }
}

describe('nonempty legacy memory migration', () => {
  it('imports supported unreviewed facts once, preserves history and never re-extracts old processed inputs', async () => {
    const f = history(); const original = structuredClone(f.rows); const facts = testMemoryFacts(f.store, f.clock)
    try {
      await facts.refresh(); await facts.refresh()
      expect(f.rows).toEqual(original)
      expect(facts.factViews()).toEqual([expect.objectContaining({ content: 'I prefer tea.', reviewStatus: 'pending', factStatus: 'active' })])
      expect(facts.pendingSources()).toEqual([])
      const repository = (await facts.runtime.initialize())!
      const imported = (await repository.list({ scope: f.scope }))[0]
      expect(imported.originId).toBe('legacy:legacy-fact'); expect(imported.accessCount).toBe(1)
      expect(imported.createdAt).toBe(f.rows.find(row => row.type === 'memory/batch')!.atMs)
      expect(imported.sourceContext).toMatchObject({ sourceType: 'legacy-memory', sourceEventId: 'legacy-fact' })
      expect(imported.contentVector).toBeUndefined()
    } finally { await facts.close() }
  })

  it.each<MemoryCommitPoint>(['intent', 'before-commit', 'committed', 'published'])('reconciles a migration interrupted at %s and does not resurrect a later forgotten fact', async point => {
    const f = history(); const root = mkdtempSync(join(resolve(process.env.LCA_TEST_ARTIFACTS_DIR ?? 'test-results'), 'memory-migration-'))
    let interrupted = false
    const create = (interrupt = false) => createMemoryEngine({ root, clock: f.clock, owner: { ...f.scope, dataRootId: root }, embedding: () => undefined,
      held: () => false, waitForRestore: async () => {}, journal: () => {},
      interrupt: (at, operation) => { if (interrupt && !interrupted && at === point && operation.startsWith('legacy-memory:')) { interrupted = true; throw new Error('synthetic-migration-interruption') } },
      openDatabase: async path => { const db = createMemoryDatabaseClient(createNativeMemoryDatabase(), f.clock); await db.open(path); return db } })
    let engine = create(true)
    await expect(engine.migrateLegacy(f.rows)).rejects.toThrow('synthetic-migration-interruption')
    await engine.dispose(); engine = create()
    try {
      expect(await engine.migrateLegacy(f.rows)).toMatchObject({ imported: 1, archived: 1 })
      const repository = (await engine.runtime.initialize())!
      const [fact] = await repository.list({ scope: f.scope }); expect(await repository.list({ scope: f.scope })).toHaveLength(1)
      await engine.runtime.setReviewStatus(fact.id, 'approved', { scope: f.scope, revision: fact.revision! })
      const approved = (await repository.list({ scope: f.scope }))[0]
      await engine.runtime.proposeOperation({ scope: f.scope, sessionId: 'legacy-day', turnId: 'forget-turn', sourceContext: { sessionId: 'legacy-day', messageId: 'forget-message', neighbors: [] }, isCurrent: () => true },
        'forget-migrated', { kind: 'forget', targetId: approved.id, expectedRevision: approved.revision })
      await engine.runtime.confirmOperation(f.scope, 'forget-migrated', true)
      await engine.migrateLegacy(f.rows)
      expect(await repository.list({ scope: f.scope })).toEqual([])
      await expect(engine.migrateLegacy([{ ...f.rows[0], userId: 'someone-else' } as JournalRecord])).rejects.toThrow('MEMORY_MIGRATION_SCOPE_MISMATCH')
    } finally { await engine.dispose() }
  })
})
