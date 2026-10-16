import { createManualClock, systemClock } from '../clock'
import { createScheduler } from '../scheduler'
import { openSessionStore } from '../store/session'
import { createDesk } from '../heart-flow/desk'
import { createHeartFlow } from '../heart-flow/service'
import { runIsolatedJavaScript } from '../heart-flow/runner'
import { join } from 'node:path'
import type { AppCommand } from '../../shared'
export async function probeHeartFlow(root: string) {
  const clock = createManualClock(1000); const scheduler = createScheduler(clock); const store = openSessionStore(root, { userId: 'flow-probe', characterId: 'flow-character' }, clock)
  const desk = createDesk(join(root, 'desk')); const flow = createHeartFlow({ store, clock, desk, booth: false, busy: () => false, changed: () => {}, prepare: async () => ({ messages: [], eligibleIndexes: [] }), emit: () => {}, run: (code, signal) => runIsolatedJavaScript(code, systemClock, signal) })
  const send = (body: Record<string, unknown>) => flow.dispatch({ ...body, protocolVersion: 1, requestId: 'probe', epoch: 'probe' } as AppCommand)
  try {
    send({ type: 'flow.enter' }); await Promise.resolve(); await Promise.resolve(); send({ type: 'flow.mode', mode: 'execute' })
    const changed = flow.write('result.js', 'return 42'); if (desk.read('result.js') !== 'return 42') throw new Error('WRITE_FAILED')
    if (send({ type: 'flow.undo', changeId: changed }) || desk.read('result.js') !== null) throw new Error('UNDO_FAILED')
    const output = await runIsolatedJavaScript('let network = false; try { await fetch("https://example.com") } catch { network = true }; return { value: 6*7, require: typeof require, process: typeof process, bridge: typeof window.lca, networkBlocked: network }', systemClock, new AbortController().signal)
    const result = JSON.parse(output)
    if (result.value !== 42 || result.require !== 'undefined' || result.process !== 'undefined' || result.bridge !== 'undefined' || !result.networkBlocked) throw new Error('ISOLATION_FAILED')
    let timedOut = false
    try { await runIsolatedJavaScript('while(true) {}', systemClock, new AbortController().signal) } catch { timedOut = true }
    if (!timedOut) throw new Error('TIMEOUT_FAILED')
    return { ok: true, probe: 'heart-flow', actualSqlite: true, deskUndo: true, noNodeOrBridge: true, networkBlocked: true, infiniteLoopTerminated: true }
  } finally { flow.close(); scheduler.dispose(); store.close() }
}
