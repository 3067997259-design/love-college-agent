import Database from 'better-sqlite3'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import type { AppCommand } from '../../shared'
import { createManualClock } from '../clock'
import { openSessionStore } from '../store/session'
import { journalLocation } from '../journal/file'
import { createScheduler } from '../scheduler'
import { openMemoryRepository } from '../memory/repository'
import { createFakeMemoryModel } from '../memory/model'
import { createMemoryService } from '../memory/service'
import { createHarness } from '../harness/loop'
import type { ModelClient } from '../model/types'
import { seenFragments } from '../memory/seen'

export async function probeMemory(root: string) {
  const clock = createManualClock(0); clock.advanceBy(clock.parse('2026-10-16T03:50:00+08:00'))
  const owner = { userId: 'memory-probe-user', characterId: 'memory-probe-character' }
  const open = () => {
    const store = openSessionStore(root, owner, clock); const scheduler = createScheduler(clock); const repository = openMemoryRepository(root, store); const fake = createFakeMemoryModel()
    let calls = 0
    const memory = createMemoryService({ clock, store, scheduler, repository, model: fake.model, development: fake,
      isBusy: () => harness?.isBusy() ?? false, rolled: () => harness.sessionChanged(), changed: () => {} })
    scheduler.cancel('memory.maintenance') // Probe drives maintenance explicitly; avoid advancing through pending microtasks.
    const model: ModelClient = { source: 'fake', complete: async (input) => {
      calls++
      if (input.messages.at(-1)?.content.includes('HOLD_TURN')) await new Promise<void>((resolve) => { clock.after(20_000, resolve) })
      return { text: 'SYNTHETIC_VISIBLE_REPLY', toolCalls: [], usage: { inputTokens: 0, outputTokens: 0 } }
    } }
    const harness = createHarness({ clock, store, model, tools: [], prepareContext: memory.prepareContext, foreground: memory.foreground })
    let closed = false
    return { store, scheduler, repository, fake, memory, harness, calls: () => calls, close: async () => { if (closed) return; closed = true; await Promise.all([memory.close(), harness.dispose()]); scheduler.dispose(); repository.close(); store.close() } }
  }
  let current = open()
  let stage = 0
  const command = (body: Record<string, unknown>) => ({ ...body, protocolVersion: 1, epoch: 'probe', requestId: String(current.store.records().length) } as AppCommand)
  const chat = async (text: string) => { current.harness.send(text, String(current.store.records().length), 'probe'); await current.harness.idle() }
  const extract = async () => { if (current.memory.dispatch(command({ type: 'memory.extract' }))) throw new Error('MEMORY_EXTRACT_REFUSED'); await current.memory.idle() }
  try {
    current.store.append({ type: 'tool/result', turnId: 'private-probe', callId: 'hidden', ok: true, elapsedMs: 1, raw: { source: 'RAW_ONLY_MEMORY_EVIDENCE', output: 'USER_ONLY_DOCUMENT_RESULT' }, visible: { count: 1 } })
    await chat('我把纸桥放在书桌上，给它取名叫周五桥。'); await extract()
    await chat('我喜欢的饮料是咖啡。'); await extract()
    await chat('我喜欢的饮料现在改为红茶，不再喝咖啡。'); await extract()
    stage = 1
    if (!current.repository.view().items.some((item) => item.text.includes('咖啡。') && item.supersededBy) || current.memory.search('饮料', 'query-drink').some((item) => item.text === '我喜欢的饮料是咖啡。')) throw new Error('MEMORY_CORRECTION_FAILED')
    for (let index = 0; index < 4; index++) await chat('合成上下文 ' + index + ' ' + '这是用于验证整回合压缩的可见对话。'.repeat(100))
    const before = current.store.projection().context.length; const oldMessages = JSON.stringify(current.store.projection().messages)
    if (current.memory.dispatch(command({ type: 'context.compact' }))) throw new Error('MEMORY_COMPACT_REFUSED')
    await current.memory.idle()
    if (current.memory.view().status === 'failed' || current.store.projection().context.length >= before || JSON.stringify(current.store.projection().messages) !== oldMessages) throw new Error('MEMORY_COMPACT_FAILED')
    if (/RAW_ONLY_MEMORY_EVIDENCE|USER_ONLY_DOCUMENT_RESULT/.test(JSON.stringify([current.repository.view(), seenFragments(current.store.history!())]))) throw new Error('MEMORY_PRIVATE_LEAK')
    stage = 2
    const oldSession = current.store.scope.sessionId; const oldDay = current.store.dayKey!()
    clock.advanceBy(clock.parse('2026-10-16T03:59:50+08:00') - clock.nowMs())
    const priorCalls = current.calls()
    current.harness.send('HOLD_TURN', 'hold', 'probe'); const pending = current.harness.idle()
    for (let i = 0; i < 20 && current.calls() === priorCalls; i++) await Promise.resolve()
    if (current.calls() === priorCalls) throw new Error('MEMORY_HOLD_NOT_STARTED')
    clock.advanceBy(10_000)
    await current.memory.maintenance()
    if (current.store.scope.sessionId !== oldSession) throw new Error('MEMORY_MIDTURN_ROLL_FAILED')
    clock.advanceBy(20_000); await pending
    current.store.append({ type: 'companion/lights', lightsOut: true, requestId: 'dark', commandHash: 'probe' }); current.memory.stateChanged()
    clock.advanceBy(120_000); await current.memory.maintenance()
    if (current.store.scope.sessionId !== oldSession) throw new Error('MEMORY_LIGHTS_ROLL_FAILED')
    current.store.append({ type: 'companion/lights', lightsOut: false, requestId: 'light', commandHash: 'probe' })
    current.store.append({ type: 'companion/mode', mode: 'quiet', requestId: 'quiet', commandHash: 'probe' })
    current.harness.postEvent('mail', '{"source":"fake","count":1}', 'held-mail')
    stage = 3
    await current.memory.maintenance()
    if (current.store.scope.sessionId === oldSession || current.memory.sessionView().dayKey === oldDay || !current.repository.view().summaries.some((summary) => summary.sourceSessionIds.includes(oldSession))) throw new Error('MEMORY_ROLL_FAILED')
    const folder = journalLocation(root, owner, clock).folder; const oldFile = join(folder, oldDay + '.jsonl'); const oldBytes = readFileSync(oldFile)
    const page = current.memory.readSession(oldSession)
    if (!page.messages.some((message) => message.text.includes('周五桥'))) throw new Error('MEMORY_ARCHIVE_FAILED')
    stage = 4
    if (!current.store.projection().pendingEvents.some((event) => event.id === 'held-mail')) throw new Error('MEMORY_PENDING_FACT_LOST')
    current.store.append({ type: 'companion/mode', mode: 'rest', requestId: 'rest', commandHash: 'probe' }); current.harness.stateChanged(); await current.harness.idle()
    await chat('纸桥'); await chat('我把纸桥放在书桌上，给它取名叫周五桥。'); await extract(); await chat('纸桥')
    if (!current.repository.view().items.some((item) => item.text.includes('周五桥') && item.tier === 'long_term')) throw new Error('MEMORY_PROMOTION_FAILED')
    stage = 41
    const visible = current.store.projection().lastModelContext!
    if (!JSON.stringify(visible).includes('previousDaysReference') || !JSON.stringify(visible).includes('memoryReference') || !JSON.stringify(visible).includes('held-mail') && !JSON.stringify(visible).includes('count')) throw new Error('MEMORY_CONTEXT_ORDER_FAILED')
    stage = 42
    if (!readFileSync(oldFile).equals(oldBytes)) throw new Error('MEMORY_OLD_PAGE_MUTATED')
    stage = 5
    const beforeFault = current.repository.view().keys.length
    current.memory.dispatch(command({ type: 'developer.memory', scenarioId: 'failure' })); await chat('我们约好先完成作业，再一起整理纸桥的照片。'); await extract()
    if (current.memory.view().error?.code !== 'connection-failed' || current.repository.view().keys.length !== beforeFault) throw new Error('MEMORY_FAILURE_FAILED')
    current.memory.dispatch(command({ type: 'developer.memory', scenarioId: 'invalid' })); await extract()
    if (current.memory.view().error?.code !== 'memory-invalid-output') throw new Error('MEMORY_INVALID_FAILED')
    const failedDay = current.store.scope.sessionId
    clock.advanceBy(clock.parse('2026-10-17T04:03:00+08:00') - clock.nowMs()); await current.memory.maintenance()
    if (current.store.scope.sessionId === failedDay || current.memory.view().error?.code !== 'memory-invalid-output' || current.repository.view().summaries.some((summary) => summary.sourceSessionIds.includes(failedDay))) throw new Error('MEMORY_FAILED_DAY_TRAPPED')
    current.memory.dispatch(command({ type: 'developer.memory', scenarioId: 'ready' })); await current.memory.maintenance()
    if (!current.repository.view().summaries.some((summary) => summary.sourceSessionIds.includes(failedDay))) throw new Error('MEMORY_DEFERRED_SUMMARY_FAILED')
    stage = 6
    await current.close()
    const cache = new Database(join(root, 'memory.sqlite')); cache.prepare('UPDATE memory_projection SET state_json=?').run('{}'); cache.close()
    current = open()
    if (!current.repository.view().items.some((item) => item.tier === 'long_term') || current.memory.sessionView().pages.length !== 3) throw new Error('MEMORY_RESTART_FAILED')
    for (const otherOwner of [{ ...owner, characterId: 'other-character' }, { ...owner, userId: 'other-user' }]) {
      const otherStore = openSessionStore(root, otherOwner, clock); const other = openMemoryRepository(root, otherStore)
      try { if (other.view().items.length || other.view().summaries.length) throw new Error('MEMORY_SCOPE_FAILED') } finally { other.close(); otherStore.close() }
    }
    clock.advanceBy(clock.parse('2026-11-03T12:00:00+08:00') - clock.nowMs())
    current.memory.dispatch(command({ type: 'memory.consolidate' })); await current.memory.idle()
    if (!current.memory.view().summaryCounts?.week || !current.memory.view().summaryCounts?.month) throw new Error('MEMORY_HIERARCHY_FAILED')
    const operations = current.store.history!().filter((row) => row.type === 'memory/operation').length
    current.memory.dispatch(command({ type: 'memory.consolidate' })); await current.memory.idle()
    if (current.store.history!().filter((row) => row.type === 'memory/operation').length !== operations) throw new Error('MEMORY_HIERARCHY_REPEATED')
    return { ok: true, probe: 'memory', source: 'fake', seenOnlyExtraction: true, rawPrivateExcluded: true, correctedWithoutDeletion: true, actualSqliteProjection: true,
      contextCompactedChatPreserved: true, noMidturnOrLightsRollover: true, sameProcessDailyRollover: true, priorSummaryAndRecall: true,
      longTermPromotion: true, oldPageUnchanged: true, pendingFactsCarried: true, failureClosed: true, failedDayRolloverAndDeferredSummary: true, restartAndCacheRebuild: true, userAndCharacterIsolated: true, closedWeekMonthIdempotent: true }
  } catch { return { ok: false, probe: 'memory', stage } } finally { await current.close() }
}
