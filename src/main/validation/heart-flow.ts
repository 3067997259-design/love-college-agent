import { createManualClock, systemClock } from '../clock'
import { createScheduler } from '../scheduler'
import { openSessionStore } from '../store/session'
import { createDesk } from '../heart-flow/desk'
import { createHeartFlow, deskTools } from '../heart-flow/service'
import { createHarness } from '../harness/loop'
import { runIsolatedJavaScript } from '../heart-flow/runner'
import { join } from 'node:path'
import type { AppCommand } from '../../shared'
export async function probeHeartFlow(root: string) {
  const clock = createManualClock(1000); const scheduler = createScheduler(clock); const owner = { userId: 'flow-probe', characterId: 'flow-character' }; let store = openSessionStore(root, owner, clock)
  const desk = createDesk(join(root, 'desk')); const open = () => createHeartFlow({ store, clock, desk, booth: false, busy: () => false, changed: () => {}, prepare: async () => ({ messages: [], eligibleIndexes: [] }), emit: () => {}, run: (code, signal) => runIsolatedJavaScript(code, systemClock, signal) }); let flow = open()
  const send = (body: Record<string, unknown>) => flow.dispatch({ ...body, protocolVersion: 1, requestId: 'probe', epoch: 'probe' } as AppCommand)
  const enter = async () => { if (send({ type: 'flow.enter' })) throw new Error('FLOW_ENTRY_REFUSED'); await new Promise<void>((done) => systemClock.after(0, done)); if (!flow.active()) throw new Error('FLOW_ENTRY_FAILED') }
  try {
    await enter(); send({ type: 'flow.mode', mode: 'execute' })
    const changed = flow.write('result.js', 'return 42'); if (desk.read('result.js') !== 'return 42') throw new Error('WRITE_FAILED')
    if (send({ type: 'flow.undo', changeId: changed }) || desk.read('result.js') !== null) throw new Error('UNDO_FAILED')
    const output = await runIsolatedJavaScript('let network = false; try { await fetch("https://example.com") } catch { network = true }; return { value: 6*7, require: typeof require, process: typeof process, window: typeof window, rtc: typeof RTCPeerConnection, networkBlocked: network }', systemClock, new AbortController().signal)
    const result = JSON.parse(output)
    if (result.value !== 42 || result.require !== 'undefined' || result.process !== 'undefined' || result.window !== 'undefined' || result.rtc !== 'undefined' || !result.networkBlocked) throw new Error('ISOLATION_FAILED')
    let timedOut = false
    try { await runIsolatedJavaScript('while(true) {}', systemClock, new AbortController().signal) } catch { timedOut = true }
    if (!timedOut) throw new Error('TIMEOUT_FAILED')
    const user = (id: string, text = id) => { store.append({ type: 'user/message', id, text, requestId: id, commandHash: 'probe' }); store.append({ type: 'inbox/drain', ids: [id] }) }
    for (let index = 0; index < 30; index++) user('old-work-' + index)
    send({ type: 'flow.compact' }); user('YESTERDAY_AFTER_COMPACT')
    const crossDayRun = { id: 'cross-day-run', flowId: flow.view().activeId!, codeHash: 'a'.repeat(64) }
    store.append({ type: 'flow/run', ...crossDayRun, status: 'requested' }); store.append({ type: 'flow/run', ...crossDayRun, status: 'approved' })
    clock.advanceBy(86400000); store.rotate?.(); store.append({ type: 'flow/run', ...crossDayRun, status: 'completed' }); flow.close(); store.close()
    store = openSessionStore(root, owner, clock); flow = open(); user('TODAY_WORK')
    const completedRun = store.history!().findLast((row) => row.type === 'flow/run' && row.id === crossDayRun.id)
    if (completedRun?.type !== 'flow/run' || completedRun.status !== 'completed') throw new Error('FLOW_RUN_ORDER_FAILED')
    const prepared = await flow.prepareContext('today', new AbortController().signal)
    if (!JSON.stringify(prepared.messages).includes('YESTERDAY_AFTER_COMPACT') || !JSON.stringify(prepared.messages).includes('TODAY_WORK') || prepared.eligibleIndexes.length) throw new Error('FLOW_CROSS_DAY_FAILED')
    const workSeq = store.records().find((row) => row.type === 'user/message' && row.id === 'TODAY_WORK')!.seq
    for (let index = 0; index < 12; index++) {
      flow.write('d'.repeat(60) + '/' + 'f'.repeat(60) + index + '.txt', 'PRIVATE_WORK_SOURCE')
      store.append({ type: 'flow/run', id: 'run-'.padEnd(34, 'x') + index, flowId: flow.view().activeId!, status: 'completed', codeHash: 'a'.repeat(64) })
    }
    flow.close(); store.close(); store = openSessionStore(root, owner, clock); flow = open()
    if (send({ type: 'flow.exit' }) || flow.active()) throw new Error('FLOW_BOUNDED_EXIT_FAILED')
    const closed = store.records().findLast((row) => row.type === 'flow/close')
    if (closed?.type !== 'flow/close' || closed.summary.length > 2000 || JSON.parse(closed.summary).fileCount !== 14 || closed.summary.includes('PRIVATE_WORK_SOURCE')) throw new Error('FLOW_EXIT_EVIDENCE_FAILED')
    user('TODAY_WORK')
    const normalSeq = store.records().findLast((row) => row.type === 'user/message')!.seq; const allowed = flow.normalEntriesAllowed([workSeq, normalSeq])
    if (allowed.has(workSeq) || !allowed.has(normalSeq)) throw new Error('FLOW_NORMAL_REPLAY_FAILED')
    // Reopened #2: compact only AFTER reopening a new day with low local seq. Test both with and
    // without old-day writes, then cross a third page and trigger the actual automatic 80k branch.
    for (const withOldWrite of [false, true]) {
      await enter(); send({ type: 'flow.mode', mode: 'execute' })
      if (withOldWrite) flow.write('old-day.txt', 'PRIVATE_OLD_DAY')
      const openingSeq = store.history!().findLast((row) => row.type === 'flow/open')!.seq
      flow.close(); store.close(); clock.advanceBy(86400000); store = openSessionStore(root, owner, clock); flow = open()
      const newWrite = flow.write('new-day.txt', 'PRIVATE_NEW_DAY'); user('NEW_DAY_WORK_REQUEST')
      const newSeq = store.records().find((row) => row.type === 'desk/change' && row.id === newWrite)!.seq
      if (newSeq >= openingSeq) throw new Error('LOW_SEQ_FIXTURE_FAILED')
      send({ type: 'flow.compact' })
      let prepared = await flow.prepareContext('manual-new-day', new AbortController().signal)
      const includes = (messages: unknown, id: string, path: string) => JSON.stringify(messages).includes(id) && JSON.stringify(messages).includes(path)
      if (!includes(prepared.messages, newWrite, 'new-day.txt')) throw new Error('FLOW_NEW_DAY_COMPACT_FAILED')
      const checkpoint = store.records().findLast((row) => row.type === 'flow/compact')
      if (checkpoint?.type !== 'flow/compact' || !includes(checkpoint.summary, newWrite, 'new-day.txt')) throw new Error('FLOW_NEW_DAY_EVIDENCE_FAILED')
      flow.close(); store.close(); clock.advanceBy(86400000); store = openSessionStore(root, owner, clock); flow = open()
      const thirdWrite = flow.write('third-day.txt', 'PRIVATE_THIRD_DAY')
      for (let index = 0; index < 5; index++) user('auto-' + withOldWrite + '-' + index, 'AUTOMATIC_REQUEST_' + index + 'x'.repeat(18000))
      prepared = await flow.prepareContext('auto-third-day', new AbortController().signal)
      if (!includes(prepared.messages, newWrite, 'new-day.txt') || !includes(prepared.messages, thirdWrite, 'third-day.txt') || !JSON.stringify(prepared.messages).includes('AUTOMATIC_REQUEST_4') || JSON.stringify(prepared.messages).includes('PRIVATE_THIRD_DAY') || prepared.eligibleIndexes.length) throw new Error('FLOW_AUTO_COMPACT_EVIDENCE_FAILED')
      send({ type: 'flow.exit' })
    }
    await enter(); send({ type: 'flow.mode', mode: 'execute' }); flow.write('multi-input.md', 'SYNTHETIC_INPUT')
    for (let index = 0; index < 6; index++) user('multi-old-' + index, 'old'.repeat(6000))
    flow.close(); store.close(); clock.advanceBy(86400000); store = openSessionStore(root, owner, clock); flow = open()
    let modelSteps = 0; const requestSeen: boolean[] = []
    const harness = createHarness({ store, clock, tools: deskTools(flow), prepareContext: flow.prepareContext, model: { source: 'fake', complete: async (request) => {
      requestSeen.push(JSON.stringify(request.messages).includes('NATIVE_CURRENT_REQUEST_CANARY')); const step = modelSteps++
      return { text: step === 2 ? 'Synthetic multi-step finished.' : '', usage: { inputTokens: 0, outputTokens: 0 }, toolCalls: step < 2 ? [{ id: 'native-step-' + step, name: step === 0 ? 'desk_read' : 'desk_write', arguments: JSON.stringify(step === 0 ? { path: 'multi-input.md' } : { path: 'multi-result.md', text: 'SYNTHETIC_MULTI_PRODUCT' }) }] : [] }
    } } })
    try { harness.send('NATIVE_CURRENT_REQUEST_CANARY: read multi-input.md then write multi-result.md', 'native-current', 'probe'); await harness.idle() } finally { await harness.dispose() }
    if (modelSteps !== 3 || requestSeen.some((seen) => !seen) || desk.read('multi-result.md') !== 'SYNTHETIC_MULTI_PRODUCT') throw new Error('FLOW_MULTI_STEP_REQUEST_LOST')
    flow.close(); store.close(); store = openSessionStore(root, owner, clock); flow = open()
    if (!JSON.stringify((await flow.prepareContext('reopened-multi', new AbortController().signal)).messages).includes('NATIVE_CURRENT_REQUEST_CANARY')) throw new Error('FLOW_RETAINED_RESTART_FAILED')
    send({ type: 'flow.exit' })
    send({ type: 'flow.goal.set', text: 'WORK_GOAL_ONLY' }); const goalId = flow.view().goalId!
    await enter(); const firstGoalFlow = flow.view().activeId!
    const beforeGoal = await flow.prepareContext('goal', new AbortController().signal)
    if (!JSON.stringify(beforeGoal.messages).includes('WORK_GOAL_ONLY') || beforeGoal.eligibleIndexes.length) throw new Error('GOAL_WORK_CONTEXT_FAILED')
    flow.close(); store.close(); clock.advanceBy(86400000); store = openSessionStore(root, owner, clock); flow = open()
    if (flow.view().goalId !== goalId || flow.view().goals?.[0]?.text !== 'WORK_GOAL_ONLY') throw new Error('GOAL_RESTART_FAILED')
    send({ type: 'flow.exit' }); send({ type: 'flow.resume', flowId: firstGoalFlow })
    if (flow.view().goals?.[0]?.flowIds.length !== 2 || flow.view().mode !== 'plan') throw new Error('GOAL_FLOW_LINK_FAILED')
    send({ type: 'flow.goal.status', goalId, status: 'completed' }); flow.close(); store.close(); store = openSessionStore(root, owner, clock); flow = open()
    if (flow.view().goals?.[0]?.status !== 'completed' || flow.view().goals?.[0]?.confirmedBy !== 'user') throw new Error('GOAL_USER_STATUS_FAILED')
    const foreign = openSessionStore(root, { ...owner, characterId: 'other-character' }, clock)
    try {
      const other = createHeartFlow({ store: foreign, clock, desk, booth: false, busy: () => false, changed: () => {}, prepare: async () => ({ messages: [], eligibleIndexes: [] }), emit: () => {}, run: async () => '' })
      if (other.view().goals?.length) throw new Error('GOAL_SCOPE_FAILED'); other.close()
    } finally { foreign.close() }
    return { ok: true, probe: 'heart-flow', actualSqlite: true, deskUndo: true, noNodeOrBridge: true, networkBlocked: true, infiniteLoopTerminated: true, compactedCrossDayRestart: true, crossDayCompletedRunNotInterrupted: true, compactAfterReopeningLowSeqDay: true, multipleDayAutomaticCompactHasEvidenceAndRequest: true, realHarnessMultiStepRetainsRequestAcrossCompactAndRestart: true, normalReplayExcludesWorkByPosition: true, longPathExitAfterRestart: true, scopedGoalsAcrossDaysAndFlows: true, goalStatusIsUserConfirmed: true }
  } finally { flow.close(); scheduler.dispose(); store.close() }
}
