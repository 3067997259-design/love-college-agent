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
  it('withdraws reviewed derived facts before top-K, access and promotion while preserving an independent manual fact', async () => {
    const f = fixture(), signal = new AbortController().signal
    for (const id of ['safe', 'poison-1', 'poison-2', 'poison-3']) {
      f.store.append({ type: 'user/message', id, text: id, requestId: id, commandHash: id })
      f.source(id, id, id)
    }
    await f.facts.capture(f.facts.pendingSources(), { extract: async input => [{ content: input.userText, category: 'chat', memoryType: 'short_term', importance: 5, valence: 0, arousal: 0, tags: [], sessionId: input.sessionId }] }, signal)
    for (const fact of f.facts.factViews()) await f.facts.reviewFact(fact.id, fact.revision, true)
    const manual = await f.facts.propose('manual', 'user:manual', 'manual-remember', { kind: 'remember', content: 'MANUAL' }, signal)
    await f.facts.review(manual.operationId, true)
    const staleProposal = await f.facts.propose('poison-1', 'event:poison-1', 'pending-from-cut', { kind: 'remember', content: 'PENDING_POISON' }, signal)
    const repository = (await f.facts.runtime.initialize())!, poison = f.facts.factViews().filter(fact => fact.content.startsWith('poison'))
    for (let i = 0; i < 10; i++) await repository.recordAccess({ memoryIds: poison.map(fact => fact.id), sessionId: 'session-' + i })
    const counts = await Promise.all(poison.map(fact => repository.get(fact.id)))
    f.store.append({ type: 'conversation/recontinued', operationId: 'cut', parentRevision: 'initial', targetMessageId: 'poison-1',
      fromSeq: f.rows.find(row => row.type === 'user/message' && row.id === 'poison-1')!.seq, throughSeq: f.rows.length, sourceRootId: 'old', nextRootId: 'new', cwd: 'fixture' })
    const results = await f.facts.search('preference', 'after-cut')
    expect(results.map(fact => fact.text)).toContain('safe')
    expect(results.every(fact => !fact.text.startsWith('poison'))).toBe(true)
    expect(f.facts.factViews().map(fact => fact.content)).toContain('MANUAL')
    expect(f.facts.operations().some(item => item.operationId === staleProposal.operationId)).toBe(false)
    await expect(f.facts.review(staleProposal.operationId, true)).rejects.toThrow()
    await repository.recordAccess({ memoryIds: poison.map(fact => fact.id), sessionId: 'late-access' })
    await repository.promoteEligible({ minAccessCount: 1, minSessionCount: 1, scope: { userId: 'u', characterId: 'c' } })
    for (const [i, fact] of poison.entries()) {
      const current = await repository.get(fact.id)
      expect(current?.accessCount).toBe(counts[i]?.accessCount)
      expect(current?.memoryType).toBe('short_term')
    }
    f.source('late-worker', 'poison-1', 'poison-1')
    expect(f.facts.pendingSources().some(source => source.text.startsWith('poison'))).toBe(false)
  })
  it('offers only reviewed witnessed experiences to gifts, without writing the retired journal memory engine', async () => {
    const f = fixture(); f.source('bridge', 'bridge-message', 'We built a paper bridge together.')
    const signal = new AbortController().signal
    await f.facts.capture(f.facts.pendingSources(), { extract: async input => [{ content: input.userText, category: 'experience', memoryType: 'short_term', importance: 5, valence: 0, arousal: 0, tags: [], sessionId: input.sessionId }] }, signal)
    expect(f.facts.giftSources()).toEqual([])
    const original = f.facts.factViews()[0]; await f.facts.reviewFact(original.id, original.revision, true)
    expect(f.facts.giftSources()).toEqual([{ id: original.id, text: 'We built a paper bridge together.' }])
    f.source('correction', 'bridge-correction', 'We built a wooden bridge together.')
    const current = f.facts.factViews()[0]
    const correction = await f.facts.propose('correction', 'event:bridge-correction', 'correct-bridge', { kind: 'correct', targetId: current.id, expectedRevision: current.revision, content: 'We built a wooden bridge together.' }, signal)
    await f.facts.review(correction.operationId, true)
    expect(f.facts.giftSources()).toEqual([{ id: correction.fragmentId, text: 'We built a wooden bridge together.' }])
    const replacement = f.facts.factViews().find(item => item.id === correction.fragmentId)!
    await f.facts.propose('forget', 'event:forget-bridge', 'forget-bridge', { kind: 'forget', targetId: replacement.id, expectedRevision: replacement.revision }, signal)
    await f.facts.review('forget-bridge', true); await f.facts.refresh()
    expect(f.facts.giftSources()).toEqual([])
    expect(f.rows.some(row => row.type === 'memory/batch')).toBe(false)
  })

  it('does not turn an unwitnessed or non-experience reviewed fact into gift material', async () => {
    const f = fixture(), signal = new AbortController().signal
    f.source('preference', 'preference-message', 'I like tea.')
    await f.facts.capture(f.facts.pendingSources(), { extract: async input => [{ content: input.userText, category: 'chat', memoryType: 'short_term', importance: 5, valence: 0, arousal: 0, tags: [], sessionId: input.sessionId }] }, signal)
    const preference = f.facts.factViews()[0]; await f.facts.reviewFact(preference.id, preference.revision, true)
    const repository = (await f.facts.runtime.initialize())!
    await repository.insert({ content: 'Unwitnessed experience.', scope: { userId: 'u', characterId: 'c' }, memoryType: 'short_term', category: 'experience', importance: 5, valence: 0, arousal: 0, tags: [], reviewStatus: 'approved', factStatus: 'active', now: f.clock.nowMs(), sourceContext: { sessionId: 'day-1', messageId: 'event:never-seen', neighbors: [] } })
    await f.facts.refresh()
    expect(f.facts.factViews()).toHaveLength(2); expect(f.facts.giftSources()).toEqual([])
  })

  it('deduplicates the original user decision across roots while preserving diary selection', () => {
    const f = fixture(); f.source('foreground', 'decision-one', 'Keep the original deadline.')
    f.rows.push({ version: 1, seq: f.rows.length + 1, atMs: f.clock.nowMs(), type: 'session/header', sessionId: 'worker-page', userId: 'u', characterId: 'c' })
    f.source('worker', 'decision-one', 'Keep the original deadline.')
    expect(f.facts.pendingSources().map(source => source.text)).toEqual(['Keep the original deadline.'])
    expect(seenFragments(f.rows).filter(source => source.text === 'DERIVED_REPLY')).toHaveLength(2)
    expect(seenFragments(f.rows, true).some(source => source.text === 'DERIVED_REPLY')).toBe(false)
  })

  it('admits successful Worker originals once without making automatic handoffs diary or memory material', () => {
    const f = fixture()
    f.store.append({ type: 'work/seen', workId: 'work-one', generation: 1, eventId: 'work-input', source: 'fake',
      originals: [{ id: 'decision-one', sessionId: 'day-1', text: 'Keep the original deadline.', atMs: f.clock.nowMs() }] })
    expect(f.facts.pendingSources().map(source => source.text)).toEqual(['Keep the original deadline.'])
    expect(seenFragments(f.rows)).toEqual([])
    f.source('foreground', 'decision-one', 'Keep the original deadline.')
    f.store.append({ type: 'inbox/event', id: 'checkpoint:one', source: 'work', text: 'Automatic derived delivery' })
    f.store.append({ type: 'model/seen', turnId: 'handoff', source: 'fake', messages: [{ role: 'user', content: 'Automatic derived delivery', toolCallId: 'checkpoint:one' }], eligibleIndexes: [0] })
    expect(f.facts.pendingSources().map(source => source.text)).toEqual(['Keep the original deadline.'])
    expect(seenFragments(f.rows).filter(source => source.text === 'Keep the original deadline.')).toHaveLength(1)
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

  it('keeps forgotten-source retirement after more than one hundred later operations', async () => {
    const f = fixture(); f.source('original', 'old-source', 'The old fact must stay forgotten.')
    const signal = new AbortController().signal
    await f.facts.propose('original', 'event:old-source', 'old-remember', { kind: 'remember', content: 'The old fact must stay forgotten.' }, signal)
    await f.facts.review('old-remember', true)
    const fact = f.facts.factViews()[0]
    await f.facts.propose('forget', 'event:forget', 'old-forget', { kind: 'forget', targetId: fact.id, expectedRevision: fact.revision }, signal)
    await f.facts.review('old-forget', true)
    // Only the old remember/forget is the behavior under test. Seed unrelated
    // history in one native transaction instead of checkpointing 105 UI turns.
    const repository = (await f.facts.runtime.initialize())!
    await repository.transaction(async transaction => {
      for (let index = 0; index < 105; index++) {
        f.clock.advanceBy(1)
        await transaction.saveOperation({ operationId: `later-${index}`, scope: { userId: 'u', characterId: 'c' }, sessionId: 'day-1', turnId: `later-${index}`,
          sourceContext: { sessionId: 'day-1', messageId: `event:later-${index}`, neighbors: [] }, status: 'rejected', createdAt: f.clock.nowMs(), updatedAt: f.clock.nowMs(),
          proposal: { kind: 'remember', content: `Unrelated historical proposal ${index}` } })
      }
    })
    await f.facts.refresh()
    expect(f.facts.experiencePolicy().excludedSourceIds).toContain('event:old-source')
    expect(f.facts.experiencePolicy().historicalSourceIds).not.toContain('event:old-source')
    expect(await f.facts.runtime.listOperations({ userId: 'u', characterId: 'c' })).toHaveLength(107)
  })

  it('rechecks source retirement at retrieval instead of trusting stored vectors', async () => {
    const f = fixture(); f.source('restricted-later', 'user-decision', 'A user decision.')
    f.store.append({ type: 'model/seen', turnId: 'restricted-later', source: 'fake', messages: [{ role: 'assistant', content: 'It is due on Friday.' }], eligibleIndexes: [0] })
    const source = f.facts.pendingSources().find(source => source.role === 'assistant')!
    await f.facts.capture([source], { extract: async input => [{ content: input.assistantText, category: 'experience', memoryType: 'short_term', importance: 5, valence: 0, arousal: 0, tags: [], sessionId: input.sessionId }] }, new AbortController().signal)
    const fact = f.facts.factViews()[0]; await f.facts.reviewFact(fact.id, fact.revision, true)
    expect(await f.facts.search('due', 'before-retirement')).toHaveLength(1)
    expect(f.facts.giftSources()).toHaveLength(1)
    f.store.append({ type: 'turn/degraded', turnId: 'restricted-later', sources: ['web'] })
    expect(await f.facts.search('due', 'after-retirement')).toEqual([])
    expect(f.facts.factViews()).toEqual([])
    expect(f.facts.giftSources()).toEqual([])
    expect(f.facts.pendingSources().every(source => source.role === 'user')).toBe(true)
  })
})
