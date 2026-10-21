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
import { seenFragments } from '../memory/seen'
import { createDshExecution } from '../dsh/execution'
import type { DshEvent, DshHostOptions, startDshHost } from '../dsh/host'

const settle = () => new Promise<void>((resolve) => { setImmediate(resolve) })
/**
 * Her DSH session as a script: every message or event she is given opens a turn in which she answers once; HOLD_TURN
 * keeps that turn open for 20 s of probe time. What she was given is kept, with the references beside it.
 */
function scriptedDsh(clock: ReturnType<typeof createManualClock>) {
  const sent: { text: string; reference: string | null }[] = []
  let host: DshHostOptions | undefined; let turns = Promise.resolve(); let opened = 0; let calls = 0
  const launch = ((options: DshHostOptions) => {
    host = options
    return { started: Promise.resolve(), open: async (_cwd: string, sessionId?: string) => sessionId ?? 'memory-probe-dsh-' + ++opened,
      send: (sessionId: string, text: string, mode = 'followup', reference: string | null = null) => {
        sent.push({ text, reference })
        const emit = (event: Omit<DshEvent, 'sessionId'>) => host!.onEvent({ sessionId, ...event } as DshEvent)
        if (mode === 'steer') { emit({ t: 'user-message' }); return }
        turns = turns.then(async () => {
          emit({ t: 'turn-start', turn: 1 }); calls++
          if (text.includes('HOLD_TURN')) await new Promise<void>((resolve) => { clock.after(20_000, resolve) })
          emit({ t: 'message', text: 'SYNTHETIC_VISIBLE_REPLY', toolCalls: [] })
          emit({ t: 'turn-end', turn: 1, reason: { kind: 'completed' } })
        })
      },
      cancel: () => {}, tools: () => {}, trust: () => {}, untrust: () => {}, efforts: () => {}, describe: async () => null, close: async () => 0 }
  }) as unknown as typeof startDshHost
  // A message reaches the host only after its session opens: let that happen, then wait for her turns.
  const idle = async () => { let last: Promise<void>; do { last = turns; await settle(); await turns; await settle() } while (last !== turns) }
  return { launch, sent, calls: () => calls, idle }
}

export async function probeMemory(root: string) {
  const clock = createManualClock(0); clock.advanceBy(clock.parse('2026-10-16T03:50:00+08:00'))
  const owner = { userId: 'memory-probe-user', characterId: 'memory-probe-character' }
  const open = () => {
    const store = openSessionStore(root, owner, clock); const scheduler = createScheduler(clock); const repository = openMemoryRepository(root, store); const fake = createFakeMemoryModel()
    const dsh = scriptedDsh(clock)
    const memory = createMemoryService({ clock, store, scheduler, repository, model: fake.model, development: fake,
      isBusy: () => execution.busy(), rolled: () => execution.stateChanged(), changed: () => {} })
    scheduler.cancel('memory.maintenance') // Probe drives maintenance explicitly; avoid advancing through pending microtasks.
    // The same references the book gives her (index.ts): memories matching your last three lines, earlier days with a new session.
    const lines = () => store.projection().messages.filter((message) => message.role === 'user' && !message.kind).slice(-3).map((message) => message.text).join('\n')
    const execution = createDshExecution({ store, clock, dataDir: root, dshRoot: 'unused', bridge: 'unused', guardedRoots: [], source: 'fake',
      routes: { env: {}, chat: { provider: 'memory-probe', model: 'synthetic' }, work: { provider: 'memory-probe', model: 'synthetic' } },
      project: () => join(root, 'probe-project'), persona: () => '', suffix: () => '', tools: () => [], ask: async () => null, changed: () => {}, launch: dsh.launch,
      reference: ({ requestId, firstOfSession }) => memory.reference(lines(), requestId, firstOfSession), foreground: memory.foreground })
    let closed = false
    return { store, scheduler, repository, fake, memory, execution, dsh, close: async () => { if (closed) return; closed = true; await Promise.all([memory.close(), execution.close()]); scheduler.dispose(); repository.close(); store.close() } }
  }
  let current = open()
  let stage = 0
  const command = (body: Record<string, unknown>) => ({ ...body, protocolVersion: 1, epoch: 'probe', requestId: String(current.store.records().length) } as AppCommand)
  const chat = async (text: string) => { current.execution.send(text, String(current.store.records().length), 'probe'); await current.dsh.idle() }
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
    const priorCalls = current.dsh.calls()
    current.execution.send('HOLD_TURN', 'hold', 'probe'); const pending = current.dsh.idle()
    for (let i = 0; i < 20 && current.dsh.calls() === priorCalls; i++) await settle()
    if (current.dsh.calls() === priorCalls) throw new Error('MEMORY_HOLD_NOT_STARTED')
    clock.advanceBy(10_000)
    await current.memory.maintenance()
    if (current.store.scope.sessionId !== oldSession) throw new Error('MEMORY_MIDTURN_ROLL_FAILED')
    clock.advanceBy(20_000); await pending
    current.store.append({ type: 'companion/lights', lightsOut: true, requestId: 'dark', commandHash: 'probe' }); current.memory.stateChanged()
    clock.advanceBy(120_000); await current.memory.maintenance()
    if (current.store.scope.sessionId !== oldSession) throw new Error('MEMORY_LIGHTS_ROLL_FAILED')
    current.store.append({ type: 'companion/lights', lightsOut: false, requestId: 'light', commandHash: 'probe' })
    current.store.append({ type: 'companion/mode', mode: 'quiet', requestId: 'quiet', commandHash: 'probe' })
    current.execution.postEvent('mail', '{"source":"fake","count":1}', 'held-mail')
    stage = 3
    await current.memory.maintenance()
    if (current.store.scope.sessionId === oldSession || current.memory.sessionView().dayKey === oldDay || !current.repository.view().summaries.some((summary) => summary.sourceSessionIds.includes(oldSession))) throw new Error('MEMORY_ROLL_FAILED')
    const folder = journalLocation(root, owner, clock).folder; const oldFile = join(folder, oldDay + '.jsonl'); const oldBytes = readFileSync(oldFile)
    const page = current.memory.readSession(oldSession)
    if (!page.messages.some((message) => message.text.includes('周五桥'))) throw new Error('MEMORY_ARCHIVE_FAILED')
    stage = 4
    if (!current.store.projection().pendingEvents.some((event) => event.id === 'held-mail')) throw new Error('MEMORY_PENDING_FACT_LOST')
    const afterRoll = current.dsh.sent.length
    current.store.append({ type: 'companion/mode', mode: 'rest', requestId: 'rest', commandHash: 'probe' }); current.execution.stateChanged(); await current.dsh.idle()
    await chat('纸桥'); await chat('我把纸桥放在书桌上，给它取名叫周五桥。'); await extract(); await chat('纸桥')
    if (!current.repository.view().items.some((item) => item.text.includes('周五桥') && item.tier === 'long_term')) throw new Error('MEMORY_PROMOTION_FAILED')
    stage = 41
    // What her new day's session was given: the held mail fact, earlier days with its first message, matching memories.
    const given = JSON.stringify(current.dsh.sent.slice(afterRoll))
    if (!given.includes('previousDaysReference') || !given.includes('memoryReference') || !given.includes('count')) throw new Error('MEMORY_CONTEXT_ORDER_FAILED')
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
