import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { createManualClock } from '../../src/main/clock'
import { createScheduler } from '../../src/main/scheduler'
import { openJournal } from '../../src/main/journal/file'
import { projectJournal } from '../../src/main/journal/projection'
import type { SessionStore } from '../../src/main/store/session'
import { carryPreviousState } from '../../src/main/store/carry'
import { createSleep } from '../../src/main/life/sleep'
import { createLife } from '../../src/main/life/service'
import { createAppController } from '../../src/main/bridge/controller'
import { createMemoryService } from '../../src/main/memory/service'
import { projectMemory } from '../../src/main/memory/projection'
import type { AppCommand } from '../../src/shared'
import { resolveCharacterArt } from '../../src/renderer/src/book/characterArt'

const cleanup: (() => void | Promise<void>)[] = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'lca-sleep-'))
  cleanup.push(() => { if (!resolve(root).startsWith(join(resolve(tmpdir()), 'lca-sleep-'))) throw new Error('UNSAFE'); rmSync(root, { recursive: true, force: true }) })
  const clock = createManualClock(Date.parse('2026-10-17T03:59:00+08:00'))
  const owner = { userId: 'u', characterId: 'c' }; const journal = openJournal(root, owner, clock); cleanup.push(journal.close)
  const store: SessionStore = { scope: journal.scope, records: journal.records, projection: () => projectJournal(journal.records()), append: journal.append, close: journal.close }
  let busy = false
  const controller = createAppController(clock, undefined, store)
  const scheduler = createScheduler(clock); cleanup.push(scheduler.dispose)
  const sleep = createSleep({ store, clock, scheduler, canSleep: () => !busy, changed: () => controller.refresh('mode') }); cleanup.push(sleep.close); controller.attachSleep(sleep)
  let sequence = 0
  const command = (body: Record<string, unknown>) => ({ protocolVersion: 1, epoch: controller.getSnapshot().epoch, requestId: String(++sequence), ...body } as AppCommand)
  return { root, clock, owner, store, journal, controller, sleep, scheduler, command, busy: (value: boolean) => { busy = value } }
}
it('separates sleep from lights and rejects sleep while busy; only book may change it', () => {
  const f = fixture(); f.busy(true)
  expect(f.controller.dispatch(f.command({ type: 'companion.sleep', sleeping: true })).status).toBe('rejected')
  f.busy(false)
  expect(f.controller.dispatch(f.command({ type: 'companion.sleep', sleeping: true }), 'mini').status).toBe('rejected')
  expect(f.controller.dispatch(f.command({ type: 'companion.sleep', sleeping: true })).status).toBe('accepted')
  expect(f.controller.getSnapshot().companion).toMatchObject({ sleeping: true, pose: 'sleeping', lightsOut: false })
  f.controller.dispatch(f.command({ type: 'lights.set', lightsOut: true }))
  expect(f.controller.getSnapshot().companion).toMatchObject({ sleeping: true, pose: 'sleeping', lightsOut: true })
  f.controller.dispatch(f.command({ type: 'companion.sleep', sleeping: false }))
  expect(f.controller.getSnapshot().companion).toMatchObject({ sleeping: false, pose: 'facing-user', lightsOut: true })
  expect(f.store.projection().requests.map((request) => request.requestId)).toEqual(['3', '4', '5'])
})
it('does not wake on window telemetry; a deliberate conversation wakes before its execution', () => {
  const f = fixture(); f.sleep.set(true, 'user')
  f.controller.dispatch(f.command({ type: 'window.expand' }))
  expect(f.store.projection().sleeping).toBe(true)
  const send = vi.fn(() => expect(f.store.projection().sleeping).toBe(false))
  f.controller.attachExecution({ source: 'fake', send, stop: () => false, stateChanged: () => {} }, true)
  expect(f.controller.dispatch(f.command({ type: 'message.send', text: '合成唤醒' })).status).toBe('accepted'); expect(send).toHaveBeenCalledOnce()
})
it('wakes automatic sleep at the morning boundary while preserving the independent lights switch', () => {
  const f = fixture(); f.sleep.set(true, 'day-end')
  f.controller.dispatch(f.command({ type: 'lights.set', lightsOut: true }))
  f.scheduler.pauseBackground(true)
  f.clock.advanceBy(2 * 3600_000 + 60_000)
  const companion = f.controller.getSnapshot().companion
  expect(companion).toMatchObject({ sleeping: false, pose: 'facing-user', daypart: 'morning', lightsOut: true })
  expect(resolveCharacterArt(companion).key).toBe('facing-user_calm')
  expect(f.store.records().filter((row) => row.type === 'companion/sleep' && row.cause === 'day-start')).toHaveLength(1)
  f.clock.advanceBy(60_000)
  expect(f.store.records().filter((row) => row.type === 'companion/sleep' && row.cause === 'day-start')).toHaveLength(1)
})
it('keeps a manual sleep request even when it replaces an already sleeping automatic state', () => {
  const f = fixture(); f.sleep.set(true, 'day-end')
  expect(f.controller.dispatch(f.command({ type: 'companion.sleep', sleeping: true })).status).toBe('accepted')
  f.clock.advanceBy(8 * 3600_000)
  expect(f.store.projection().sleeping).toBe(true)
  expect(f.scheduler.queue().some((job) => job.id === 'sleep.wake')).toBe(false)
  expect(f.store.records().some((row) => row.type === 'companion/sleep' && row.cause === 'day-start')).toBe(false)
})
it('corrects automatic sleep from legacy daily carries on morning restart using only scoped facts', () => {
  const f = fixture(); f.sleep.set(true, 'day-end'); f.sleep.close()
  const previous = [...f.journal.records()]; f.journal.close()
  f.clock.advanceBy(8 * 3600_000)
  const next = openJournal(f.root, f.owner, f.clock); cleanup.push(next.close); carryPreviousState(next, f.root, f.owner, f.clock)
  expect(projectJournal(next.records()).sleeping).toBe(true)
  const store: SessionStore = { scope: next.scope, records: next.records, history: () => [...previous, ...next.records()], projection: () => projectJournal(next.records()), append: next.append, close: next.close }
  const controller = createAppController(f.clock, undefined, store)
  const sleep = createSleep({ store, clock: f.clock, scheduler: f.scheduler, canSleep: () => true, changed: () => controller.refresh('mode') }); cleanup.push(sleep.close)
  const companion = controller.getSnapshot().companion
  expect(companion).toMatchObject({ sleeping: false, pose: 'facing-user', daypart: 'morning' })
  expect(resolveCharacterArt(companion).key).toBe('facing-user_calm')
  expect(next.records().at(-1)).toMatchObject({ type: 'companion/sleep', sleeping: false, cause: 'day-start' })
})
it('does not turn a daylight catch-up page seal into sleep', async () => {
  const f = fixture(); f.clock.advanceBy(8 * 3600_000)
  const rotate = vi.fn(() => true); f.store.dayKey = () => '2026-10-16'; f.store.rotate = rotate
  const memory = createMemoryService({ store: f.store, clock: f.clock, scheduler: f.scheduler, model: null,
    repository: { view: () => projectMemory(f.store.records()), append: f.store.append, refresh: () => {}, close: () => {} },
    isBusy: () => false, rolled: () => f.controller.refresh('connection'), changed: () => f.controller.refresh('connection'), closingDay: () => { f.sleep.set(true, 'day-end') } })
  cleanup.push(memory.close); f.scheduler.cancel('memory.maintenance')
  await memory.maintenance()
  expect(rotate).toHaveBeenCalledOnce()
  expect(f.controller.getSnapshot().companion).toMatchObject({ sleeping: false, pose: 'facing-user', daypart: 'morning' })
  expect(f.store.records().some((row) => row.type === 'companion/sleep')).toBe(false)
})
it('keeps sleep across journal reopen, day carry and owner isolation without manufacturing work', () => {
  const f = fixture(); f.sleep.set(true, 'day-end'); f.journal.close()
  const reopened = openJournal(f.root, f.owner, f.clock); expect(projectJournal(reopened.records()).sleeping).toBe(true); reopened.close()
  f.clock.advanceBy(120_000)
  const next = openJournal(f.root, f.owner, f.clock); cleanup.push(next.close); carryPreviousState(next, f.root, f.owner, f.clock)
  expect(projectJournal(next.records()).sleeping).toBe(true); expect(next.records().map((row) => row.type)).toEqual(['session/header', 'session/carry'])
  const other = openJournal(f.root, { ...f.owner, characterId: 'other' }, f.clock); cleanup.push(other.close); carryPreviousState(other, f.root, { ...f.owner, characterId: 'other' }, f.clock)
  expect(projectJournal(other.records()).sleeping).toBe(false)
})
it('does not schedule works or outings while sleeping, including offline startup', () => {
  const f = fixture(); f.sleep.set(true, 'user'); f.clock.advanceBy(15 * 3600_000)
  const scheduler = createScheduler(f.clock); cleanup.push(scheduler.dispose)
  const life = createLife({ store: f.store, clock: f.clock, scheduler, working: () => false, changed: () => {}, emit: () => {} })
  expect(life.view().outings).toHaveLength(0); expect(f.store.records().some((row) => row.type === 'life/work-attempt')).toBe(false)
  expect(life.dispatch(f.command({ type: 'life.propose', place: 'coast' }))).toBe('unavailable')
  life.close()
})
it('enters sleep only after safe asynchronous day sealing, never on a new user interruption', async () => {
  const f = fixture(); const scheduler = createScheduler(f.clock); cleanup.push(scheduler.dispose)
  const day = '2026-10-16'; let release: () => void = () => {}
  const sealing = vi.fn(() => new Promise<void>((done) => { release = done }))
  const rotate = vi.fn(() => true); f.store.dayKey = () => day; f.store.rotate = rotate
  const memory = createMemoryService({ store: f.store, clock: f.clock, scheduler, model: null,
    repository: { view: () => projectMemory(f.store.records()), append: f.store.append, refresh: () => {}, close: () => {} },
    isBusy: () => false, rolled: () => {}, changed: () => {}, beforeRoll: sealing,
    closingDay: () => { f.sleep.set(true, 'day-end') } })
  cleanup.push(memory.close); scheduler.cancel('memory.maintenance'); f.clock.advanceBy(120_000)
  const first = memory.maintenance(); await Promise.resolve(); expect(sealing).toHaveBeenCalledOnce()
  f.store.append({ type: 'user/message', id: 'interrupt', text: 'still here', requestId: 'r', commandHash: 'h' }); release(); await first
  expect(rotate).not.toHaveBeenCalled(); expect(f.store.projection().sleeping).toBe(false)
  f.clock.advanceBy(120_000); const second = memory.maintenance(); await Promise.resolve(); release(); await second
  expect(rotate).toHaveBeenCalledOnce(); expect(f.store.projection().sleeping).toBe(true)
})
