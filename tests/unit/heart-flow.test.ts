import { mkdtempSync, rmSync, linkSync, writeFileSync } from 'node:fs'
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
const cleanups: (() => void)[] = []
afterEach(() => cleanups.splice(0).reverse().forEach((cleanup) => cleanup()))
function fixture(booth = false) {
  const root = mkdtempSync(join(tmpdir(), 'lca-flow-')); cleanups.push(() => { if (!resolve(root).startsWith(join(resolve(tmpdir()), 'lca-flow-'))) throw new Error('UNSAFE'); rmSync(root, { recursive: true, force: true }) })
  const clock = createManualClock(1000); const journal = openJournal(root, { userId: 'u', characterId: 'c' }, clock)
  const store: SessionStore = { scope: journal.scope, records: journal.records, append: journal.append, projection: () => projectJournal(journal.records()), close: journal.close }
  const desk = createDesk(join(root, 'desk')); const run = vi.fn(async () => '42'); const emit = vi.fn()
  const opts = { store, clock, desk, booth, busy: () => false, changed: () => {}, prepare: async () => ({ messages: [{ role: 'system' as const, content: 'frozen' }], eligibleIndexes: [] }), emit, run }
  const flow = createHeartFlow(opts); cleanups.push(store.close); cleanups.push(flow.close)
  const dispatch = (body: Record<string, unknown>) => flow.dispatch({ ...body, protocolVersion: 1, epoch: 'x', requestId: 'x' } as AppCommand)
  return { root, store, clock, desk, run, emit, flow, opts, dispatch }
}
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
