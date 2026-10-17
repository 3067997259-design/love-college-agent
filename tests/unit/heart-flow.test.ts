import { mkdtempSync, rmSync, linkSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { createManualClock } from '../../src/main/clock'
import { openJournal } from '../../src/main/journal/file'
import { projectJournal } from '../../src/main/journal/projection'
import { createDesk } from '../../src/main/heart-flow/desk'
import { createHeartFlow, deskTools } from '../../src/main/heart-flow/service'
import type { SessionStore } from '../../src/main/store/session'
import type { AppCommand } from '../../src/shared'
import { createAppController } from '../../src/main/bridge/controller'
import { createHarness } from '../../src/main/harness/loop'
const cleanups: (() => void)[] = []
afterEach(() => cleanups.splice(0).reverse().forEach((cleanup) => cleanup()))
function fixture(booth = false, prepare?: Parameters<typeof createHeartFlow>[0]['prepare']) {
  const root = mkdtempSync(join(tmpdir(), 'lca-flow-')); cleanups.push(() => { if (!resolve(root).startsWith(join(resolve(tmpdir()), 'lca-flow-'))) throw new Error('UNSAFE'); rmSync(root, { recursive: true, force: true }) })
  const clock = createManualClock(1000); const journal = openJournal(root, { userId: 'u', characterId: 'c' }, clock)
  const store: SessionStore = { scope: journal.scope, records: journal.records, append: journal.append, projection: () => projectJournal(journal.records()), close: journal.close }
  const desk = createDesk(join(root, 'desk')); const run = vi.fn(async () => '42'); const emit = vi.fn()
  const inspect = vi.fn()
  const opts = { store, clock, desk, booth, inspect, busy: () => false, changed: () => {}, prepare: prepare ?? (async () => ({ messages: [{ role: 'system' as const, content: 'frozen' }], eligibleIndexes: [] })), emit, run }
  const flow = createHeartFlow(opts); cleanups.push(store.close); cleanups.push(flow.close)
  const dispatch = (body: Record<string, unknown>) => flow.dispatch({ ...body, protocolVersion: 1, epoch: 'x', requestId: 'x' } as AppCommand)
  return { root, store, clock, desk, run, emit, inspect, flow, opts, dispatch }
}
it.each(['sleep', 'lights', 'disabled', 'close'] as const)('invalidates pending entry on %s even when preparation ignores abort', async (cause) => {
  const attempts: { signal: AbortSignal; release(): void }[] = []
  const f = fixture(false, async (_id, signal) => new Promise((done) => { attempts.push({ signal, release: () => done({ messages: [{ role: 'system', content: 'prepared' }], eligibleIndexes: [] }) }) }))
  expect(f.dispatch({ type: 'flow.enter' })).toBeUndefined(); expect(f.flow.occupied()).toBe(true); expect(f.flow.active()).toBe(false)
  if (cause === 'sleep') { f.store.append({ type: 'companion/sleep', sleeping: true, cause: 'user' }); f.flow.stateChanged(); f.store.append({ type: 'companion/sleep', sleeping: false, cause: 'interaction' }) }
  if (cause === 'lights') { f.store.append({ type: 'companion/lights', lightsOut: true, requestId: 'dark', commandHash: 'h' }); f.flow.stateChanged(); f.store.append({ type: 'companion/lights', lightsOut: false, requestId: 'light', commandHash: 'h' }) }
  if (cause === 'disabled') { f.flow.setEnabled(false); f.flow.setEnabled(true) }
  if (cause === 'close') f.flow.close()
  expect(attempts[0].signal.aborted).toBe(true); expect(f.flow.occupied()).toBe(false)
  expect(f.dispatch({ type: 'flow.enter' })).toBeUndefined(); expect(attempts).toHaveLength(2)
  const changed = vi.spyOn(f.opts, 'changed'); attempts[0].release()
  // Wait for the old completion and its finally; it cannot release the newer owner.
  await vi.waitFor(() => expect(changed).toHaveBeenCalled()); expect(f.flow.active()).toBe(false)
  expect(f.flow.occupied()).toBe(true); expect(f.dispatch({ type: 'flow.enter' })).toBe('unavailable')
  attempts[1].release(); await vi.waitFor(() => expect(f.flow.active()).toBe(true))
  expect(f.store.records().filter((row) => row.type === 'flow/open')).toHaveLength(1)
})
it('restricts paths, hardlinks and exact file-version undo', async () => {
  const f = fixture(); f.dispatch({ type: 'flow.enter' }); await vi.waitFor(() => expect(f.flow.active()).toBe(true))
  expect(() => f.flow.write('a.js', 'one')).toThrow(); f.dispatch({ type: 'flow.mode', mode: 'execute' })
  for (const path of ['../private', 'C:/private', 'a/../../x', 'a\\b', 'CON.txt', 'file:stream', '/root']) expect(() => f.flow.write(path, 'bad')).toThrow()
  const id = f.flow.write('a.js', 'one'); f.desk.write('a.js', 'external')
  expect(f.dispatch({ type: 'flow.undo', changeId: id })).toBe('invalid-command'); f.desk.write('a.js', 'one')
  expect(f.dispatch({ type: 'flow.undo', changeId: id })).toBeUndefined(); expect(f.desk.read('a.js')).toBeNull()
  writeFileSync(join(f.root, 'secret'), 'PRIVATE'); linkSync(join(f.root, 'secret'), join(f.root, 'desk', 'linked'))
  expect(() => f.flow.read('linked')).toThrow()
})
it('requires fresh approval and never replays requests after restart; booth refuses', async () => {
  const f = fixture(); f.dispatch({ type: 'flow.enter' }); await vi.waitFor(() => expect(f.flow.active()).toBe(true)); f.dispatch({ type: 'flow.mode', mode: 'execute' })
  f.dispatch({ type: 'flow.run', code: 'return 42' }); const pending = f.flow.view().pending!; expect(f.run).not.toHaveBeenCalled()
  const restarted = createHeartFlow(f.opts); expect(restarted.view().pending).toBeUndefined(); expect(f.run).not.toHaveBeenCalled()
  expect(f.dispatch({ type: 'flow.approve', approvalId: pending.id, allow: true })).toBeUndefined(); await vi.waitFor(() => expect(f.flow.view().lastRun?.output).toBe('42'))
  expect(f.dispatch({ type: 'flow.approve', approvalId: pending.id, allow: true })).toBe('invalid-command')
  f.flow.write('result.txt', 'ONLY_WORK_SOURCE'); f.dispatch({ type: 'flow.exit' }); expect(f.emit).toHaveBeenCalledOnce()
  expect(f.emit.mock.calls[0][1]).not.toContain('ONLY_WORK_SOURCE'); expect(f.emit.mock.calls[0][1]).toContain('fileEvidence')
  const booth = fixture(true); booth.dispatch({ type: 'flow.enter' }); await vi.waitFor(() => expect(booth.flow.active()).toBe(true)); booth.dispatch({ type: 'flow.mode', mode: 'execute' })
  expect(booth.dispatch({ type: 'flow.run', code: 'return 1' })).toBe('unavailable')
})
it('keeps the frozen prefix stable and marks all work as ineligible for memory', async () => {
  const f = fixture(); f.dispatch({ type: 'flow.enter' }); await vi.waitFor(() => expect(f.flow.active()).toBe(true))
  const first = await f.flow.prepareContext('turn', new AbortController().signal)
  f.clock.advanceBy(86400000)
  f.store.append({ type: 'user/message', id: 'work', text: 'WORK_ONLY', requestId: 'r', commandHash: 'h' })
  const second = await f.flow.prepareContext('next', new AbortController().signal)
  expect(second.messages.slice(0, first.messages.length)).toEqual(first.messages); expect(second.eligibleIndexes).toEqual([])
  const tools = deskTools(f.flow); expect(tools.some((tool) => tool.definition.name === 'run_javascript')).toBe(true)
})
it('does not project a failed write as an applied change', async () => {
  const f = fixture(); f.dispatch({ type: 'flow.enter' }); await vi.waitFor(() => expect(f.flow.active()).toBe(true)); f.dispatch({ type: 'flow.mode', mode: 'execute' })
  vi.spyOn(f.desk, 'write').mockImplementation(() => { throw new Error('SYNTHETIC_DISK_FAILURE') })
  expect(() => f.flow.write('failed.txt', 'NEVER_WRITTEN')).toThrow(); expect(f.flow.view().changes).toHaveLength(0)
  expect(f.store.records().filter((row) => row.type === 'desk/settled')).toMatchObject([{ status: 'failed' }])
})
it('can exit after many long-path writes and runs, including after restart', async () => {
  const f = fixture(); f.dispatch({ type: 'flow.enter' }); await vi.waitFor(() => expect(f.flow.active()).toBe(true)); f.dispatch({ type: 'flow.mode', mode: 'execute' })
  const flowId = f.flow.view().activeId!
  for (let index = 0; index < 12; index++) {
    f.flow.write('d'.repeat(60) + '/' + 'f'.repeat(60) + index + '.txt', 'WORK_SOURCE_MUST_NOT_ESCAPE')
    f.store.append({ type: 'flow/run', id: 'run-'.padEnd(34, 'x') + index, flowId, status: 'completed', codeHash: 'a'.repeat(64) })
  }
  const restarted = createHeartFlow(f.opts)
  expect(restarted.dispatch({ type: 'flow.exit' } as AppCommand)).toBeUndefined()
  expect(restarted.active()).toBe(false)
  const summary = f.emit.mock.calls[0][1]; expect(summary.length).toBeLessThanOrEqual(2000)
  expect(summary).not.toContain('WORK_SOURCE_MUST_NOT_ESCAPE')
  expect(JSON.parse(summary)).toMatchObject({ fileCount: 12, runCount: 12 })
  expect(JSON.parse(summary).fileEvidence.length).toBeGreaterThan(0); expect(JSON.parse(summary).runs.length).toBeGreaterThan(0)
})
it('rejects invalid UTF-8 snapshot size and NUL before appending a write intent', async () => {
  const f = fixture(); f.dispatch({ type: 'flow.enter' }); await vi.waitFor(() => expect(f.flow.active()).toBe(true)); f.dispatch({ type: 'flow.mode', mode: 'execute' })
  const before = f.store.records().length
  for (const text of ['字'.repeat(22_000), 'short\0text', '\ud800']) expect(() => f.flow.write('a.txt', text)).toThrow()
  expect(f.store.records()).toHaveLength(before); expect(f.desk.read('a.txt')).toBeNull()
  f.flow.write('a.txt', '字'.repeat(21_333) + 'x'); expect(Buffer.byteLength(f.desk.read('a.txt')!)).toBe(64_000)
})
it('inspects only this owner flow with measured usage, bounded user-only diffs and exact external-edit status', async () => {
  const f = fixture(); f.dispatch({ type: 'flow.enter' }); await vi.waitFor(() => expect(f.flow.active()).toBe(true)); f.dispatch({ type: 'flow.mode', mode: 'execute' })
  const id = f.flow.view().activeId!; const change = f.flow.write('private.md', 'PRIVATE_DESK_DIFF_CANARY')
  expect(f.flow.inspect({ section: 'status' })).toMatchObject({ scope: 'desk-only', approval: 'each-run', cost: null, inputTokens: null, outputTokens: null, changes: [] })
  f.store.append({ type: 'turn/start', turnId: 'test', trigger: 'user' })
  f.store.append({ type: 'model/attempt', turnId: 'test', slot: 'chat', attempt: 1, waitMs: 0, status: 'success', inputTokens: 10, outputTokens: 4 })
  f.store.append({ type: 'model/attempt', turnId: 'background-private', slot: 'privacy', attempt: 1, waitMs: 0, status: 'success', inputTokens: 1000, outputTokens: 400 })
  expect(f.flow.inspect({ section: 'status' })).toMatchObject({ inputTokens: 10, outputTokens: 4 })
  expect(f.flow.inspect({ section: 'diff', flowId: id }).changes).toMatchObject([{ id: change, before: null, after: 'PRIVATE_DESK_DIFF_CANARY', current: true }])
  expect(JSON.stringify(f.flow.view())).not.toContain('PRIVATE_DESK_DIFF_CANARY'); f.desk.write('private.md', 'EXTERNAL')
  expect(f.flow.inspect({ section: 'diff' }).changes[0].current).toBe(false)
  expect(() => f.flow.inspect({ section: 'diff', flowId: 'foreign-flow' })).toThrow()
  f.flow.write('long.md', 'a'.repeat(64000)); expect(f.flow.inspect({ section: 'diff' }).truncated).toBe(true)
  expect(JSON.stringify(f.flow.inspect({ section: 'diff' })).length).toBeLessThan(100000)
})
it('resumes closed work as a fresh plan-only flow and never revives old approvals or ordinary context', async () => {
  const f = fixture(); f.dispatch({ type: 'flow.enter' }); await vi.waitFor(() => expect(f.flow.active()).toBe(true)); f.dispatch({ type: 'flow.mode', mode: 'execute' })
  const oldId = f.flow.view().activeId!; f.flow.write('a.md', 'ONLY_PRIVATE_SOURCE'); f.dispatch({ type: 'flow.run', code: 'return 9' }); const approval = f.flow.view().pending!.id
  f.dispatch({ type: 'flow.exit' }); expect(f.flow.active()).toBe(false)
  const restarted = createHeartFlow(f.opts); expect(restarted.dispatch({ type: 'flow.resume', flowId: oldId } as AppCommand)).toBeUndefined()
  expect(restarted.view().mode).toBe('plan'); expect(restarted.view().pending).toBeUndefined(); expect(restarted.view().activeId).not.toBe(oldId)
  expect(() => restarted.write('a.md', 'blocked')).toThrow(); expect(restarted.dispatch({ type: 'flow.approve', approvalId: approval, allow: true } as AppCommand)).toBe('invalid-command')
  const prepared = await restarted.prepareContext('next', new AbortController().signal); expect(prepared.eligibleIndexes).toEqual([])
  expect(JSON.stringify(prepared.messages)).toContain(oldId); expect(JSON.stringify(prepared.messages)).not.toContain('ONLY_PRIVATE_SOURCE')
  expect(f.run).not.toHaveBeenCalled(); restarted.close()
})
it('routes slash inspections and compact focus without a model turn, rejects no-op undo and mini reads', async () => {
  const f = fixture(); f.dispatch({ type: 'flow.enter' }); await vi.waitFor(() => expect(f.flow.active()).toBe(true))
  const controller = createAppController(f.clock, undefined, f.store); controller.attachHeartFlow(f.flow)
  const send = (text: string) => controller.dispatch({ protocolVersion: 1, epoch: controller.getSnapshot().epoch, requestId: crypto.randomUUID(), type: 'message.send', text })
  for (const text of ['/status', '/permissions', '/diff']) expect(send(text).status).toBe('accepted')
  expect(f.inspect.mock.calls.map(([view]) => view.section)).toEqual(['status', 'permissions', 'diff'])
  expect(send('/undo').status).toBe('rejected'); expect(send('/compact 重点保留文件版本').status).toBe('accepted')
  const compact = f.store.records().findLast((row) => row.type === 'flow/compact'); expect(compact).toMatchObject({ focus: '重点保留文件版本' })
  expect(send('/compact ' + 'x'.repeat(501)).status).toBe('rejected')
  expect(controller.dispatch({ protocolVersion: 1, epoch: controller.getSnapshot().epoch, requestId: 'mini', type: 'flow.inspect', section: 'diff' }, 'mini').status).toBe('rejected')
  expect(f.store.records().some((row) => row.type === 'turn/start')).toBe(false); controller.dispose()
})
it('persists user-owned goals across flows, keeps them in the work layer and exposes no model writer', async () => {
  const f = fixture(); f.dispatch({ type: 'flow.goal.set', text: '完成纸桥项目' }); const goal = f.flow.view().goals![0]
  expect(goal).toMatchObject({ status: 'active', confirmedBy: 'user', closedAtMs: null, flowIds: [] })
  f.dispatch({ type: 'flow.enter' }); await vi.waitFor(() => expect(f.flow.active()).toBe(true)); const id = f.flow.view().activeId!
  const first = await f.flow.prepareContext('goal', new AbortController().signal); expect(JSON.stringify(first.messages)).toContain('完成纸桥项目'); expect(first.eligibleIndexes).toEqual([])
  const prefix = f.store.records().find((row) => row.type === 'flow/open'); expect(JSON.stringify(prefix)).not.toContain('完成纸桥项目')
  f.dispatch({ type: 'flow.goal.set', goalId: goal.id, text: '先做纸桥测试' }); expect(f.flow.view().goals).toHaveLength(1)
  f.dispatch({ type: 'flow.exit' }); f.dispatch({ type: 'flow.resume', flowId: id }); const next = f.flow.view().activeId!
  expect(f.flow.view().goals![0].flowIds).toEqual([id, next]); expect(f.flow.view().mode).toBe('plan')
  f.dispatch({ type: 'flow.goal.status', goalId: goal.id, status: 'completed' }); expect(f.flow.view().goals![0]).toMatchObject({ status: 'completed', confirmedBy: 'user', closedAtMs: f.clock.nowMs() })
  const restarted = createHeartFlow(f.opts); expect(restarted.view().goals![0].status).toBe('completed'); expect(restarted.view().goalId).toBe(goal.id)
  const tools = deskTools(restarted); expect(tools.filter((tool) => /goal/.test(tool.definition.name)).map((tool) => tool.definition.name)).toEqual(['get_flow_goals'])
  expect(f.dispatch({ type: 'flow.goal.status', goalId: randomUUID(), status: 'completed' })).toBe('invalid-command'); restarted.close()
})
it('routes /goal with text locally even outside a flow and rejects empty, private and mini commands', () => {
  const f = fixture(); const controller = createAppController(f.clock, undefined, f.store); controller.attachHeartFlow(f.flow)
  const send = (text: string) => controller.dispatch({ protocolVersion: 1, epoch: controller.getSnapshot().epoch, requestId: crypto.randomUUID(), type: 'message.send', text })
  expect(send('/goal 写一个计算器').status).toBe('accepted'); const id = f.flow.view().goalId!
  expect(send('/goal 先核对计算器测试').status).toBe('accepted'); expect(f.flow.view().goals).toHaveLength(1); expect(f.flow.view().goalId).toBe(id)
  expect(send('/goal').status).toBe('rejected'); expect(send('/goal ' + 'x'.repeat(201)).status).toBe('rejected')
  expect(send('/goal sk-syntheticgoalcredential1234567890').status).toBe('rejected')
  expect(controller.dispatch({ protocolVersion: 1, epoch: controller.getSnapshot().epoch, requestId: randomUUID(), type: 'flow.goal.set', text: 'mini' }, 'mini').status).toBe('rejected')
  expect(f.store.records().some((row) => row.type === 'turn/start')).toBe(false); controller.dispose()
})
it('retains the active request through real harness read/write steps after automatic 80k compaction (#2)', async () => {
  const f = fixture(); f.dispatch({ type: 'flow.enter' }); await vi.waitFor(() => expect(f.flow.active()).toBe(true)); f.dispatch({ type: 'flow.mode', mode: 'execute' }); f.flow.write('input.md', 'SYNTHETIC_INPUT')
  for (let index = 0; index < 6; index++) { f.store.append({ type: 'user/message', id: 'old-' + index, text: 'old'.repeat(6000), requestId: 'old-' + index, commandHash: 'old' }); f.store.append({ type: 'inbox/drain', ids: ['old-' + index] }) }
  let count = 0; const inputs: string[] = []
  const harness = createHarness({ store: f.store, clock: f.clock, tools: deskTools(f.flow), prepareContext: f.flow.prepareContext, model: { source: 'fake', complete: async (request) => {
    inputs.push(JSON.stringify(request.messages)); const index = count++
    return { text: index === 2 ? 'done' : '', usage: { inputTokens: 0, outputTokens: 0 }, toolCalls: index < 2 ? [{ id: 'step-' + index, name: index === 0 ? 'desk_read' : 'desk_write', arguments: JSON.stringify(index === 0 ? { path: 'input.md' } : { path: 'result.md', text: 'REAL_SAVED_PRODUCT' }) }] : [] }
  } } })
  try {
    harness.send('CURRENT_REQUEST_CANARY: read input.md then write result.md', 'current', 'current'); await harness.idle()
    expect(inputs).toHaveLength(3); for (const input of inputs) expect(input).toContain('CURRENT_REQUEST_CANARY')
    expect(f.desk.read('result.md')).toBe('REAL_SAVED_PRODUCT')
    const checkpoint = f.store.records().findLast((row) => row.type === 'flow/compact'); expect(JSON.stringify(checkpoint)).toContain('CURRENT_REQUEST_CANARY')
    const reopened = createHeartFlow(f.opts); expect(JSON.stringify((await reopened.prepareContext('after-restart', new AbortController().signal)).messages)).toContain('CURRENT_REQUEST_CANARY'); reopened.close()
  } finally { await harness.dispose() }
})
