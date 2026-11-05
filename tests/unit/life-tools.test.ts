import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { createManualClock } from '../../src/main/clock'
import { openJournal } from '../../src/main/journal/file'
import { projectJournal } from '../../src/main/journal/projection'
import { createScheduler } from '../../src/main/scheduler'
import { createLife } from '../../src/main/life/service'
import { lifeTools } from '../../src/main/life/tools'
import type { SessionStore } from '../../src/main/store/session'
const cleanups: (() => void)[] = []
afterEach(() => cleanups.splice(0).reverse().forEach((cleanup) => cleanup()))
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'lca-life-tools-')); cleanups.push(() => { if (!resolve(root).startsWith(join(resolve(tmpdir()), 'lca-life-tools-'))) throw new Error('UNSAFE'); rmSync(root, { recursive: true, force: true }) })
  const clock = createManualClock(0); clock.advanceBy(clock.parse('2026-10-17T10:00:00+08:00')); const journal = openJournal(root, { userId: 'u', characterId: 'c' }, clock)
  const store: SessionStore = { scope: journal.scope, records: journal.records, append: journal.append, projection: () => projectJournal(journal.records()), close: journal.close }
  const scheduler = createScheduler(clock); const emit = vi.fn()
  const life = createLife({ store, clock, scheduler, working: () => false, changed: () => {}, emit })
  scheduler.cancel('life.settle'); cleanups.push(store.close); cleanups.push(scheduler.dispose)
  const tools = new Map(lifeTools(life).map((tool) => [tool.templateId, tool]))
  const context = { clock, store, turnId: 'turn', signal: new AbortController().signal }
  return { clock, store, life, tools, context }
}

it('lets her take a small trip the book has no picture for, and bring nothing back', async () => {
  const f = fixture()
  const outing = f.tools.get('life.outing')!
  const proposed = await outing.run({ action: 'propose', place: 'bookstore' }, f.context)
  expect(proposed.ok).toBe(true)
  expect(f.life.view().outings).toMatchObject([{ place: 'bookstore', status: 'proposed', item: null, offline: false }])
  const departed = await outing.run({ action: 'depart' }, f.context)
  expect(departed.ok).toBe(true); expect(f.life.view().locationId).toBe('bookstore')
  f.clock.advanceBy(60 * 60000); f.life.reconcile()
  expect(f.life.view().locationId).toBe('room')
  expect(f.life.view().outings[0].status).toBe('returned')
  // A bookstore visit is only fresh air: nothing is added to the window sill.
  expect(f.life.view().items).toHaveLength(0)
})

it('returns early when asked, and refuses a second outing while one is pending', async () => {
  const f = fixture()
  const outing = f.tools.get('life.outing')!
  await outing.run({ action: 'propose', place: 'coast' }, f.context)
  await outing.run({ action: 'depart' }, f.context)
  const back = await outing.run({ action: 'return' }, f.context)
  expect(back.ok).toBe(true)
  expect(f.life.view().locationId).toBe('room')
  expect(f.life.view().outings[0].status).toBe('cut_short')
  const again = await outing.run({ action: 'propose' }, f.context)
  expect(again.ok).toBe(true)
  // She is only proposed to go out; asking her to come back has nothing to end yet.
  expect(await outing.run({ action: 'return' }, f.context)).toMatchObject({ ok: true, visible: { ok: false } })
})

it('marks the day for her own routine through the tool, not a settings panel', async () => {
  const f = fixture()
  const schedule = f.tools.get('life.schedule')!
  expect(await schedule.run({ schedule: 'work' }, f.context)).toMatchObject({ ok: true, visible: { ok: true, schedule: 'work' } })
  expect(f.life.view().userSchedule).toBe('work')
  expect(await schedule.run({ schedule: 'rest' }, f.context)).toMatchObject({ ok: true, visible: { ok: true, schedule: 'rest' } })
  expect(f.life.view().userSchedule).toBe('rest')
})
