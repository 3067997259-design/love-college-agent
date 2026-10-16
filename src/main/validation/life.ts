import { createManualClock } from '../clock'
import { createScheduler } from '../scheduler'
import { openSessionStore } from '../store/session'
import { createLife } from '../life/service'
import type { AppCommand } from '../../shared'
export function probeLife(root: string) {
  const clock = createManualClock(0); clock.advanceBy(clock.parse('2026-10-17T10:00:00+08:00')); const owner = { userId: 'life-probe', characterId: 'life-character' }
  let store = openSessionStore(root, owner, clock); let scheduler = createScheduler(clock)
  const open = (restored = false) => { const service = createLife({ store, clock, scheduler, working: () => false, changed: () => {}, emit: () => {}, restored }); scheduler.cancel('life.settle'); return service }
  let life = open(); const command = (body: Record<string, unknown>) => life.dispatch({ ...body, epoch: 'probe', protocolVersion: 1, requestId: 'probe' } as AppCommand)
  try {
    command({ type: 'life.propose', place: 'coast' }); command({ type: 'life.depart', outingId: life.view().outings[0].id }); clock.advanceBy(60 * 60000); life.reconcile()
    if (life.view().items[0]?.kind !== 'shell') throw new Error('LIFE_ITEM_FAILED')
    const item = life.view().items[0]; life.close(); scheduler.dispose(); store.close(); clock.advanceBy(30 * 86400000)
    store = openSessionStore(root, owner, clock); scheduler = createScheduler(clock); life = open(true)
    if (life.view().locationId !== 'room' || life.view().items.length !== 1 || JSON.stringify(life.view().items[0]) !== JSON.stringify(item) || life.view().settledUntilMs !== clock.nowMs()) throw new Error('LIFE_RESTORE_GAP_FAILED')
    return { ok: true, probe: 'life', actualSqlite: true, deterministicOuting: true, returnedItemProvenance: true, restartRetained: true, restoredGapSkipped: true }
  } finally { life.close(); scheduler.dispose(); store.close() }
}
