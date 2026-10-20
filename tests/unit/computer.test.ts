import { createHash, randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { createManualClock } from '../../src/main/clock'
import { createDeskComputer } from '../../src/main/computer/service'
import { createDesk } from '../../src/main/legacy-flow/desk'
import { createBinaryAssets } from '../../src/main/storage/assets'
import { openJournal } from '../../src/main/journal/file'
import { projectJournal } from '../../src/main/journal/projection'
import type { SessionStore } from '../../src/main/store/session'
import type { AppCommand } from '../../src/shared'
import type { ToolContext } from '../../src/main/harness/tools'
const cleanup: (() => void)[] = []; afterEach(() => cleanup.splice(0).reverse().forEach((fn) => fn()))
// Unit envelope only; actual PNG pixels and browser actions are verified by Electron separately.
function png() { const bytes = Buffer.alloc(33); Buffer.from('89504e470d0a1a0a', 'hex').copy(bytes); bytes.write('IHDR', 12, 'ascii'); bytes.writeUInt32BE(800, 16); bytes.writeUInt32BE(600, 20); return bytes }
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'lca-computer-')); cleanup.push(() => { if (!resolve(root).startsWith(join(resolve(tmpdir()), 'lca-computer-'))) throw new Error('UNSAFE'); rmSync(root, { recursive: true, force: true }) })
  const clock = createManualClock(1000); const journal = openJournal(root, { userId: 'u', characterId: 'c' }, clock); cleanup.push(journal.close)
  const store: SessionStore = { scope: journal.scope, append: journal.append, records: journal.records, projection: () => projectJournal(journal.records()), close: journal.close }
  const desk = createDesk(join(root, 'desk')); desk.write('ui.html', '<input placeholder="PRIVATE_DESK_CONTENT">')
  const assets = createBinaryAssets(root, store); let allowed = true; let flowId: string | null = 'flow'; let revision = 'a'.repeat(64)
  const act = vi.fn(async () => { revision = 'b'.repeat(64) }); const closed = vi.fn(); const open = vi.fn(async (...parameters: [string, () => void, AbortSignal]) => { void parameters; return { capture: async () => ({ png: png(), fingerprint: revision }), fingerprint: async () => revision, act, close: closed } })
  const options = { store, clock, assets, allowed: () => allowed, flowId: () => flowId, read: desk.read, open, changed: () => {} }; const service = createDeskComputer(options); cleanup.push(service.close)
  const dispatch = (body: object) => service.dispatch(body as AppCommand)
  const context: ToolContext = { store, clock, turnId: 'turn', signal: new AbortController().signal }
  const tools = service.tools(); const observe = () => tools[0].run({}, context)
  const action = (signal = context.signal, frameRef = service.view().frame!.ref) => tools[1].run({ frameRef, action: { type: 'click', x: 100, y: 100 } }, { ...context, signal })
  const opened = async () => { expect(dispatch({ type: 'flow.computer.open', path: 'ui.html' })).toBeUndefined(); await vi.waitFor(() => expect(service.view().status).toBe('ready')) }
  return { store, clock, desk, assets, options, service, dispatch, observe, action, opened, act, closed, tools, block: () => { allowed = false; service.stateChanged() }, revision: () => { revision = 'c'.repeat(64) }, foreign: () => { flowId = 'foreign-flow' } }
}
it('opens only an explicit allowed desk HTML and exposes metadata, opaque frames and no public asset broker capability', async () => {
  const f = fixture(); expect(f.dispatch({ type: 'flow.computer.open', path: '../private.html' })).toBe('invalid-command'); expect(f.dispatch({ type: 'flow.computer.open', path: 'private.txt' })).toBe('invalid-command'); await f.opened()
  expect(f.options.open.mock.calls[0][0]).toContain('PRIVATE_DESK_CONTENT'); expect(JSON.stringify(f.service.view())).not.toContain('PRIVATE_DESK_CONTENT')
  const ref = f.service.view().frame!.ref; expect(f.service.resolve(ref).equals(png())).toBe(true); expect(f.assets.owned(f.service.view().frame!.sha256)).toBeUndefined()
  await f.observe(); expect(f.service.view().frame!.ref).not.toBe(ref); await expect(f.action(undefined, ref)).rejects.toThrow()
  f.foreign(); expect(() => f.service.resolve(ref)).toThrow(); f.block(); expect(f.service.view().status).toBe('closed'); expect(f.dispatch({ type: 'flow.computer.open', path: 'ui.html' })).toBe('permission-denied')
})
it('requires a distinct current approval for each action and reports pixels/dispatch rather than business success', async () => {
  const f = fixture(); await f.opened(); const pending = f.action(); await vi.waitFor(() => expect(f.service.view().pending).toBeDefined()); expect(f.act).not.toHaveBeenCalled()
  const id = f.service.view().pending!.id; expect(f.dispatch({ type: 'flow.computer.approve', approvalId: randomUUID(), allow: true })).toBe('invalid-command'); expect(f.act).not.toHaveBeenCalled()
  expect(f.dispatch({ type: 'flow.computer.approve', approvalId: id, allow: true })).toBeUndefined(); const result = await pending; expect(result.ok).toBe(true); expect(result.visible).toMatchObject({ dispatchOnly: true, verifyPixelsBeforeClaimingCompletion: true }); expect(result.imageRefs).toHaveLength(1)
  await vi.waitFor(() => expect(f.service.view().pending).toBeUndefined()); expect(f.act).toHaveBeenCalledOnce(); expect(f.service.view().actionsUsed).toBe(1)
  expect(f.dispatch({ type: 'flow.computer.approve', approvalId: id, allow: true })).toBe('invalid-command')
  const second = f.action(); await vi.waitFor(() => expect(f.service.view().pending).toBeDefined()); f.dispatch({ type: 'flow.computer.approve', approvalId: f.service.view().pending!.id, allow: false }); expect((await second).ok).toBe(false); expect(f.act).toHaveBeenCalledOnce()
})
it.each(['page', 'source', 'abort', 'timeout', 'blocked', 'new-input'] as const)('invalidates stale approval on %s and does not replay after restart', async (reason) => {
  const f = fixture(); await f.opened(); const abort = new AbortController(); const pending = f.action(abort.signal); await vi.waitFor(() => expect(f.service.view().pending).toBeDefined()); const id = f.service.view().pending!.id
  if (reason === 'page') f.revision(); if (reason === 'source') f.desk.write('ui.html', 'CHANGED'); if (reason === 'abort') abort.abort(); if (reason === 'timeout') f.clock.advanceBy(30000); if (reason === 'blocked') f.block()
  if (reason === 'new-input') f.service.interruptPending()
  f.dispatch({ type: 'flow.computer.approve', approvalId: id, allow: true }); expect((await pending).ok).toBe(false); expect(f.act).not.toHaveBeenCalled()
  const restart = createDeskComputer(f.options); expect(restart.view().status).toBe('closed'); expect(restart.view().pending).toBeUndefined(); expect(restart.dispatch({ type: 'flow.computer.approve', approvalId: id, allow: true } as AppCommand)).not.toBeUndefined(); restart.close()
})
it('bounds actions, observations and key/text forms and keeps frame bytes outside journal/ordinary text projections', async () => {
  const f = fixture(); await f.opened()
  for (let i = 0; i < 8; i++) { const pending = f.action(); await vi.waitFor(() => expect(f.service.view().pending).toBeDefined()); f.dispatch({ type: 'flow.computer.approve', approvalId: f.service.view().pending!.id, allow: true }); await pending; await vi.waitFor(() => expect(f.service.view().pending).toBeUndefined()) }
  await expect(f.action()).rejects.toThrow(); expect(f.act).toHaveBeenCalledTimes(8)
  for (let i = 9; i < 20; i++) await f.observe(); await expect(f.observe()).rejects.toThrow()
  for (const action of [{ type: 'click', x: 800, y: 10 }, { type: 'key', key: 'CTRL+L' }, { type: 'type', text: 'x'.repeat(81) }, { type: 'type', text: 'a\nb' }, { type: 'type', text: 'sk-syntheticcredential123456789' }]) expect(f.tools[1].validate({ frameRef: f.service.view().frame!.ref, action })).toBe(false)
  expect(JSON.stringify(f.store.records())).not.toContain(png().toString('base64')); expect(f.store.projection().context).toEqual([])
  const actions = f.store.records().filter((row) => row.type === 'flow/computer-action'); expect(actions.filter((row) => row.status === 'dispatched')).toHaveLength(8)
  expect(actions[0]).toMatchObject({ actionHash: createHash('sha256').update(JSON.stringify({ type: 'click', x: 100, y: 100 })).digest('hex') })
})
it('times out opening/capture and discards a late port/frame without producing new evidence', async () => {
  const f = fixture(); let openDone!: (port: Awaited<ReturnType<typeof f.options.open>>) => void
  const fakePort = await f.options.open('', () => {}, new AbortController().signal)
  f.options.open.mockImplementationOnce(() => new Promise((done) => { openDone = done })); f.dispatch({ type: 'flow.computer.open', path: 'ui.html' }); f.clock.advanceBy(10000)
  expect(f.service.view().status).toBe('closed'); openDone(fakePort); await Promise.resolve(); await Promise.resolve(); expect(f.closed).toHaveBeenCalled(); expect(f.store.records().some((row) => row.type === 'flow/computer-frame')).toBe(false)
  await f.opened(); const port = await f.options.open.mock.results.at(-1)!.value; let captureDone!: (value: { png: Buffer; fingerprint: string }) => void
  vi.spyOn(port, 'capture').mockImplementationOnce(() => new Promise((done) => { captureDone = done })); const reading = f.observe(); f.clock.advanceBy(5000); await expect(reading).rejects.toThrow(); expect(f.service.view().status).toBe('closed')
  const count = f.store.records().filter((row) => row.type === 'flow/computer-frame').length; captureDone({ png: png(), fingerprint: 'd'.repeat(64) }); await Promise.resolve(); await Promise.resolve(); expect(f.store.records().filter((row) => row.type === 'flow/computer-frame')).toHaveLength(count)
})
