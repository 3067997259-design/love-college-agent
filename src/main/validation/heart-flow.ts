import { createManualClock, systemClock } from '../clock'
import { createScheduler } from '../scheduler'
import { openSessionStore } from '../store/session'
import { createDesk } from '../heart-flow/desk'
import { createHeartFlow } from '../heart-flow/service'
import { runIsolatedJavaScript } from '../heart-flow/runner'
import { join } from 'node:path'
import type { AppCommand } from '../../shared'
export async function probeHeartFlow(root: string) {
  const clock = createManualClock(1000); const scheduler = createScheduler(clock); const owner = { userId: 'flow-probe', characterId: 'flow-character' }; let store = openSessionStore(root, owner, clock)
  const desk = createDesk(join(root, 'desk')); const open = () => createHeartFlow({ store, clock, desk, booth: false, busy: () => false, changed: () => {}, prepare: async () => ({ messages: [], eligibleIndexes: [] }), emit: () => {}, run: (code, signal) => runIsolatedJavaScript(code, systemClock, signal) }); let flow = open()
  const send = (body: Record<string, unknown>) => flow.dispatch({ ...body, protocolVersion: 1, requestId: 'probe', epoch: 'probe' } as AppCommand)
  try {
    send({ type: 'flow.enter' }); await Promise.resolve(); await Promise.resolve(); send({ type: 'flow.mode', mode: 'execute' })
    const changed = flow.write('result.js', 'return 42'); if (desk.read('result.js') !== 'return 42') throw new Error('WRITE_FAILED')
    if (send({ type: 'flow.undo', changeId: changed }) || desk.read('result.js') !== null) throw new Error('UNDO_FAILED')
    const output = await runIsolatedJavaScript('let network = false; try { await fetch("https://example.com") } catch { network = true }; return { value: 6*7, require: typeof require, process: typeof process, window: typeof window, rtc: typeof RTCPeerConnection, networkBlocked: network }', systemClock, new AbortController().signal)
    const result = JSON.parse(output)
    if (result.value !== 42 || result.require !== 'undefined' || result.process !== 'undefined' || result.window !== 'undefined' || result.rtc !== 'undefined' || !result.networkBlocked) throw new Error('ISOLATION_FAILED')
    let timedOut = false
    try { await runIsolatedJavaScript('while(true) {}', systemClock, new AbortController().signal) } catch { timedOut = true }
    if (!timedOut) throw new Error('TIMEOUT_FAILED')
    const user = (id: string) => { store.append({ type: 'user/message', id, text: id, requestId: id, commandHash: 'probe' }); store.append({ type: 'inbox/drain', ids: [id] }) }
    for (let index = 0; index < 30; index++) user('old-work-' + index)
    send({ type: 'flow.compact' }); user('YESTERDAY_AFTER_COMPACT'); flow.close(); store.close(); clock.advanceBy(86400000)
    store = openSessionStore(root, owner, clock); flow = open(); user('TODAY_WORK')
    const prepared = await flow.prepareContext('today', new AbortController().signal)
    if (!JSON.stringify(prepared.messages).includes('YESTERDAY_AFTER_COMPACT') || !JSON.stringify(prepared.messages).includes('TODAY_WORK') || prepared.eligibleIndexes.length) throw new Error('FLOW_CROSS_DAY_FAILED')
    const workSeq = store.records().find((row) => row.type === 'user/message' && row.id === 'TODAY_WORK')!.seq
    send({ type: 'flow.exit' }); user('TODAY_WORK')
    const normalSeq = store.records().findLast((row) => row.type === 'user/message')!.seq; const allowed = flow.normalEntriesAllowed([workSeq, normalSeq])
    if (allowed.has(workSeq) || !allowed.has(normalSeq)) throw new Error('FLOW_NORMAL_REPLAY_FAILED')
    return { ok: true, probe: 'heart-flow', actualSqlite: true, deskUndo: true, noNodeOrBridge: true, networkBlocked: true, infiniteLoopTerminated: true, compactedCrossDayRestart: true, normalReplayExcludesWorkByPosition: true }
  } finally { flow.close(); scheduler.dispose(); store.close() }
}
