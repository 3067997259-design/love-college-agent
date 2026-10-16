import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { createManualClock } from '../../src/main/clock'
import { openJournal } from '../../src/main/journal/file'
import { projectJournal } from '../../src/main/journal/projection'
import { createScheduler } from '../../src/main/scheduler'
import { createLife } from '../../src/main/life/service'
import type { SessionStore } from '../../src/main/store/session'
import type { AppCommand } from '../../src/shared'
const cleanups: (() => void)[] = []
afterEach(() => cleanups.splice(0).reverse().forEach((cleanup) => cleanup()))
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'lca-life-')); cleanups.push(() => { if (!resolve(root).startsWith(join(resolve(tmpdir()), 'lca-life-'))) throw new Error('UNSAFE'); rmSync(root, { recursive: true, force: true }) })
  const clock = createManualClock(0); clock.advanceBy(clock.parse('2026-10-17T10:00:00+08:00')); const journal = openJournal(root, { userId: 'u', characterId: 'c' }, clock)
  const store: SessionStore = { scope: journal.scope, records: journal.records, append: journal.append, projection: () => projectJournal(journal.records()), close: journal.close }
  const scheduler = createScheduler(clock); let working = false; const emit = vi.fn(); const options = { store, clock, scheduler, working: () => working, emit, changed: () => {} }
  const life = createLife(options); scheduler.cancel('life.settle'); cleanups.push(store.close); cleanups.push(scheduler.dispose)
  const dispatch = (body: Record<string, unknown>) => life.dispatch({ ...body, protocolVersion: 1, epoch: 'x', requestId: 'x' } as AppCommand)
  return { clock, store, life, scheduler, options, emit, dispatch, busy: (value: boolean) => { working = value } }
}
it('codes the full outing at departure and returns empty-handed before acquisition', () => {
  const f = fixture(); f.dispatch({ type: 'life.propose', place: 'coast' }); const outing = f.life.view().outings[0]
  expect(f.life.view().agenda.find((item) => item.kind === 'read')?.state).toBe('skipped')
  expect(f.life.view().locationId).toBe('room'); f.dispatch({ type: 'life.depart', outingId: outing.id }); expect(f.life.view().locationId).toBe('coast')
  f.clock.advanceBy(10 * 60000); f.life.foreground(); expect(f.life.view().locationId).toBe('room'); expect(f.life.view().items).toHaveLength(0)
  expect(f.life.view().outings[0].status).toBe('cut_short')
})
it('settles once with provenance; work and lights override fiction', () => {
  const f = fixture(); f.dispatch({ type: 'life.propose', place: 'swing' }); f.dispatch({ type: 'life.depart', outingId: f.life.view().outings[0].id }); f.clock.advanceBy(60 * 60000); f.life.reconcile(); f.life.reconcile()
  expect(f.life.view().items).toHaveLength(1); expect(f.emit).toHaveBeenCalledOnce(); expect(f.life.view().items[0].outingId).toBe(f.life.view().outings[0].id)
  f.busy(true); expect(f.dispatch({ type: 'life.propose' })).toBe('unavailable')
  f.store.append({ type: 'companion/lights', lightsOut: true, requestId: 'off', commandHash: 'x' }); const count = f.life.view().items.length; f.clock.advanceBy(10 * 86400000); f.life.reconcile(); expect(f.life.view().items).toHaveLength(count)
})
it('bounds offline fiction, does not replay it, and skips the restored archive gap', () => {
  const f = fixture(); f.clock.advanceBy(15 * 86400000)
  const offline = createLife(f.options); f.scheduler.cancel('life.settle'); const view = offline.view()
  expect(view.outings.filter((outing) => outing.offline).length).toBeLessThanOrEqual(3); expect(view.outings.length).toBeGreaterThan(0)
  expect(createLife(f.options).view().items).toEqual(view.items); f.scheduler.cancel('life.settle')
  f.clock.advanceBy(100 * 86400000); const restored = createLife({ ...f.options, restored: true }); f.scheduler.cancel('life.settle')
  expect(restored.view().items).toEqual(view.items); expect(restored.view().settledUntilMs).toBe(f.clock.nowMs()); expect(restored.view().locationId).toBe('room')
})
