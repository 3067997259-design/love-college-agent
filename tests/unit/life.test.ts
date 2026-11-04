import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { createManualClock } from '../../src/main/clock'
import { openJournal } from '../../src/main/journal/file'
import { projectJournal } from '../../src/main/journal/projection'
import { createScheduler } from '../../src/main/scheduler'
import { createLife } from '../../src/main/life/service'
import { idleTimer } from '../../src/main/pomodoro/schema'
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
  const event = JSON.parse(f.emit.mock.calls[0][1])
  expect(event.fictionalOuting.statusMeaning).toBe('提前结束并已返回')
  expect(event.fictionalOuting.broughtItems).toEqual([])
  expect(event.fictionalOuting).not.toHaveProperty('item')
  expect(event.broughtItem).toBeNull()
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
it('expires yesterday proposals before today scheduling and rejects stale confirmations', () => {
  const f = fixture(); f.dispatch({ type: 'life.propose', place: 'coast' }); const oldId = f.life.view().outings[0].id
  f.clock.advanceBy(f.clock.parse('2026-10-18T15:00:00+08:00') - f.clock.nowMs())
  f.store.append({ type: 'user/message', id: 'present', text: '在这里', requestId: 'present', commandHash: 'x' }); f.life.reconcile()
  expect(f.life.view().outings.find((outing) => outing.id === oldId)?.status).toBe('cancelled')
  // You are here, so she does not head out by herself; today's outing is your proposal.
  expect(f.life.view().outings.filter((outing) => outing.status !== 'cancelled')).toHaveLength(0)
  expect(f.dispatch({ type: 'life.propose', place: 'swing' })).toBeUndefined()
  const today = f.life.view().outings.find((outing) => outing.status === 'proposed')!
  expect(f.dispatch({ type: 'life.depart', outingId: today.id })).toBeUndefined()
  expect(f.dispatch({ type: 'life.depart', outingId: oldId })).toBe('unavailable')
  expect(f.life.view().outings.filter((outing) => outing.status === 'away')).toHaveLength(1)
  f.life.foreground(); expect(f.life.view().outings.some((outing) => outing.status === 'away')).toBe(false)
  expect(f.life.view().locationId).toBe('room'); expect(f.life.view().items).toHaveLength(0)
})
it('checks stale proposals at command time even before the next scheduler tick', () => {
  const f = fixture(); f.dispatch({ type: 'life.propose' }); const oldId = f.life.view().outings[0].id
  f.clock.advanceBy(86400000)
  expect(f.dispatch({ type: 'life.depart', outingId: oldId })).toBe('unavailable')
  expect(f.life.view().outings[0].status).toBe('cancelled'); expect(f.emit).not.toHaveBeenCalled()
  expect(f.dispatch({ type: 'life.propose' })).toBeUndefined()
})
it('uses a single departure guard and repairs legacy overlapping outings on restart', () => {
  const f = fixture(); f.dispatch({ type: 'life.propose' }); const base = f.life.view()
  // Simulate the two pending proposals reachable in older versions, without relying on the new expiry policy.
  const second = { ...base.outings[0], id: 'legacy-second-proposal' }
  f.store.append({ type: 'life/state', view: { ...base, outings: [...base.outings, second] } })
  let restarted = createLife(f.options); f.scheduler.cancel('life.settle')
  const send = (outingId: string) => restarted.dispatch({ type: 'life.depart', outingId } as AppCommand)
  expect(send(base.outings[0].id)).toBeUndefined(); expect(send(second.id)).toBe('unavailable')
  const overlap = { ...restarted.view(), outings: [{ ...base.outings[0], status: 'away' as const }, { ...second, status: 'away' as const }] }
  f.store.append({ type: 'life/state', view: overlap }); restarted = createLife(f.options); f.scheduler.cancel('life.settle')
  expect(restarted.view().outings.every((outing) => outing.status === 'cut_short')).toBe(true)
  expect(restarted.view().locationId).toBe('room'); expect(restarted.view().items).toHaveLength(0)
})
it.each(['2026-10-17T17:00:00+08:00', '2026-10-17T23:50:00+08:00'])(
  'settles a completed arrival-day outing when closed at %s', (closedAt) => {
    const f = fixture(); f.clock.advanceBy(f.clock.parse(closedAt) - f.clock.nowMs()); f.life.close()
    f.clock.advanceBy(f.clock.parse('2026-10-18T16:00:00+08:00') - f.clock.nowMs())
    const restarted = createLife(f.options); f.scheduler.cancel('life.settle')
    expect(restarted.view().outings).toMatchObject([{ offline: true, status: 'returned', startsAtMs: f.clock.parse('2026-10-18T15:00:00+08:00'), returnsAtMs: f.clock.nowMs() }])
    expect(restarted.view().items).toHaveLength(1); expect(restarted.view().locationId).toBe('room')
    expect(createLife(f.options).view()).toEqual(restarted.view()); f.scheduler.cancel('life.settle')
  },
)
it('enumerates across midnight and only settles fully covered outings within 72 hours', () => {
  const f = fixture(); f.clock.advanceBy(f.clock.parse('2026-10-17T23:50:00+08:00') - f.clock.nowMs()); f.life.close()
  f.clock.advanceBy(20 * 60000)
  const midnight = createLife(f.options); f.scheduler.cancel('life.settle'); expect(midnight.view().outings).toHaveLength(0)
  f.clock.advanceBy(f.clock.parse('2026-10-20T16:00:00+08:00') - f.clock.nowMs())
  const restarted = createLife(f.options); f.scheduler.cancel('life.settle')
  // Weekdays count too: the Sunday, Monday and Tuesday afternoons were all fully covered while closed.
  const afternoons = ['2026-10-18', '2026-10-19', '2026-10-20'].map((day) => f.clock.parse(day + 'T15:00:00+08:00'))
  expect(restarted.view().outings.filter((outing) => outing.offline).map((outing) => outing.startsAtMs)).toEqual(afternoons)
  expect(restarted.view().outings).toHaveLength(3); expect(restarted.view().items).toHaveLength(3)
  // With an older saved watermark the window starts Saturday 16:00: Saturday's 15:00 trip is outside it.
  const older = fixture(); older.life.close(); older.clock.advanceBy(3 * 86400000 + 6 * 3600000)
  const bounded = createLife(older.options); older.scheduler.cancel('life.settle')
  expect(bounded.view().outings.filter((outing) => outing.offline)).toHaveLength(3)
  expect(bounded.view().outings[0].startsAtMs).toBe(older.clock.parse('2026-10-18T15:00:00+08:00'))
})

const walkState = (f: ReturnType<typeof fixture>) => f.life.view().agenda.find((item) => item.kind === 'walk')?.state
it('walks on a weekday afternoon once you have been away a while, waiting out busy moments', () => {
  const f = fixture(); f.clock.advanceBy(f.clock.parse('2026-10-19T13:00:00+08:00') - f.clock.nowMs())
  f.store.append({ type: 'user/message', id: 'class', text: '我去上课了', requestId: 'class', commandHash: 'x' }); f.life.reconcile()
  // Monday 14:00: the window opens while she is busy. A busy minute no longer cancels the day.
  f.clock.advanceBy(60 * 60000); f.busy(true); f.life.reconcile()
  expect(walkState(f)).toBe('planned'); expect(f.life.view().locationId).toBe('room')
  f.clock.advanceBy(20 * 60000); f.busy(false); f.life.reconcile()
  expect(walkState(f)).toBe('settled'); expect(f.life.view().locationId).not.toBe('room')
  expect(f.life.view().outings).toMatchObject([{ status: 'away', offline: false, startsAtMs: f.clock.nowMs() }])
  f.clock.advanceBy(60 * 60000); f.life.reconcile()
  expect(f.life.view().locationId).toBe('room'); expect(f.life.view().items).toHaveLength(1); expect(f.emit).toHaveBeenCalledOnce()
  f.clock.advanceBy(30 * 60000); f.life.reconcile(); expect(f.life.view().outings).toHaveLength(1)
})
it('stays in right after you talk, during a running pomodoro and on a marked work day, and lets the day pass after 18:00', () => {
  const f = fixture(); f.clock.advanceBy(f.clock.parse('2026-10-19T14:30:00+08:00') - f.clock.nowMs())
  f.store.append({ type: 'user/message', id: 'here', text: '在吗', requestId: 'here', commandHash: 'x' }); f.life.reconcile()
  expect(walkState(f)).toBe('planned')
  // A break is for talking with you, so a running pomodoro keeps her in even outside focus.
  f.clock.advanceBy(20 * 60000)
  f.store.append({ type: 'pomodoro/state', view: { ...idleTimer(), phase: 'short-break', status: 'running', remainingMs: 300000, endsAtMs: f.clock.nowMs() + 300000, plannedCount: 1, focusIndex: 1, phaseDurationMs: 300000 }, pauseReason: null, cause: 'elapsed' })
  f.life.reconcile(); expect(walkState(f)).toBe('planned'); expect(f.life.view().locationId).toBe('room')
  f.store.append({ type: 'pomodoro/state', view: idleTimer(), pauseReason: null, cause: 'elapsed' })
  expect(f.dispatch({ type: 'life.schedule', schedule: 'work' })).toBeUndefined(); f.life.reconcile()
  expect(walkState(f)).toBe('planned'); expect(f.life.view().outings).toHaveLength(0)
  f.clock.advanceBy(f.clock.parse('2026-10-19T18:00:00+08:00') - f.clock.nowMs()); f.life.reconcile()
  expect(walkState(f)).toBe('skipped'); expect(f.life.view().outings).toHaveLength(0)
})
