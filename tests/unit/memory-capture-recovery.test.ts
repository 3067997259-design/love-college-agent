import { mkdtempSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { createManualClock } from '../../src/main/clock'
import { createMemoryEngine } from '../../src/main/memory/engine'
import { createMemoryFacts } from '../../src/main/memory/facts'
import { createMemoryDatabaseClient } from '../../src/main/memory/storage/client'
import { createNativeMemoryDatabase } from '../../src/main/memory/storage/neo'
import type { MemoryCommitPoint } from '../../src/main/memory/storage/commits'
import type { JournalRecord } from '../../src/main/journal/schema'
import type { SessionStore } from '../../src/main/store/session'
import { projectJournal } from '../../src/main/journal/projection'
import { seenFragments } from '../../src/main/memory/seen'

describe('original-input capture receipts', () => {
  it('records a completed empty extraction and does not call the model again for that source', async () => {
    const root = mkdtempSync(join(resolve('test-results'), 'capture-empty-')); const clock = createManualClock(1790000000000)
    const owner = { userId: 'capture-user', characterId: 'capture-character', dataRootId: root }
    const extract = vi.fn(async () => [])
    const create = () => createMemoryEngine({ root, clock, owner, embedding: () => undefined, held: () => false, waitForRestore: async () => {}, journal: () => {},
      openDatabase: async path => { const db = createMemoryDatabaseClient(createNativeMemoryDatabase(), clock); await db.open(path); return db } })
    const input = { scope: owner, sessionId: 'day', userText: 'Hello.', assistantText: '', sourceContext: { sessionId: 'day', messageId: 'greeting', neighbors: [] } }
    let engine = create(); await engine.runtime.captureTurn(input, extract, () => true, undefined, 'empty-source'); await engine.dispose()
    engine = create()
    try { await engine.runtime.captureTurn(input, extract, () => true, undefined, 'empty-source'); expect(extract).toHaveBeenCalledTimes(1) }
    finally { await engine.dispose() }
  })

  it.each<MemoryCommitPoint | 'cursor-gap'>(['before-commit', 'committed', 'published', 'cursor-gap'])('recovers %s without duplicating committed pending suggestions', async point => {
    const root = mkdtempSync(join(resolve('test-results'), 'capture-recovery-'))
    const clock = createManualClock(1790000000000)
    const owner = { userId: 'capture-user', characterId: 'capture-character', dataRootId: root }
    const scope = { userId: owner.userId, characterId: owner.characterId, sessionId: 'capture-day' }
    const rows: JournalRecord[] = [{ type: 'session/header', version: 1, seq: 1, atMs: clock.nowMs(), ...scope },
      { type: 'model/seen', version: 1, seq: 2, atMs: clock.nowMs(), turnId: 'capture-turn', source: 'fake', eligibleIndexes: [0], messages: [{ role: 'user', content: 'I prefer tea and quiet mornings.' }] }]
    const store: SessionStore = { scope, records: () => rows, history: () => rows, projection: () => projectJournal(rows), append: input => { rows.push({ ...input, version: 1, seq: rows.length + 1, atMs: clock.nowMs() }) }, close: () => {} }
    const openDatabase = async (path: string) => { const db = createMemoryDatabaseClient(createNativeMemoryDatabase(), clock); await db.open(path); return db }
    const source = seenFragments(rows, true, true)[0]
    const extract = vi.fn(async () => ['I prefer tea.', 'I prefer quiet mornings.'].map(content => ({ content, category: 'chat' as const, memoryType: 'short_term' as const, importance: 5, valence: 0, arousal: 0, tags: [] })))
    let interrupted = false
    const engine = createMemoryEngine({ root, clock, owner, openDatabase, embedding: () => undefined, held: () => false, waitForRestore: async () => {}, journal: () => {},
      interrupt: (at, id) => { if (at === point && !interrupted && id.startsWith('capture-source:')) { interrupted = true; throw new Error('synthetic-capture-interruption') } } })
    await engine.runtime.captureTurn({ scope: owner, sessionId: scope.sessionId, userText: source.text, assistantText: '', sourceContext: { sessionId: source.sessionId, messageId: source.id, neighbors: [], sourceType: 'successful-input' } },
      extract, () => true, undefined, source.key)
    await engine.dispose()
    const facts = createMemoryFacts({ root, clock, owner, store, openDatabase, embedding: () => undefined, held: () => false, waitForRestore: async () => {}, changed: () => {} })
    try {
      await facts.refresh()
      await facts.capture(facts.pendingSources(), { extract }, new AbortController().signal)
      expect(facts.factViews().map(fact => fact.content).sort()).toEqual(['I prefer quiet mornings.', 'I prefer tea.'])
      expect(facts.factViews().every(fact => fact.reviewStatus === 'pending')).toBe(true)
      expect(facts.pendingSources()).toEqual([])
      expect(extract).toHaveBeenCalledTimes(point === 'before-commit' ? 2 : 1)
    } finally { await facts.close() }
  })
})
