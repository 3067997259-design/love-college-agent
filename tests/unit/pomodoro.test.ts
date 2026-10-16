import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createManualClock } from '../../src/main/clock'
import { openJournal } from '../../src/main/journal/file'
import { projectJournal } from '../../src/main/journal/projection'
import type { SessionStore } from '../../src/main/store/session'
import { createScheduler } from '../../src/main/scheduler'
import { createPomodoro } from '../../src/main/pomodoro/service'
import { pomodoroTools } from '../../src/main/pomodoro/tools'
import { createHarness } from '../../src/main/harness/loop'
import type { ModelClient, ModelReply } from '../../src/main/model/types'
import { planSchema, viewSchema } from '../../src/main/pomodoro/schema'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
const demo = { label: 'Synthetic plan', plannedCount: 2, focusDurationMs: 60_000, shortBreakDurationMs: 20_000, longBreakDurationMs: 20_000, longBreakEvery: 2, timing: 'demo' as const }
const reply = (): ModelReply => ({ text: 'synthetic completion', toolCalls: [], usage: { inputTokens: 0, outputTokens: 0 } })
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'lca-pomodoro-')); const clock = createManualClock(1000)
  cleanups.push(async () => { if (!resolve(root).startsWith(join(resolve(tmpdir()), 'lca-pomodoro-'))) throw new Error('Unsafe cleanup path'); rmSync(root, { recursive: true, force: true }) })
  const open = (options: { enabled?: () => boolean; emit?: boolean; model?: ModelClient } = {}) => {
    const journal = openJournal(root, { userId: 'u', characterId: 'c' }, clock)
    const store: SessionStore = { scope: journal.scope, records: journal.records, projection: () => projectJournal(journal.records()), append: journal.append, close: journal.close }
    const scheduler = createScheduler(clock)
    const model: ModelClient = options.model ?? { source: 'fake', complete: async (_request, report) => { report({ slot: 'chat', attempt: 1, status: 'started', waitMs: 0 }); return reply() } }
    const harness = createHarness({ clock, store, model, tools: [], enabled: options.enabled })
    const timer = createPomodoro({ clock, store, scheduler, changed: () => {}, stateChanged: harness.stateChanged,
      emit: (id, text) => { if (options.emit !== false) harness.postEvent('pomodoro', text, id) } })
    timer.reconcile(); let closed = false
    const close = async () => { if (closed) return; closed = true; timer.dispose(); scheduler.dispose(); await harness.dispose(); store.close() }
    cleanups.push(close)
    return { store, timer, harness, scheduler, close }
  }
  return { root, clock, open }
}
function begin(f: ReturnType<ReturnType<typeof fixture>['open']>) {
  expect(f.timer.propose(demo, 'assistant')).toBeUndefined(); const planId = f.timer.read().proposal!.id
  expect(f.timer.start(planId)).toBe('invalid-command')
  expect(pomodoroTools(f.timer).map((tool) => tool.definition.name)).not.toContain('confirm')
  expect(f.timer.dispatch({ protocolVersion: 1, epoch: 'test', requestId: 'confirm', type: 'pomodoro.confirm', planId })).toBeUndefined()
  expect(f.timer.start(planId)).toBeUndefined(); return planId
}
describe('durable Pomodoro phases through the single inbox', () => {
  it('proposes and confirms a new daily total after one completed focus without resetting the plan or progress', () => {
    const base = fixture(); const f = base.open({ emit: false }); begin(f)
    base.clock.advanceBy(60_000); base.clock.advanceBy(20_000)
    const before = f.timer.read(); expect(before.completedCount).toBe(1)
    expect(f.timer.propose({ ...demo, label: 'Revised day', plannedCount: 3 }, 'assistant')).toBeUndefined()
    const draft = f.timer.read(); expect(draft.plan).toEqual(before.plan); expect(draft.focusIndex).toBe(1); expect(draft.phase).toBe(before.phase)
    expect(draft.plannedCount).toBe(2); expect(draft.proposal!.plannedCount).toBe(3)
    expect(f.timer.dispatch({ protocolVersion: 1, epoch: 'test', requestId: 'confirm-revision', type: 'pomodoro.confirm', planId: draft.proposal!.id })).toBeUndefined()
    const confirmed = f.timer.read(); expect(confirmed.focusIndex).toBe(1); expect(confirmed.completedCount).toBe(1); expect(confirmed.proposal).toBeUndefined()
    expect(confirmed.plan!.plannedCount).toBe(3); expect(confirmed.plannedCount).toBe(3)
    expect(f.timer.start(confirmed.plan!.id)).toBeUndefined(); expect(f.timer.read()).toMatchObject({ focusIndex: 2, completedCount: 1 })
  })
  it('replaces or discards only the pending draft; stop cannot discard it or finish a focus that never completed', () => {
    const base = fixture(); const f = base.open({ emit: false })
    f.timer.propose(demo, 'assistant'); const initial = f.timer.read().proposal!
    expect(f.timer.stop()).toBe('unavailable'); expect(f.timer.read().proposal!.id).toBe(initial.id)
    const activeId = begin(f); const before = f.timer.read()
    f.timer.propose({ ...demo, label: 'First draft' }, 'assistant'); const oldDraft = f.timer.read().proposal!.id
    f.timer.propose({ ...demo, label: 'Replacement draft', plannedCount: 3 }, 'user'); const currentDraft = f.timer.read().proposal!
    expect(currentDraft.id).not.toBe(oldDraft); expect(f.timer.read().plan!.id).toBe(activeId)
    expect(f.timer.dispatch({ protocolVersion: 1, epoch: 'test', requestId: 'wrong-discard', type: 'pomodoro.discard', planId: oldDraft })).toBe('invalid-command')
    expect(f.timer.dispatch({ protocolVersion: 1, epoch: 'test', requestId: 'discard', type: 'pomodoro.discard', planId: currentDraft.id })).toBeUndefined()
    expect(f.timer.read()).toEqual(before)
    f.timer.propose(demo, 'assistant'); const pending = f.timer.read().proposal
    expect(f.timer.stop()).toBeUndefined(); expect(f.timer.read()).toMatchObject({ focusIndex: 0, completedCount: 0, proposal: pending, plan: { id: activeId, status: 'finished' } })
  })
  it('allows proposals and confirmation during focus without changing the phase duration or deadline', () => {
    const base = fixture(); const f = base.open({ emit: false }); begin(f); base.clock.advanceBy(10_000)
    const before = f.timer.read()
    expect(f.timer.propose({ ...demo, plannedCount: 3, timing: 'custom', focusDurationMs: 90_000 }, 'assistant')).toBeUndefined()
    const pending = f.timer.read(); expect(pending.plan).toEqual(before.plan)
    for (const key of ['focusIndex', 'phase', 'status', 'phaseDurationMs', 'remainingMs', 'endsAtMs'] as const) expect(pending[key]).toBe(before[key])
    f.timer.dispatch({ protocolVersion: 1, epoch: 'test', requestId: 'confirm-focus', type: 'pomodoro.confirm', planId: pending.proposal!.id })
    expect(f.timer.read()).toMatchObject({ focusIndex: 1, completedCount: 0, phaseDurationMs: 60_000, remainingMs: 50_000, endsAtMs: before.endsAtMs })
    base.clock.advanceBy(50_000); expect(f.timer.read().completedCount).toBe(1); base.clock.advanceBy(20_000)
    f.timer.start(f.timer.read().plan!.id); expect(f.timer.read()).toMatchObject({ focusIndex: 2, completedCount: 1, phaseDurationMs: 90_000 })
  })
  it('confirms during break or a paused phase while preserving the actual timer and pause reason', () => {
    const base = fixture(); const f = base.open({ emit: false }); begin(f); base.clock.advanceBy(60_000); base.clock.advanceBy(5000)
    const before = f.timer.read(); f.timer.propose({ ...demo, plannedCount: 3 }, 'assistant')
    f.timer.dispatch({ protocolVersion: 1, epoch: 'test', requestId: 'confirm-break', type: 'pomodoro.confirm', planId: f.timer.read().proposal!.id })
    expect(f.timer.read()).toMatchObject({ phase: before.phase, remainingMs: before.remainingMs, endsAtMs: before.endsAtMs, focusIndex: 1, completedCount: 1 })
    f.timer.pause(); f.timer.propose({ ...demo, plannedCount: 4 }, 'assistant')
    f.timer.dispatch({ protocolVersion: 1, epoch: 'test', requestId: 'confirm-paused', type: 'pomodoro.confirm', planId: f.timer.read().proposal!.id })
    expect(f.timer.read()).toMatchObject({ status: 'paused', endsAtMs: null, remainingMs: before.remainingMs, focusIndex: 1 }); expect(f.store.projection().pomodoroPause).toBe('manual')
    base.clock.advanceBy(100_000); expect(f.timer.read().remainingMs).toBe(before.remainingMs)
  })
  it('rejects totals below completed/current progress and rechecks a draft that became stale before confirmation', async () => {
    const base = fixture(); const f = base.open({ emit: false }); const active = begin(f)
    f.timer.propose({ ...demo, plannedCount: 1 }, 'assistant'); const pendingId = f.timer.read().proposal!.id
    base.clock.advanceBy(60_000); base.clock.advanceBy(20_000); f.timer.start(active)
    const before = f.timer.read(); const count = f.store.records().length
    expect(f.timer.dispatch({ protocolVersion: 1, epoch: 'test', requestId: 'confirm-stale-count', type: 'pomodoro.confirm', planId: pendingId })).toBe('invalid-command')
    expect(f.timer.read()).toEqual(before); expect(f.store.records()).toHaveLength(count)
    base.clock.advanceBy(60_000); base.clock.advanceBy(20_000); expect(f.timer.read().completedCount).toBe(2)
    expect(f.timer.propose({ ...demo, plannedCount: 1 }, 'user')).toBe('invalid-command')
    const tool = pomodoroTools(f.timer).find((tool) => tool.definition.name === 'plan_pomodoros')!
    expect(await tool.run({ ...demo, plannedCount: 1 }, { signal: new AbortController().signal } as Parameters<typeof tool.run>[1])).toMatchObject({ ok: false })
    const read = pomodoroTools(f.timer).find((tool) => tool.definition.name === 'get_timer')!
    expect((await read.run({}, { signal: new AbortController().signal } as Parameters<typeof read.run>[1])).visible).toMatchObject({ completedCount: 2, focusIndex: 2 })
  })
  it('replays the legacy proposed-in-plan format only as a proposal without rewriting its journal record', async () => {
    const base = fixture(); let f = base.open({ emit: false })
    const legacy = { ...demo, id: 'legacy-draft', createdAtMs: base.clock.nowMs(), source: 'assistant' as const, status: 'proposed' as const }
    f.store.append({ type: 'pomodoro/state', view: { phase: 'idle', status: 'idle', endsAtMs: null, remainingMs: 0, phaseDurationMs: 0, focusIndex: 0, plannedCount: 2, plan: legacy }, cause: 'plan', pauseReason: null })
    expect(f.timer.read()).toMatchObject({ proposal: legacy, plannedCount: 0, completedCount: 0 }); expect(f.timer.read().plan).toBeUndefined()
    await f.close(); f = base.open({ emit: false }); expect(f.timer.read().proposal!.id).toBe(legacy.id)
    const source = f.store.records().find((row) => row.type === 'pomodoro/state')
    expect(source?.type === 'pomodoro/state' && source.view.plan?.status).toBe('proposed')
  })
  it('retains exact optional task items in the projection, confirmation, start and journal replay', async () => {
    const base = fixture(); let f = base.open({ emit: false })
    const items = [{ text: '读完课程材料', count: 1, assist: true }, { text: '自己完成练习', count: 1, assist: false }]
    expect(f.timer.propose({ ...demo, items }, 'user')).toBeUndefined()
    let plan = f.timer.read().proposal!; expect(plan.items).toEqual(items); expect(f.timer.read().plan).toBeUndefined(); expect(viewSchema.safeParse(f.timer.read()).success).toBe(true)
    f.timer.dispatch({ protocolVersion: 1, epoch: 'test', requestId: 'confirm-items', type: 'pomodoro.confirm', planId: plan.id })
    f.timer.start(plan.id); expect(f.timer.read().plan!.items).toEqual(items)
    await f.close(); f = base.open({ emit: false }); plan = f.timer.read().plan!
    expect(plan.items).toEqual(items); expect(plan.status).toBe('confirmed')
    expect(planSchema.safeParse(demo).success).toBe(true)
    expect(planSchema.safeParse({ ...demo, items: [{ text: '桃'.repeat(40), count: 2, assist: true }] }).success).toBe(true)
    expect(planSchema.safeParse({ ...demo, items: [{ text: '🍑'.repeat(40), count: 2, assist: false }] }).success).toBe(true)
  })
  it('rejects invalid item lengths, counts, sums and assist at both the model tool and service without appending facts', async () => {
    const base = fixture(); const f = base.open({ emit: false }); const tool = pomodoroTools(f.timer).find((tool) => tool.definition.name === 'plan_pomodoros')!
    for (const items of [[], [{ text: '桃'.repeat(41), count: 2, assist: true }], [{ text: '🍑'.repeat(41), count: 2, assist: true }],
      [{ text: '   ', count: 2, assist: true }], [{ text: '第一行\n第二行', count: 2, assist: true }], [{ text: '任务', count: 0, assist: true }],
      [{ text: '任务', count: 1.5, assist: true }], [{ text: '任务', count: 1, assist: true }], [{ text: '任务', count: 3, assist: true }],
      [{ text: '任务', count: 2, assist: 'yes' }], [{ text: '任务', count: 2 }]]) {
      const input = { ...demo, items }; const before = f.store.records().length
      expect(tool.validate(input)).toBe(false)
      const result = await tool.run(input, { signal: new AbortController().signal } as Parameters<typeof tool.run>[1])
      expect(result).toMatchObject({ ok: false, visible: { error: 'invalid-command' } }); expect(f.store.records()).toHaveLength(before)
    }
    const input = { ...demo, items: [{ text: '课程资料', count: 2, assist: true }] }
    expect(tool.validate(input)).toBe(true)
    expect((await tool.run(input, { signal: new AbortController().signal } as Parameters<typeof tool.run>[1])).ok).toBe(true)
    expect(f.timer.read().proposal!.items).toEqual(input.items)
  })
  it('requires user confirmation, uses long breaks, and waits before the next focus', async () => {
    const base = fixture(); const f = base.open(); const planId = begin(f)
    expect(f.store.projection().mode).toBe('quiet'); expect(f.store.projection().messages).toHaveLength(0)
    base.clock.advanceBy(60_000); await f.harness.idle()
    expect(f.timer.read()).toMatchObject({ phase: 'short-break', status: 'running', phaseDurationMs: 20_000 })
    expect(f.store.projection().mode).toBe('rest')
    base.clock.advanceBy(20_000); await f.harness.idle(); expect(f.timer.read().phase).toBe('idle')
    base.clock.advanceBy(100_000); expect(f.timer.read().phase).toBe('idle'); expect(f.timer.read().focusIndex).toBe(1)
    f.timer.start(planId); base.clock.advanceBy(60_000); await f.harness.idle(); expect(f.timer.read().phase).toBe('long-break')
    base.clock.advanceBy(20_000); await f.harness.idle(); expect(f.timer.read().plan?.status).toBe('finished')
    expect(f.timer.start(planId)).toBe('invalid-command')
    const events = f.store.records().filter((row) => row.type === 'inbox/event')
    expect(new Set(events.map((row) => row.type === 'inbox/event' ? row.id : '')).size).toBe(events.length)
  })
  it('freezes remaining time for lights, but does not auto-resume a manual pause', () => {
    const base = fixture(); const f = base.open(); begin(f); base.clock.advanceBy(10_000)
    const lights = (lightsOut: boolean) => { f.store.append({ type: 'companion/lights', lightsOut, requestId: `lights-${lightsOut}`, commandHash: 'x' }); f.timer.stateChanged({ protocolVersion: 1, epoch: 'x', requestId: 'x', type: 'lights.set', lightsOut }) }
    lights(true); expect(f.timer.read()).toMatchObject({ status: 'paused', remainingMs: 50_000, endsAtMs: null })
    base.clock.advanceBy(100_000); lights(false); expect(f.timer.read()).toMatchObject({ status: 'running', remainingMs: 50_000 })
    f.timer.pause(); lights(true); base.clock.advanceBy(100_000); lights(false)
    expect(f.timer.read().status).toBe('paused'); expect(f.timer.read().remainingMs).toBe(50_000)
  })
  it('reconciles an expired focus once after restart and does not replay consumed phase events', async () => {
    const base = fixture(); let f = base.open({ enabled: () => false }); begin(f); const session = f.store.scope.sessionId
    await f.close(); base.clock.advanceBy(70_000); f = base.open({ enabled: () => false })
    expect(f.store.scope.sessionId).toBe(session); expect(f.timer.read().phase).toBe('short-break')
    f.timer.reconcile(); f.timer.reconcile()
    expect(f.store.records().filter((row) => row.type === 'pomodoro/state' && row.cause === 'elapsed')).toHaveLength(1)
    expect(f.store.records().filter((row) => row.type === 'inbox/event')).toHaveLength(2)
    await f.close(); f = base.open(); f.harness.stateChanged(); await f.harness.idle()
    const consumed = f.store.records().filter((row) => row.type === 'inbox/drain').length
    f.timer.reconcile(); await f.harness.idle()
    expect(f.store.records().filter((row) => row.type === 'inbox/drain')).toHaveLength(consumed)
  })
  it('recovers the crash gap between a durable phase fact and posting its inbox event', async () => {
    const base = fixture(); let f = base.open({ enabled: () => false, emit: false }); begin(f)
    expect(f.store.records().filter((row) => row.type === 'inbox/event')).toHaveLength(0)
    await f.close(); f = base.open({ enabled: () => false }); f.timer.reconcile()
    expect(f.store.records().filter((row) => row.type === 'inbox/event')).toHaveLength(1)
  })
  it('records manual rest as interrupted and does not count it as a completed focus', () => {
    const base = fixture(); const f = base.open(); const planId = begin(f); base.clock.advanceBy(10_000)
    f.store.append({ type: 'companion/mode', mode: 'rest', requestId: 'rest', commandHash: 'x' })
    f.timer.stateChanged({ protocolVersion: 1, epoch: 'x', requestId: 'x', type: 'mode.set', mode: 'rest' })
    expect(f.timer.read()).toMatchObject({ phase: 'short-break', focusIndex: 0 })
    expect(f.store.records().some((row) => row.type === 'pomodoro/state' && row.cause === 'interrupted')).toBe(true)
    base.clock.advanceBy(20_000); f.timer.start(planId); expect(f.timer.read().focusIndex).toBe(1)
  })
  it('holds an already running autonomous reply until break while user replies stay available', async () => {
    const base = fixture(); let release!: (value: ModelReply) => void; let calls = 0
    const model: ModelClient = { source: 'fake', complete: async (_request, report) => { report({ slot: 'chat', attempt: 1, status: 'started', waitMs: 0 }); return calls++ === 0 ? new Promise<ModelReply>((resolve) => { release = resolve }) : reply() } }
    const f = base.open({ model }); f.harness.postEvent('autonomous', 'synthetic event'); begin(f)
    release(reply()); await f.harness.idle(); expect(f.store.projection().messages).toHaveLength(0)
    f.harness.send('synthetic user question', 'u1', 'hash'); await f.harness.idle()
    expect(f.store.projection().messages.map((message) => message.role)).toEqual(['user', 'assistant'])
    base.clock.advanceBy(60_000); await f.harness.idle()
    expect(f.store.projection().messages.filter((message) => message.role === 'assistant').length).toBeGreaterThan(1)
  })
})
