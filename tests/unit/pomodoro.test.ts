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
  expect(f.timer.propose(demo, 'assistant')).toBeUndefined(); const planId = f.timer.read().plan!.id
  expect(f.timer.start(planId)).toBe('invalid-command')
  expect(pomodoroTools(f.timer).map((tool) => tool.definition.name)).not.toContain('confirm')
  expect(f.timer.dispatch({ protocolVersion: 1, epoch: 'test', requestId: 'confirm', type: 'pomodoro.confirm', planId })).toBeUndefined()
  expect(f.timer.start(planId)).toBeUndefined(); return planId
}
describe('durable Pomodoro phases through the single inbox', () => {
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
