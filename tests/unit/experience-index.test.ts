import { afterEach, describe, expect, it } from 'vitest'
import { createManualClock } from '../../src/main/clock'
import { createExperienceIndex } from '../../src/main/memory/experience'
import { createFakeMemoryModel, validateSummary, sourceRef } from '../../src/main/memory/model'
import { latestSummaries } from '../../src/main/memory/hierarchy'
import { projectMemory } from '../../src/main/memory/projection'
import { projectJournal } from '../../src/main/journal/projection'
import { memoryInputBytes, seenFragments, type SeenFragment } from '../../src/main/memory/seen'
import type { JournalInput, JournalRecord } from '../../src/main/journal/schema'
import type { SessionStore } from '../../src/main/store/session'
import type { MemoryRepository } from '../../src/main/memory/repository'
import { testMemoryFacts } from '../helpers/memory'

const closes: (() => Promise<void>)[] = []
afterEach(async () => { for (const close of closes.splice(0)) await close() })
function fixture() {
  const clock = createManualClock(0); clock.advanceBy(clock.parse('2026-10-01T12:00:00+08:00'))
  const pages: { sessionId: string; dayKey: string; records: JournalRecord[] }[] = []
  const scope = { userId: 'user', characterId: 'character', sessionId: '' }
  const current = () => pages.at(-1)!
  const append = (input: JournalInput, page = current()) => { page.records.push({ ...input, version: 1, seq: page.records.length + 1, atMs: clock.nowMs() }) }
  const nextDay = () => {
    if (pages.length) clock.advanceBy(86_400_000)
    const dayKey = clock.iso(clock.nowMs()).slice(0, 10); scope.sessionId = `s-${dayKey}`
    pages.push({ sessionId: scope.sessionId, dayKey, records: [] }); append({ type: 'session/header', ...scope })
    return current()
  }
  nextDay()
  const store: SessionStore = { scope, records: () => current().records, history: () => pages.flatMap(page => page.records), pages: () => pages,
    dayKey: () => current().dayKey, append, projection: () => projectJournal(current().records), close: () => {} }
  const repository: MemoryRepository = { view: () => projectMemory(store.history!()), append, refresh: () => {}, close: () => {} }
  const calls: SeenFragment[][] = [], fake = createFakeMemoryModel()
  let policy = () => ({ revision: 'initial', excludedSourceIds: [] as string[], legacyCutoff: 0 })
  let summarize: Parameters<typeof createExperienceIndex>[0]['summarize'] = async (_kind, input, signal) => validateSummary(await fake.model.summarize(input, signal), input)
  const index = createExperienceIndex({ store, clock, repository, source: () => 'fake', policy: () => policy(),
    summarize: async (kind, input, signal) => { calls.push([...input]); return summarize(kind, input, signal) } })
  const seen = (id: string, text: string, page = current()) => {
    append({ type: 'user/message', id, text, requestId: id, commandHash: 'fixture' }, page)
    append({ type: 'model/seen', turnId: id, source: 'fake', messages: [{ role: 'user', content: text }], eligibleIndexes: [0], originalEvents: [{ index: 0, eventId: id }] }, page)
  }
  return { clock, pages, store, repository, calls, index, seen, nextDay, append, current, usePolicy: (value: typeof policy) => { policy = value },
    setSummarizer: (value: typeof summarize) => { summarize = value } }
}
const signal = () => new AbortController().signal

describe('coverage-based experience projection', () => {
  it('invalidates full summary coverage even when the selected citations omit the withdrawn suffix, then rebuilds from the active prefix', async () => {
    const f = fixture(), page = f.current()
    f.seen('safe', 'SAFE_REQUIREMENT'); f.seen('bad', 'POISON_REQUIREMENT')
    await f.index.summarizeDay(page, signal())
    const original = f.repository.view().summaries.at(-1)!
    // A model citation subset must never be mistaken for its complete inputs.
    f.append({ type: 'memory/summary', summary: { ...original, id: 'subset-summary', sources: original.sources.slice(0, 1), text: 'POISON_IN_SUMMARY' } })
    f.append({ type: 'conversation/recontinued', operationId: 'cut', parentRevision: 'initial', targetMessageId: 'bad', fromSeq: page.records.find(row => row.type === 'user/message' && row.id === 'bad')!.seq,
      throughSeq: page.records.length, sourceRootId: 'old', nextRootId: 'new', cwd: 'fixture' })
    const index = f.index.index().days[0]
    expect(index.summaryId).toBeNull()
    expect(f.index.expand(page.sessionId, index.revision, 0, true).fragments.map(row => row.text)).toEqual(['SAFE_REQUIREMENT'])
    await f.index.summarizeDay(page, signal())
    expect(f.calls.at(-1)?.map(source => source.text)).toEqual(['SAFE_REQUIREMENT'])
    for (let i = 0; i < 40; i++) f.nextDay()
    await f.index.consolidate(signal())
    expect(JSON.stringify(f.index.previousDays())).not.toContain('POISON')
    expect(f.index.readSession(page.sessionId).messages.find(row => row.id === 'bad')?.withdrawn).toBe(true)
  })
  it('finds a two-month-old decision by month and exact day ID without pretending it is recent context', async () => {
    const f = fixture(), original = f.current()
    f.seen('old-decision', 'The bridge was blue because it marked the safe route.')
    await f.index.summarizeDay(original, signal())
    const raw = structuredClone(original.records)
    for (let i = 0; i < 62; i++) f.nextDay()
    const index = f.index.index(), month = index.periods.find(period => period.level === 'month' && period.period === '2026-10')!
    expect(month.dayKeys).toContain(original.dayKey)
    const day = index.days.find(day => day.sessionId === original.sessionId)!
    expect(day.coverage).toMatchObject({ count: 1, total: 1, complete: true })
    expect(f.index.expand(day.sessionId, day.revision, 0).fragments.map(fragment => fragment.text)).toEqual(['The bridge was blue because it marked the safe route.'])
    expect(f.index.readSession(day.sessionId).messages[0].text).toContain('safe route')
    expect(f.index.sessionView().pages.some(page => page.sessionId === day.sessionId)).toBe(false)
    expect(original.records).toEqual(raw)
  })

  it('covers the entire day in bounded increments, catches later input, and expands without recapture', async () => {
    const f = fixture(), first = f.current()
    for (let i = 0; i < 48; i++) f.seen(`original-${i}`, `Decision ${i}. ` + 'detail '.repeat(220))
    await f.index.summarizeDay(first, signal())
    expect(f.repository.view().summaries[0].coverage?.complete).toBe(false)
    f.seen('last-original', 'Final original decision after the first summary.')
    f.nextDay()
    for (let i = 0; i < 20 && f.index.unsummarizedPage(); i++) await f.index.summarizeDay(f.index.unsummarizedPage()!, signal())
    expect(f.index.unsummarizedPage()).toBeUndefined()
    const head = latestSummaries(f.repository.view().summaries)[0]
    expect(head.coverage).toMatchObject({ count: 49, complete: true })
    const submitted = f.calls.flat().filter(item => !item.id.startsWith('summary:')).map(item => item.id)
    expect(new Set(submitted).size).toBe(49); expect(submitted).toHaveLength(49)
    expect(f.calls.every(input => memoryInputBytes(input) <= 28_000)).toBe(true)
    expect(head.previousSummaryId).toBeTruthy()
    const entry = f.index.index().days[0], before = seenFragments(f.store.history!(), true, true).length
    const expanded = f.index.expand(entry.sessionId, entry.revision, 0)
    expect(expanded.fragments[0].text).toContain('Decision 0.'); expect(expanded.nextOffset).not.toBeNull()
    expect(seenFragments(f.store.history!(), true, true)).toHaveLength(before)
    const calls = f.calls.length; await f.index.summarizeDay(first, signal()); expect(f.calls).toHaveLength(calls)
  })

  it('invalidates old summaries and indexed expansion after native correction and forgetting', async () => {
    const f = fixture(), old = f.current(); f.seen('old-decision', 'The deadline is Friday.')
    const facts = testMemoryFacts(f.store, f.clock); closes.push(facts.close); f.usePolicy(facts.experiencePolicy)
    const remember = await facts.propose('remember-turn', 'event:old-decision', 'remember-deadline', { kind: 'remember', content: 'The deadline is Friday.' }, signal())
    await facts.review(remember.operationId, true)
    await f.index.summarizeDay(old, signal()); const oldIndex = f.index.index().days[0]
    f.nextDay(); expect(JSON.stringify(f.index.previousDays())).toContain('Friday')
    f.seen('new-decision', 'The deadline is now Saturday.')
    const oldFact = facts.factViews()[0]
    const correction = await facts.propose('correction-turn', 'event:new-decision', 'correct-deadline', { kind: 'correct', targetId: oldFact.id, expectedRevision: oldFact.revision, content: 'The deadline is now Saturday.' }, signal())
    await facts.review(correction.operationId, true)
    expect(facts.experiencePolicy().excludedSourceIds).toContain('event:old-decision')
    expect(facts.experiencePolicy().legacyCutoff).toBe(0)
    expect((await facts.runtime.listOperations({ userId: 'user', characterId: 'character' })).find(item => item.operationId === correction.operationId)?.previousSourceContext?.messageId).toBe('event:old-decision')
    expect(JSON.stringify(f.index.previousDays())).not.toContain('Friday')
    expect(() => f.index.expand(oldIndex.sessionId, oldIndex.revision, 0)).toThrow('EXPERIENCE_REVISION_CHANGED')
    const historical = f.index.index().days[0]
    expect(f.index.expand(historical.sessionId, historical.revision, 0).fragments).toEqual([])
    expect(f.index.expand(historical.sessionId, historical.revision, 0, true).fragments).toMatchObject([{ text: 'The deadline is Friday.', superseded: true }])
    await f.index.summarizeDay(f.current(), signal()); f.nextDay()
    expect(JSON.stringify(f.index.previousDays())).toContain('Saturday')
    expect(JSON.stringify(f.index.previousDays())).not.toContain('Friday')
    const currentFact = facts.factViews().find(item => item.factStatus === 'active')!
    const forget = await facts.propose('forget-turn', 'event:forget', 'forget-deadline', { kind: 'forget', targetId: currentFact.id, expectedRevision: currentFact.revision }, signal())
    await facts.review(forget.operationId, true)
    expect(JSON.stringify(f.index.previousDays())).not.toMatch(/Friday|Saturday/)
    const forgotten = f.index.index().days[0]
    expect(f.index.expand(forgotten.sessionId, forgotten.revision, 0, true).fragments).toEqual([])
    expect(JSON.stringify(f.store.history!())).toContain('Friday')
    expect(seenFragments(f.store.history!()).some(item => item.text.includes('Friday'))).toBe(true)
  })

  it('does not commit a summary after its source policy changes during the model request', async () => {
    const f = fixture(); f.seen('original', 'Original visible decision.')
    f.setSummarizer(async (_kind, input) => { f.usePolicy(() => ({ revision: 'corrected', excludedSourceIds: ['event:original'], legacyCutoff: 0 })); return { text: input[0].text, sources: [sourceRef(input[0])] } })
    await expect(f.index.summarizeDay(f.current(), signal())).rejects.toMatchObject({ code: 'unavailable' })
    expect(f.repository.view().summaries).toEqual([])
  })

  it('fails closed when a fixture supplies a bare message ID instead of a successful-input identity', async () => {
    const f = fixture(); f.seen('old-decision', 'The deadline is Friday.')
    const facts = testMemoryFacts(f.store, f.clock); closes.push(facts.close); f.usePolicy(facts.experiencePolicy)
    const old = await facts.propose('remember-turn', 'old-decision', 'bare-remember', { kind: 'remember', content: 'The deadline is Friday.' }, signal())
    await facts.review(old.operationId, true); f.nextDay(); f.seen('new-decision', 'The deadline is now Saturday.')
    const original = facts.factViews()[0]
    const corrected = await facts.propose('correction-turn', 'new-decision', 'bare-correction', { kind: 'correct', targetId: original.id, expectedRevision: original.revision, content: 'The deadline is now Saturday.' }, signal())
    await facts.review(corrected.operationId, true)
    expect(facts.experiencePolicy().legacyCutoff).toBe(f.clock.nowMs())
    expect(facts.factViews().find(item => item.id === original.id)?.factStatus).toBe('superseded')
    const page = f.index.index().days[0]
    expect(f.index.expand(page.sessionId, page.revision, 0, true).fragments).toEqual([])
    expect(seenFragments(f.store.history!(), true, true).some(item => item.sourceEventId === 'old-decision')).toBe(true)
  })

  it('rolls up full week/month coverage with bounded calls and no recursive memory input', async () => {
    const f = fixture()
    for (let i = 0; i < 31; i++) {
      for (let j = 0; j < 6; j++) f.seen(`day-${i}-${j}`, `Experience ${i}.${j}. ` + 'context '.repeat(35))
      await f.index.summarizeDay(f.current(), signal()); f.nextDay()
    }
    for (let i = 0; i < 10; i++) await f.index.consolidate(signal(), 2)
    const month = latestSummaries(f.repository.view().summaries).find(item => item.level === 'month')!
    expect(month.coverage).toMatchObject({ count: 31, complete: true })
    expect(month.parentSummaryIds).toHaveLength(31)
    expect(f.repository.view().summaries.filter(item => item.level === 'month').length).toBeGreaterThan(1)
    expect(f.index.index().periods.find(period => period.level === 'month' && period.period === '2026-10')?.dayKeys).toHaveLength(31)
    expect(f.calls.every(input => memoryInputBytes(input) <= 28_000)).toBe(true)
    expect(seenFragments(f.store.history!(), true, true)).toHaveLength(186)
    const calls = f.calls.length; await f.index.consolidate(signal(), 4); expect(f.calls).toHaveLength(calls)
  })

  it('retires derived week/month text with a newly restricted parent and keeps checkpoint code facts separate', async () => {
    const f = fixture(), old = f.current()
    f.append({ type: 'work/turn', turnId: 'old-turn', engine: 'dsh', sessionId: 'root', preset: null, sourcePolicy: 2 })
    f.append({ type: 'model/seen', turnId: 'old-turn', source: 'fake', messages: [{ role: 'assistant', content: 'A once-allowed observation.' }], eligibleIndexes: [0] })
    await f.index.summarizeDay(old, signal())
    f.append({ type: 'work/checkpoint', id: 'checkpoint-code', workId: 'work-code', revision: 2, outcome: 'completed', evidenceCount: 1 })
    for (let i = 0; i < 32; i++) f.nextDay()
    await f.index.consolidate(signal(), 4)
    expect(f.index.previousDays().length).toBeGreaterThan(0)
    f.append({ type: 'turn/degraded', turnId: 'old-turn', sources: ['web'] })
    expect(f.index.previousDays()).toEqual([])
    expect(f.index.index().days[0].workCheckpoints).toEqual([{ id: 'checkpoint-code', workId: 'work-code', revision: 2, outcome: 'completed', evidenceCount: 1 }])
    expect(seenFragments(f.store.history!(), true, true).some(item => item.text.includes('checkpoint-code'))).toBe(false)
  })
})
