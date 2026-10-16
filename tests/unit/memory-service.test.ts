import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AppCommand } from '../../src/shared'
import { createManualClock } from '../../src/main/clock'
import { openJournal } from '../../src/main/journal/file'
import { projectJournal } from '../../src/main/journal/projection'
import { createScheduler } from '../../src/main/scheduler'
import type { SessionStore } from '../../src/main/store/session'
import { projectMemory } from '../../src/main/memory/projection'
import type { MemoryRepository } from '../../src/main/memory/repository'
import { createMemoryService } from '../../src/main/memory/service'
import { createFakeMemoryModel, type MemoryModel } from '../../src/main/memory/model'
import { summaryPeriod, summaryReferences } from '../../src/main/memory/hierarchy'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
function fixture(model?: MemoryModel, limits?: { dailyCalls?: number }) {
  const root = mkdtempSync(join(tmpdir(), 'lca-memory-'))
  cleanups.push(async () => { if (!resolve(root).startsWith(join(resolve(tmpdir()), 'lca-memory-'))) throw new Error('Unsafe cleanup'); rmSync(root, { recursive: true, force: true }) })
  const clock = createManualClock(1000); const journal = openJournal(root, { userId: 'u', characterId: 'c' }, clock)
  const store: SessionStore = { scope: journal.scope, records: journal.records, projection: () => projectJournal(journal.records()), append: journal.append, close: journal.close }
  const repository: MemoryRepository = { view: () => projectMemory(journal.records()), append: journal.append, refresh: () => {}, close: () => {} }
  const scheduler = createScheduler(clock); const fake = createFakeMemoryModel(); let busy = false
  const memory = createMemoryService({ clock, store, scheduler, repository, model: model ?? fake.model, development: fake, isBusy: () => busy, rolled: () => {}, changed: () => {}, limits })
  scheduler.cancel('memory.maintenance')
  cleanups.push(async () => { await memory.close(); scheduler.dispose(); store.close() })
  const command = (body: Record<string, unknown>) => ({ ...body, protocolVersion: 1, epoch: 'test', requestId: String(store.records().length) } as AppCommand)
  const turn = (text: string) => {
    const id = String(store.records().length)
    store.append({ type: 'user/message', id, text, requestId: id, commandHash: 'test' }); store.append({ type: 'turn/start', turnId: id, trigger: 'user' }); store.append({ type: 'inbox/drain', ids: [id] })
    const messages = store.projection().context
    store.append({ type: 'model/seen', turnId: id, source: 'fake', messages, eligibleIndexes: messages.flatMap((message, index) => message.role === 'system' ? [] : [index]) })
    store.append({ type: 'assistant/message', turnId: id, id: 'reply-' + id, text: 'SYNTHETIC_REPLY', status: 'complete' }); store.append({ type: 'turn/end', turnId: id, reason: 'completed' })
  }
  return { clock, store, memory, repository, fake, command, turn, setBusy: (value: boolean) => { busy = value } }
}
describe('background memory scheduling and context assembly', () => {
  it('consolidates closed periods once, keeps original provenance, and retries invalid output', async () => {
    const f = fixture(); f.clock.advanceBy(f.clock.parse('2026-11-03T12:00:00+08:00') - f.clock.nowMs())
    const addDay = (day: string, suffix = '') => f.repository.append({ type: 'memory/summary', summary: { id: 'day-' + day + suffix, level: 'day', period: day, text: '可见经历' + day + suffix,
      sources: [{ id: 'seen-' + day + suffix, sessionId: day, frameSeq: 3, index: 1, offset: 0, atMs: f.clock.parse(day + 'T12:00:00+08:00') }], sourceSessionIds: [day], source: 'fake' } })
    addDay('2026-10-15'); addDay('2026-10-16')
    f.fake.select('invalid'); f.memory.dispatch(f.command({ type: 'memory.consolidate' })); await f.memory.idle()
    expect(f.memory.view().error?.code).toBe('memory-invalid-output'); expect(f.repository.view().summaries).toHaveLength(2)
    f.fake.select('ready'); f.memory.dispatch(f.command({ type: 'memory.consolidate' })); await f.memory.idle()
    expect(f.memory.view().summaryCounts).toEqual({ day: 2, week: 1, month: 1 })
    const before = f.store.records().length
    f.memory.dispatch(f.command({ type: 'memory.consolidate' })); await f.memory.idle(); expect(f.store.records()).toHaveLength(before)
    const month = f.repository.view().summaries.find((summary) => summary.level === 'month')!
    expect(month.sources.map((source) => source.id)).toEqual(['seen-2026-10-15', 'seen-2026-10-16'])
    expect(summaryReferences(f.repository.view().summaries, 'current').map((summary) => summary.level)).toEqual(['month'])
    expect(summaryReferences(f.repository.view().summaries, 'current', '2026-10-19', f.clock).every((summary) => summary.level === 'day')).toBe(true)
    expect(summaryReferences(f.repository.view().summaries, 'current', '2026-11-03', f.clock).map((summary) => summary.level)).toEqual(['week'])
    addDay('2026-10-16', '-revised'); f.memory.dispatch(f.command({ type: 'memory.consolidate' })); await f.memory.idle()
    expect(f.memory.view().summaryCounts).toEqual({ day: 2, week: 1, month: 1 })
    expect(f.repository.view().summaries.filter((summary) => summary.level === 'month')).toHaveLength(2)
  })
  it('labels weeks at Shanghai Monday even around UTC Sunday', () => {
    const f = fixture()
    expect(summaryPeriod('2026-10-18', 'week', f.clock)).toBe('2026-10-12')
    expect(summaryPeriod('2026-10-19', 'week', f.clock)).toBe('2026-10-19')
    expect(summaryPeriod('2026-11-01', 'month', f.clock)).toBe('2026-11')
  })
  it('extracts visible experience and excludes reference injection from future extraction eligibility', async () => {
    const f = fixture(); f.turn('我把纸桥放在书桌上，给它取名叫周五桥。')
    expect(f.memory.dispatch(f.command({ type: 'memory.extract' }))).toBeUndefined(); await f.memory.idle()
    expect(f.memory.view().shortTermCount).toBe(1)
    const prepared = await f.memory.prepareContext('next-turn', new AbortController().signal)
    const reference = prepared.messages.findIndex((message) => message.content.includes('memoryReference'))
    expect(reference).toBeGreaterThanOrEqual(0); expect(prepared.eligibleIndexes).not.toContain(reference)
    expect(prepared.messages[reference + 1].content).toContain('周五桥')
    f.store.append({ type: 'tool/call', turnId: 'search', callId: 'lookup', name: 'search_memory', templateId: 'memory.search', arguments: {} })
    f.store.append({ type: 'tool/result', turnId: 'search', callId: 'lookup', ok: true, raw: { secret: 'RAW_ONLY_MEMORY_TEST' }, visible: { memoryReference: '周五桥' }, elapsedMs: 0 })
    const withTool = await f.memory.prepareContext('with-tool', new AbortController().signal)
    const tool = withTool.messages.findIndex((message) => message.toolCallId === 'lookup')
    expect(tool).toBeGreaterThanOrEqual(0); expect(withTool.eligibleIndexes).not.toContain(tool)
    expect(JSON.stringify(withTool)).not.toContain('RAW_ONLY_MEMORY_TEST')
  })
  it('aborts a hanging background model on foreground work without consuming source keys', async () => {
    const extract = vi.fn(() => new Promise(() => {})); const f = fixture({ source: 'fake', extract, summarize: async () => ({}) })
    f.turn('我把纸桥放在书桌上，给它取名叫周五桥。'); f.memory.dispatch(f.command({ type: 'memory.extract' }))
    await vi.waitFor(() => expect(extract).toHaveBeenCalledOnce()); f.memory.foreground(); await f.memory.idle()
    expect(f.repository.view().keys).toHaveLength(0); expect(f.memory.view().status).toBe('idle')
  })
  it('keeps context unchanged when a summary is invalid and succeeds only on an explicit retry', async () => {
    const f = fixture(); for (let i = 0; i < 4; i++) f.turn('可见旧回合' + i + ' 资料核对。'.repeat(300))
    const before = JSON.stringify(f.store.projection().context)
    f.fake.select('invalid'); f.memory.dispatch(f.command({ type: 'context.compact' })); await f.memory.idle()
    expect(f.memory.view().error?.code).toBe('memory-invalid-output'); expect(JSON.stringify(f.store.projection().context)).toBe(before)
    f.fake.select('ready'); f.memory.dispatch(f.command({ type: 'context.compact' })); await f.memory.idle()
    expect(f.store.records().filter((row) => row.type === 'context/compact')).toHaveLength(1)
    expect(f.store.projection().messages).toHaveLength(8)
  })
  it('bounds background calls and does not advance source progress after budget refusal', async () => {
    const f = fixture(undefined, { dailyCalls: 1 }); f.turn('我喜欢的饮料是咖啡。')
    f.memory.dispatch(f.command({ type: 'memory.extract' })); await f.memory.idle(); const before = f.repository.view().keys.length
    f.turn('我喜欢的饮料现在改为红茶，不再喝咖啡。'); f.memory.dispatch(f.command({ type: 'memory.extract' })); await f.memory.idle()
    expect(f.memory.view().error?.code).toBe('budget-exceeded'); expect(f.repository.view().keys.length).toBe(before)
  })
  it('defers automatic work while busy, recently chatting, or lights are out', async () => {
    const f = fixture(); f.turn('我把纸桥放在书桌上，给它取名叫周五桥。')
    await f.memory.maintenance(); expect(f.repository.view().items).toHaveLength(0)
    f.clock.advanceBy(120_000); f.setBusy(true); await f.memory.maintenance(); expect(f.repository.view().items).toHaveLength(0)
    f.setBusy(false); f.store.append({ type: 'companion/lights', lightsOut: true, requestId: 'off', commandHash: 'test' }); await f.memory.maintenance(); expect(f.repository.view().items).toHaveLength(0)
    f.store.append({ type: 'companion/lights', lightsOut: false, requestId: 'on', commandHash: 'test' }); await f.memory.maintenance(); expect(f.repository.view().items).toHaveLength(1)
  })
})
