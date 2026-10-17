import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import type { AppCommand } from '../../src/shared'
import type { SessionStore } from '../../src/main/store/session'
import { createManualClock } from '../../src/main/clock'
import { openJournal } from '../../src/main/journal/file'
import { projectJournal } from '../../src/main/journal/projection'
import { createDesk } from '../../src/main/heart-flow/desk'
import { createHeartFlow } from '../../src/main/heart-flow/service'

const cleanup: (() => void)[] = []
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close() })
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'lca-rewind-')); const clock = createManualClock(1000)
  const journal = openJournal(root, { userId: 'u', characterId: 'c' }, clock)
  const store: SessionStore = { scope: journal.scope, records: journal.records, append: journal.append, projection: () => projectJournal(journal.records()), close: journal.close }
  const desk = createDesk(join(root, 'desk')); let busy = false
  const options = { store, clock, desk, booth: false, busy: () => busy, changed: () => {}, prepare: async () => ({ messages: [], eligibleIndexes: [] }), emit: () => {}, run: async () => '' }
  const flow = createHeartFlow(options)
  cleanup.push(() => { flow.close(); store.close(); if (!resolve(root).startsWith(join(resolve(tmpdir()), 'lca-rewind-'))) throw new Error('UNSAFE'); rmSync(root, { recursive: true, force: true }) })
  const send = (body: object) => flow.dispatch({ protocolVersion: 1, epoch: 'test', requestId: randomUUID(), ...body } as AppCommand)
  send({ type: 'flow.enter' }); await vi.waitFor(() => expect(flow.active()).toBe(true)); send({ type: 'flow.mode', mode: 'execute' })
  const settle = async () => { await vi.waitFor(() => { clock.advanceBy(0); expect(flow.view().rewind?.status).not.toBe('running') }) }
  return { store, desk, flow, options, clock, send, settle, busy: (value: boolean) => { busy = value } }
}
it('restores multiple files to before a boundary, including repeated edits, deletion and old undo', async () => {
  const f = await fixture(); f.desk.write('a.txt', 'baseline'); f.desk.write('c.txt', 'previous c')
  const boundary = f.flow.write('a.txt', 'a1'); f.flow.write('b.txt', 'b1'); f.flow.write('a.txt', 'a2'); f.flow.write('c.txt', null)
  const b2 = f.flow.write('b.txt', 'b2'); expect(f.send({ type: 'flow.undo', changeId: b2 })).toBeUndefined()
  const oldCount = f.store.records().length
  expect(f.send({ type: 'flow.rewind.prepare', changeId: boundary })).toBeUndefined()
  expect(f.flow.view().rewind).toMatchObject({ status: 'awaiting-confirmation', changeCount: 6, appliedFiles: 0 }); expect(f.desk.read('a.txt')).toBe('a2'); expect(f.desk.read('b.txt')).toBe('b1')
  const id = f.flow.view().rewind!.id; expect(f.send({ type: 'flow.rewind.apply', rewindId: id })).toBeUndefined()
  expect(() => f.flow.write('concurrent.txt', 'blocked')).toThrow(); expect(f.flow.commandAllowed()).toBe(false)
  await f.settle(); expect(f.flow.view().rewind).toMatchObject({ status: 'completed', appliedFiles: 3 })
  expect(f.desk.read('a.txt')).toBe('baseline'); expect(f.desk.read('b.txt')).toBeNull(); expect(f.desk.read('c.txt')).toBe('previous c')
  expect(f.flow.view().changes.every((change) => change.undone)).toBe(true); expect(f.flow.inspect({ section: 'diff' }).changes.every((change) => change.undone)).toBe(true)
  expect(f.store.records().length).toBeGreaterThan(oldCount); expect(f.send({ type: 'flow.rewind.apply', rewindId: id })).toBe('invalid-command')
  const prepared = await f.flow.prepareContext('after', new AbortController().signal); expect(prepared.eligibleIndexes).toEqual([]); expect(JSON.stringify(prepared.messages)).toContain('recordedFileRewind')
})
it.each(['file', 'new-record'] as const)('rejects stale confirmation before any writes after %s', async (cause) => {
  const f = await fixture(); const boundary = f.flow.write('a.txt', 'a'); f.flow.write('b.txt', 'b')
  f.send({ type: 'flow.rewind.prepare', changeId: boundary }); const id = f.flow.view().rewind!.id
  if (cause === 'file') f.desk.write('b.txt', 'external'); else f.flow.write('unrelated.txt', 'new')
  expect(f.send({ type: 'flow.rewind.apply', rewindId: id })).toBe('invalid-command')
  expect(f.flow.view().rewind).toMatchObject({ status: 'failed', error: 'conflict', appliedFiles: 0 }); expect(f.desk.read('a.txt')).toBe('a')
})
it.each(['cancel', 'stop', 'lights', 'goal', 'exit'] as const)('keeps truthful partial files when interrupted by %s', async (cause) => {
  const f = await fixture(); const boundary = f.flow.write('a.txt', 'a'); f.flow.write('b.txt', 'b'); f.flow.write('c.txt', 'c')
  f.send({ type: 'flow.rewind.prepare', changeId: boundary }); const id = f.flow.view().rewind!.id; f.send({ type: 'flow.rewind.apply', rewindId: id })
  expect(f.desk.read('c.txt')).toBeNull()
  if (cause === 'cancel') f.send({ type: 'flow.rewind.cancel', rewindId: id })
  if (cause === 'stop') f.flow.stopChildren()
  if (cause === 'goal') f.send({ type: 'flow.goal.set', text: 'different task' })
  if (cause === 'exit') f.send({ type: 'flow.exit' })
  if (cause === 'lights') { f.store.append({ type: 'companion/lights', lightsOut: true, requestId: 'off', commandHash: 'off' }); f.flow.stateChanged() }
  await f.settle(); expect(f.desk.read('a.txt')).toBe('a'); expect(f.desk.read('b.txt')).toBe('b')
  const row = f.store.records().findLast((row) => row.type === 'flow/rewind'); expect(row).toMatchObject({ status: 'cancelled', appliedFiles: 1 })
})
it('reports disk failure and only marks verified snapshots as undone', async () => {
  const f = await fixture(); const a = f.flow.write('a.txt', 'a'); f.flow.write('b.txt', 'b')
  f.send({ type: 'flow.rewind.prepare', changeId: a }); const realWrite = f.desk.write; let writes = 0
  vi.spyOn(f.desk, 'write').mockImplementation((path, text) => { if (++writes === 2) throw new Error('SYNTHETIC_DISK_FAILURE'); realWrite(path, text) })
  f.send({ type: 'flow.rewind.apply', rewindId: f.flow.view().rewind!.id }); await f.settle()
  expect(f.flow.view().rewind).toMatchObject({ status: 'failed', appliedFiles: 1, error: 'write-failed' }); expect(f.desk.read('a.txt')).toBe('a'); expect(f.desk.read('b.txt')).toBeNull()
  expect(f.flow.view().changes.find((change) => change.id === a)?.undone).toBe(false)
})
it('reconciles a crash after a file write and never resumes the remaining files', async () => {
  const f = await fixture(); const boundary = f.flow.write('a.txt', 'a'); f.flow.write('b.txt', 'b')
  f.send({ type: 'flow.rewind.prepare', changeId: boundary }); const view = f.flow.view().rewind!; f.flow.close()
  f.store.append({ type: 'flow/rewind', ...view, paths: [...view.paths], flowId: f.flow.id()!, status: 'running' })
  const changeId = randomUUID(); f.store.append({ type: 'desk/change', id: changeId, flowId: f.flow.id()!, path: 'b.txt', before: 'b', after: null, pending: true, rewindId: view.id, rewinds: [f.flow.view().changes.find((change) => change.path === 'b.txt')!.id] }); f.desk.write('b.txt', null)
  const reopened = createHeartFlow(f.options); cleanup.push(reopened.close)
  expect(reopened.view().rewind).toMatchObject({ status: 'interrupted', appliedFiles: 1 }); expect(f.desk.read('a.txt')).toBe('a'); expect(f.desk.read('b.txt')).toBeNull()
  expect(reopened.dispatch({ protocolVersion: 1, epoch: 'x', requestId: 'x', type: 'flow.rewind.apply', rewindId: view.id })).toBe('invalid-command')
})
it('does not start in plan mode, while a parent is busy, or from another flow', async () => {
  const f = await fixture(); const boundary = f.flow.write('a.txt', 'a'); f.busy(true)
  expect(f.send({ type: 'flow.rewind.prepare', changeId: boundary })).toBe('unavailable'); f.busy(false)
  f.send({ type: 'flow.mode', mode: 'plan' }); expect(f.send({ type: 'flow.rewind.prepare', changeId: boundary })).toBe('unavailable')
  f.send({ type: 'flow.exit' }); f.send({ type: 'flow.enter' }); await vi.waitFor(() => expect(f.flow.active()).toBe(true)); f.send({ type: 'flow.mode', mode: 'execute' })
  expect(f.send({ type: 'flow.rewind.prepare', changeId: boundary })).toBe('invalid-command')
})
it.runIf(process.platform === 'win32')('refuses ambiguous Windows case aliases instead of overwriting twice', async () => {
  const f = await fixture(); const boundary = f.flow.write('a.txt', 'a'); f.flow.write('A.txt', 'b')
  expect(f.send({ type: 'flow.rewind.prepare', changeId: boundary })).toBe('invalid-command'); expect(f.desk.read('a.txt')).toBe('b')
})
