import { createManualClock } from '../clock'
import { createScheduler } from '../scheduler'
import { openSessionStore } from '../store/session'
import { createLife } from '../life/service'
import type { AppCommand } from '../../shared'
import { join } from 'node:path'
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
    probeProposalBoundary(join(root, 'proposals')); probeArrivalDay(join(root, 'arrival-day'))
    return { ok: true, probe: 'life', actualSqlite: true, deterministicOuting: true, returnedItemProvenance: true, restartRetained: true, restoredGapSkipped: true, expiredProposalAfterDailyReopen: true, singleDeparture: true, completedArrivalDaySettled: true, offlineRestartDeduplicated: true }
  } finally { life.close(); scheduler.dispose(); store.close() }
}

function probeProposalBoundary(root: string) {
  const clock = createManualClock(0); clock.advanceBy(clock.parse('2026-10-17T10:00:00+08:00')); const owner = { userId: 'life-proposal', characterId: 'character' }
  let store = openSessionStore(root, owner, clock); let scheduler = createScheduler(clock)
  const open = () => { const result = createLife({ store, clock, scheduler, working: () => false, changed: () => {}, emit: () => {} }); scheduler.cancel('life.settle'); return result }
  let life = open(); const send = (body: Record<string, unknown>) => life.dispatch({ ...body, protocolVersion: 1, requestId: 'probe', epoch: 'probe' } as AppCommand)
  try {
    send({ type: 'life.propose' }); const oldId = life.view().outings[0].id
    clock.advanceBy(7 * 3600000); life.close(); scheduler.dispose(); store.close()
    clock.advanceBy(22 * 3600000); store = openSessionStore(root, owner, clock); scheduler = createScheduler(clock)
    store.append({ type: 'user/message', id: 'present', text: 'SYNTHETIC_PRESENT', requestId: 'present', commandHash: 'probe' }); life = open()
    const proposed = life.view().outings.find((outing) => outing.status === 'proposed')
    if (life.view().outings.find((outing) => outing.id === oldId)?.status !== 'cancelled' || !proposed) throw new Error('LIFE_PROPOSAL_EXPIRY_FAILED')
    if (send({ type: 'life.depart', outingId: proposed.id }) || send({ type: 'life.depart', outingId: oldId }) !== 'unavailable' || life.view().outings.filter((outing) => outing.status === 'away').length !== 1) throw new Error('LIFE_SINGLE_DEPARTURE_FAILED')
    life.foreground(); if (life.view().outings.some((outing) => outing.status === 'away') || life.view().locationId !== 'room' || life.view().items.length) throw new Error('LIFE_RETURN_CONSISTENCY_FAILED')
  } finally { life.close(); scheduler.dispose(); store.close() }
}

function probeArrivalDay(root: string) {
  const clock = createManualClock(0); clock.advanceBy(clock.parse('2026-10-17T17:00:00+08:00')); const owner = { userId: 'life-arrival', characterId: 'character' }
  let store = openSessionStore(root, owner, clock); let scheduler = createScheduler(clock)
  const open = () => { const result = createLife({ store, clock, scheduler, working: () => false, changed: () => {}, emit: () => {} }); scheduler.cancel('life.settle'); return result }
  let life = open()
  try {
    // Keep Saturday's online proposal: it expires independently of Sunday's offline trip.
    life.close(); scheduler.dispose(); store.close(); clock.advanceBy(23 * 3600000)
    store = openSessionStore(root, owner, clock); scheduler = createScheduler(clock); life = open()
    const outing = life.view().outings.find((entry) => entry.offline)
    if (!outing || outing.startsAtMs !== clock.parse('2026-10-18T15:00:00+08:00') || outing.returnsAtMs !== clock.nowMs() || outing.status !== 'returned' || life.view().items.length !== 1 || life.view().locationId !== 'room') throw new Error('LIFE_ARRIVAL_DAY_FAILED')
    const items = JSON.stringify(life.view().items); const outings = JSON.stringify(life.view().outings); life.close(); scheduler.dispose(); store.close()
    store = openSessionStore(root, owner, clock); scheduler = createScheduler(clock); life = open()
    if (JSON.stringify(life.view().items) !== items || JSON.stringify(life.view().outings) !== outings) throw new Error('LIFE_OFFLINE_REPLAYED')
  } finally { life.close(); scheduler.dispose(); store.close() }
}
