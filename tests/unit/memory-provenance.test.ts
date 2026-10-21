import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createManualClock } from '../../src/main/clock'
import { openJournal } from '../../src/main/journal/file'
import { projectJournal } from '../../src/main/journal/projection'
import { createScheduler } from '../../src/main/scheduler'
import type { SessionStore } from '../../src/main/store/session'
import { projectMemory } from '../../src/main/memory/projection'
import type { MemoryRepository } from '../../src/main/memory/repository'
import { createMemoryService } from '../../src/main/memory/service'
import { createFakeMemoryModel } from '../../src/main/memory/model'
import { latestSummaries, summaryReferences, validSummaries } from '../../src/main/memory/hierarchy'
import type { MemorySummary } from '../../src/main/memory/schema'
import { seenFragments, userOrigins } from '../../src/main/memory/seen'
import type { JournalInput, JournalRecord } from '../../src/main/journal/schema'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'lca-provenance-'))
  cleanups.push(async () => { if (!resolve(root).startsWith(join(resolve(tmpdir()), 'lca-provenance-'))) throw new Error('Unsafe cleanup'); rmSync(root, { recursive: true, force: true }) })
  const clock = createManualClock(0)
  const selectedDay = '2026-08-10'
  const today = clock.iso(clock.parse(selectedDay + 'T12:00:00+08:00') + 31 * 86400000).slice(0, 10)
  clock.advanceBy(clock.parse(today + 'T12:00:00+08:00'))
  const journal = openJournal(root, { userId: 'u', characterId: 'c' }, clock)
  const store: SessionStore = { scope: journal.scope, records: journal.records, projection: () => projectJournal(journal.records()), append: journal.append, close: journal.close }
  const repository: MemoryRepository = { view: () => projectMemory(journal.records()), append: journal.append, refresh: () => {}, close: () => {} }
  const scheduler = createScheduler(clock); const fake = createFakeMemoryModel()
  const memory = createMemoryService({ clock, scheduler, store, repository, model: fake.model, development: fake, isBusy: () => false, rolled: () => {}, changed: () => {} })
  scheduler.cancel('memory.maintenance')
  cleanups.push(async () => { await memory.close(); scheduler.dispose(); store.close() })
  const seen = (suffix = '') => ({ id: 'seen' + suffix, sessionId: 's:' + selectedDay + suffix, frameSeq: 2, index: 0, offset: 0, atMs: clock.parse(selectedDay + 'T12:00:00+08:00') })
  const dayRow = (text: string, suffix = '', session = 's:' + selectedDay): JournalInput => ({ type: 'memory/summary', summary: { id: 'day' + suffix, level: 'day', period: selectedDay, text, sources: [seen(suffix)], sourceSessionIds: [session], source: 'fake' } })
  const monthRow = (text: string, parentIds: string[], suffix = ''): JournalInput => ({ type: 'memory/summary', summary: { id: 'month' + suffix, level: 'month', period: '2026-08', text, sources: [seen()], sourceSessionIds: ['s:' + selectedDay], parentSummaryIds: [...parentIds], source: 'fake' } })
  const preparation = async () => {
    const turn = (id: string, text: string) => {
      store.append({ type: 'user/message', id, text, requestId: id, commandHash: 'test' })
      store.append({ type: 'turn/start', turnId: id, trigger: 'user' })
      store.append({ type: 'inbox/drain', ids: [id] })
      const messages = store.projection().context
      store.append({ type: 'model/seen', turnId: id, source: 'fake', messages, eligibleIndexes: messages.flatMap((message, index) => message.role === 'system' ? [] : [index]) })
      store.append({ type: 'assistant/message', turnId: id, id: 'r-' + id, text: 'SYNTHETIC', status: 'complete' })
      store.append({ type: 'turn/end', turnId: id, reason: 'completed' })
    }
    turn('t1', '今天把这件事记一下。')
    // What a new day's session gets with its first message (memory/service.ts reference).
    return JSON.stringify(memory.reference('', 't2', true)?.previousDaysReference ?? [])
  }
  return { clock, store, repository, journal, memory, dayRow, monthRow, preparation, selectedDay, today, fake }
}

describe('derived summary dependency freshness (F1)', () => {
  it('drops a wider summary whose child was superseded, and the corrected child represents the session instead', async () => {
    const f = fixture()
    f.repository.append(f.dayRow('活动在周五'))
    f.repository.append(f.monthRow('活动在周五', ['day']))
    f.repository.append(f.dayRow('活动改到周六', '-v2', 's:' + f.selectedDay))
    const summaries = f.repository.view().summaries
    // 旧规则只看日历年龄，会继续用过期的月摘要代表这段经历。
    expect(summaryReferences(summaries, 's:today', f.today, f.clock).map((summary) => summary.text)).toEqual(['活动在周五'])
    // 守卫让过期的月摘要失效，由纠正后的日摘要接替，不留缺口。
    expect(summaryReferences(validSummaries(summaries), 's:today', f.today, f.clock).map((summary) => summary.text)).toEqual(['活动改到周六'])
    const reference = await f.preparation()
    expect(reference).toContain('活动改到周六')
    expect(reference).not.toContain('活动在周五')
  })
  it('keeps the wider summary when its child is still the current version', async () => {
    const f = fixture()
    f.repository.append(f.dayRow('活动在周五'))
    f.repository.append(f.monthRow('活动在周五', ['day']))
    f.repository.append({ type: 'memory/summary', summary: { id: 'day-other', level: 'day', period: '2026-08-20', text: '另一天的事',
      sources: [{ id: 'seen-other', sessionId: 's:other', frameSeq: 2, index: 0, offset: 0, atMs: f.clock.parse('2026-08-20T12:00:00+08:00') }], sourceSessionIds: ['s:other'], source: 'fake' } })
    const summaries = f.repository.view().summaries
    expect(validSummaries(summaries)).toHaveLength(3)
    // 月摘要保持有效；另一天的日摘要也各自成为代表，两者不覆盖同一来源会话。
    const selected = summaryReferences(validSummaries(summaries), 's:today', f.today, f.clock)
    expect(selected.map((summary) => summary.id).sort()).toEqual(['day-other', 'month'])
  })
  it('treats a declared parent that is absent as unknown, not stale', () => {
    const orphan: MemorySummary = { id: 'month', level: 'month', period: '2026-08', text: '活动在周五', sources: [], sourceSessionIds: ['s:x'], parentSummaryIds: ['day-never-persisted'], source: 'fake' }
    expect(validSummaries([orphan])).toHaveLength(1)
    expect(latestSummaries([orphan])).toHaveLength(1)
  })
  it('does not invalidate summaries that declare no dependency', () => {
    const plain: MemorySummary = { id: 'week', level: 'week', period: '2026-08-10', text: '普通摘要', sources: [], sourceSessionIds: ['s:x'], source: 'fake' }
    expect(validSummaries([plain])).toHaveLength(1)
  })
})

describe('fragment origin as a permission, not a transport role (F2)', () => {
  const owner = { userId: 'u', characterId: 'c' }
  it('labels a mail notice as its journal source, not as the user', () => {
    const records = [
      { type: 'session/header', seq: 1, atMs: 1000, sessionId: 's', ...owner },
      { type: 'inbox/event', seq: 2, atMs: 2000, id: 'mail:1', source: 'mail', text: '{"trust":"untrusted","title":"报告截止改为周六"}' },
      { type: 'inbox/drain', seq: 3, atMs: 2000, ids: ['mail:1'] },
      { type: 'model/seen', seq: 4, atMs: 2000, turnId: 't', source: 'fake', messages: [{ role: 'user', content: '{"source":"mail","facts":"{\\"trust\\":\\"untrusted\\",\\"title\\":\\"报告截止改为周六\\"}"}' }], eligibleIndexes: [0] },
    ] as unknown as JournalRecord[]
    const fragments = seenFragments(records)
    expect(fragments[0].role).toBe('user')
    expect(fragments[0].origin).toBe('mail')
    expect(userOrigins(fragments[0].origin)).toBe(false)
  })
  it('still labels a plain user message as the user', () => {
    const records = [
      { type: 'session/header', seq: 1, atMs: 1000, sessionId: 's', ...owner },
      { type: 'user/message', seq: 2, atMs: 2000, id: 'u1', text: '我喜欢的饮料现在改为红茶。', requestId: 'u1', commandHash: 'h' },
      { type: 'inbox/drain', seq: 3, atMs: 2000, ids: ['u1'] },
      { type: 'model/seen', seq: 4, atMs: 2000, turnId: 't', source: 'fake', messages: [{ role: 'user', content: '我喜欢的饮料现在改为红茶。' }], eligibleIndexes: [0] },
    ] as unknown as JournalRecord[]
    const fragments = seenFragments(records)
    expect(fragments[0].origin).toBe('user')
    expect(userOrigins(fragments[0].origin)).toBe(true)
  })
})
