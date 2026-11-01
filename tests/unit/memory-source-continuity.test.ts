import { afterEach, describe, expect, it } from 'vitest'
import { createManualClock } from '../../src/main/clock'
import { projectJournal } from '../../src/main/journal/projection'
import type { JournalRecord } from '../../src/main/journal/schema'
import type { SessionStore } from '../../src/main/store/session'
import { seenFragments } from '../../src/main/memory/seen'
import { testMemoryFacts } from '../helpers/memory'

const closes: (() => Promise<void>)[] = []
afterEach(async () => { for (const close of closes.splice(0)) await close() })
const fixture = () => {
  const clock = createManualClock(1_790_000_000_000)
  const owner = { userId: 'u', characterId: 'c' }
  const rows: JournalRecord[] = [{ version: 1, seq: 1, atMs: clock.nowMs(), type: 'session/header', sessionId: 'day-1', ...owner }]
  const store: SessionStore = { scope: { ...owner, sessionId: 'day-1' }, records: () => rows, projection: () => projectJournal(rows), close: () => {},
    append: input => { rows.push({ ...input, version: 1, seq: rows.length + 1, atMs: clock.nowMs() }) } }
  const facts = testMemoryFacts(store, clock); closes.push(facts.close)
  const source = (turnId: string, messageId: string, user: string, reply = 'DERIVED_REPLY') => {
    store.append({ type: 'work/turn', turnId, engine: 'dsh', sessionId: `root-${turnId}`, preset: null, sourcePolicy: 2 })
    store.append({ type: 'model/seen', turnId, source: 'fake', messages: [{ role: 'user', content: user }, { role: 'assistant', content: reply }], eligibleIndexes: [0, 1],
      memoryExcludedIndexes: [1], originalEvents: [{ index: 0, eventId: messageId }] })
  }
  return { clock, rows, store, facts, source }
}

describe('successful-input continuity at the product adapter', () => {
  it('deduplicates the original user decision across roots while preserving diary selection', () => {
    const f = fixture(); f.source('foreground', 'decision-one', 'Keep the original deadline.')
    f.rows.push({ version: 1, seq: f.rows.length + 1, atMs: f.clock.nowMs(), type: 'session/header', sessionId: 'worker-page', userId: 'u', characterId: 'c' })
    f.source('worker', 'decision-one', 'Keep the original deadline.')
    expect(f.facts.pendingSources().map(source => source.text)).toEqual(['Keep the original deadline.'])
    expect(seenFragments(f.rows).filter(source => source.text === 'DERIVED_REPLY')).toHaveLength(2)
    expect(seenFragments(f.rows, true).some(source => source.text === 'DERIVED_REPLY')).toBe(false)
  })

  it('does not resurrect a forgotten claim when its original successful input is captured later', async () => {
    const f = fixture(); f.source('original', 'user-one', 'My drink is tea.')
    const operation = await f.facts.propose('original', 'event:user-one', 'remember-one', { kind: 'remember', content: 'My drink is tea.' }, new AbortController().signal)
    await f.facts.review(operation.operationId, true)
    const fact = f.facts.factViews()[0]
    const forget = await f.facts.propose('forget', 'event:user-forget', 'forget-one', { kind: 'forget', targetId: fact.id, expectedRevision: fact.revision }, new AbortController().signal)
    await f.facts.review(forget.operationId, true)
    await f.facts.capture(f.facts.pendingSources(), { extract: async input => [{ content: 'My drink is tea.', category: 'chat', memoryType: 'short_term', importance: 5, valence: 0, arousal: 0, tags: [], sessionId: input.sessionId }] }, new AbortController().signal)
    expect(f.facts.factViews()).toEqual([]); expect(f.facts.pendingSources()).toEqual([])
    expect(await f.facts.search('drink', 'after-forget')).toEqual([])
  })

  it('keeps failed model inputs pending and rejects a stale suggestion review', async () => {
    const f = fixture(); f.source('original', 'user-one', 'My drink is tea.')
    await expect(f.facts.capture(f.facts.pendingSources(), { extract: async () => { throw new Error('synthetic-model-failure') } }, new AbortController().signal)).rejects.toMatchObject({ code: 'connection-failed' })
    expect(f.facts.pendingSources()).toHaveLength(1)
    await f.facts.capture(f.facts.pendingSources(), { extract: async input => [{ content: 'My drink is tea.', category: 'chat', memoryType: 'short_term', importance: 5, valence: 0, arousal: 0, tags: [], sessionId: input.sessionId }] }, new AbortController().signal)
    const fact = f.facts.factViews()[0]
    await f.facts.reviewFact(fact.id, fact.revision, true)
    await expect(f.facts.reviewFact(fact.id, fact.revision, false)).rejects.toThrow('MEMORY_REVISION_CHANGED')
    expect(f.facts.factViews()[0].reviewStatus).toBe('approved')
  })

  it('rechecks source retirement at retrieval instead of trusting stored vectors', async () => {
    const f = fixture(); f.source('restricted-later', 'user-decision', 'A user decision.')
    f.store.append({ type: 'model/seen', turnId: 'restricted-later', source: 'fake', messages: [{ role: 'assistant', content: 'It is due on Friday.' }], eligibleIndexes: [0] })
    const source = f.facts.pendingSources().find(source => source.role === 'assistant')!
    await f.facts.capture([source], { extract: async input => [{ content: input.assistantText, category: 'chat', memoryType: 'short_term', importance: 5, valence: 0, arousal: 0, tags: [], sessionId: input.sessionId }] }, new AbortController().signal)
    const fact = f.facts.factViews()[0]; await f.facts.reviewFact(fact.id, fact.revision, true)
    expect(await f.facts.search('due', 'before-retirement')).toHaveLength(1)
    f.store.append({ type: 'turn/degraded', turnId: 'restricted-later', sources: ['web'] })
    expect(await f.facts.search('due', 'after-retirement')).toEqual([])
    expect(f.facts.factViews()).toEqual([])
    expect(f.facts.pendingSources().every(source => source.role === 'user')).toBe(true)
  })
})
