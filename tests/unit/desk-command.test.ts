import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readdirSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { createManualClock } from '../../src/main/clock'
import { openJournal } from '../../src/main/journal/file'
import { projectJournal } from '../../src/main/journal/projection'
import { createDesk } from '../../src/main/heart-flow/desk'
import { createHeartFlow } from '../../src/main/heart-flow/service'
import { createDeskCommands } from '../../src/main/desk-command/service'
import { deskCommandInput } from '../../src/main/desk-command/schema'
import type { CommandProcessPort, CommandProcessResult } from '../../src/main/desk-command/process'
import { CommandProcessFailure } from '../../src/main/desk-command/process'
import type { SessionStore } from '../../src/main/store/session'
import type { AppCommand } from '../../src/shared'
import { createAppController } from '../../src/main/bridge/controller'

const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => { for (const fn of cleanups.splice(0).reverse()) await fn() })
const completed = (extra: Partial<CommandProcessResult> = {}): CommandProcessResult => ({ status: 'completed', exitCode: 0, stdout: 'UNIT_OUTPUT', stderr: '', appContainer: true, networkCapabilities: 0, processTreeTerminated: true, elapsedMs: 1, ...extra })
async function fixture(booth = false, run?: CommandProcessPort['run']) {
  const root = mkdtempSync(join(tmpdir(), 'lca-command-service-')); const deskRoot = join(root, 'desk'); mkdirSync(deskRoot)
  const desk = createDesk(deskRoot); const clock = createManualClock(1000); const journal = openJournal(root, { userId: 'u', characterId: 'c' }, clock)
  const store: SessionStore = { scope: journal.scope, records: journal.records, append: journal.append, projection: () => projectJournal(journal.records()), close: journal.close }
  const flow = createHeartFlow({ store, clock, desk, booth, busy: () => false, changed: () => {}, run: async () => 'legacy', prepare: async () => ({ messages: [], eligibleIndexes: [] }), emit: () => {} })
  const invoke = vi.fn(run ?? (async ({ root }) => { writeFileSync(join(root, 'result.txt'), 'ACTUAL_UNIT_PRODUCT'); return completed() }))
  const preview = vi.fn(); let failSecond = false
  const options = { store, clock, deskRoot, cacheRoot: join(root, 'cache'), booth, port: { available: () => true, run: invoke }, flowId: flow.id, allowed: flow.commandAllowed, manualAllowed: () => true, changed: vi.fn(),
    safeText: (text: string) => text.replaceAll('SECRET_CANARY', '[redacted]'), current: desk.read, publish: (id: string, edit: { path: string; before: string | null; after: string | null }) => { if (failSecond && edit.path === 'b.txt') throw new Error('DISK_FAILED'); flow.publishCommand(id, edit) }, preview }
  const commands = createDeskCommands(options); flow.attachCommands(commands)
  const command = (body: object) => ({ protocolVersion: 1, epoch: 'x', requestId: randomUUID(), ...body }) as AppCommand
  const send = (body: object) => flow.dispatch(command(body))
  send({ type: 'flow.enter' }); await vi.waitFor(() => expect(flow.active()).toBe(true)); send({ type: 'flow.mode', mode: 'execute' })
  cleanups.push(async () => { await commands.close(); flow.close(); journal.close(); if (!resolve(root).startsWith(join(resolve(tmpdir()), 'lca-command-service-'))) throw new Error('UNSAFE'); rmSync(root, { recursive: true, force: true }) })
  const wait = async (status = 'awaiting-approval') => vi.waitFor(() => expect(commands.view()?.status).toBe(status))
  const settled = async () => vi.waitFor(() => expect(commands.active()).toBe(false))
  const start = async () => { expect(send({ type: 'flow.command.run', command: 'echo unit' })).toBeUndefined(); await wait(); return commands.view()!.id }
  const approve = (id: string, allow = true) => send({ type: 'flow.command.approve', commandId: id, allow })
  return { root, desk, deskRoot, store, flow, commands, invoke, options, preview, command, send, start, wait, settled, approve, partial: () => { failSecond = true } }
}
it('requires fresh human approval, publishes through durable snapshots, and keeps output out of public state', async () => {
  const f = await fixture(); const id = await f.start(); expect(f.invoke).not.toHaveBeenCalled(); expect(f.desk.read('result.txt')).toBeNull()
  expect(() => f.flow.write('concurrent.txt', 'blocked')).toThrow(); expect(f.send({ type: 'flow.run', code: 'return 1' })).toBe('unavailable')
  expect(f.approve(id)).toBeUndefined(); await f.settled(); expect(f.invoke).toHaveBeenCalledOnce(); expect(f.desk.read('result.txt')).toBe('ACTUAL_UNIT_PRODUCT')
  expect(f.commands.view()).toMatchObject({ status: 'completed', outcome: { exitCode: 0, publication: 'applied', changedFiles: 1, appliedFiles: 1 } })
  expect(f.store.records().some((row) => row.type === 'desk/change' && row.commandId === id && row.after === 'ACTUAL_UNIT_PRODUCT')).toBe(true)
  expect(JSON.stringify(f.commands.view())).not.toContain('UNIT_OUTPUT'); expect(f.send({ type: 'flow.command.open', commandId: id })).toBeUndefined(); expect(f.preview).toHaveBeenCalledWith(id, expect.stringContaining('UNIT_OUTPUT'))
  expect(f.approve(id)).toBe('invalid-command'); f.flow.write('after.txt', 'allowed')
})
it('does not execute a denied or cancelled request', async () => {
  const f = await fixture(); const id = await f.start(); f.approve(id, false); await f.settled(); expect(f.commands.view()?.status).toBe('cancelled'); expect(f.invoke).not.toHaveBeenCalled()
  const next = await f.start(); f.send({ type: 'flow.command.cancel', commandId: next }); expect(f.approve(next)).toBe('invalid-command'); await f.settled(); expect(f.invoke).not.toHaveBeenCalled()
})
it('returns only historical command receipts to ordinary conversation on flow exit', async () => {
  const f = await fixture(); f.approve(await f.start()); await f.settled(); expect(f.send({ type: 'flow.exit' })).toBeUndefined()
  const closed = f.store.records().findLast((row) => row.type === 'flow/close'); if (closed?.type !== 'flow/close') throw new Error('MISSING_CLOSE')
  const summary = JSON.parse(closed.summary); expect(summary.commandRequestCount).toBe(1); expect(summary.commandEvidence).toMatchObject([{ status: 'completed', exitCode: 0, publication: 'applied', appliedFiles: 1 }])
  expect(closed.summary).not.toContain('UNIT_OUTPUT'); expect(closed.summary).not.toContain('ACTUAL_UNIT_PRODUCT'); expect(closed.summary.length).toBeLessThanOrEqual(2000)
})
it('refuses changed approved inputs before any process starts', async () => {
  const f = await fixture(); f.desk.write('source.txt', 'before'); const id = await f.start(); f.desk.write('source.txt', 'user changed'); f.approve(id); await f.settled()
  expect(f.invoke).not.toHaveBeenCalled(); expect(f.commands.view()?.status).toBe('failed'); expect(f.desk.read('source.txt')).toBe('user changed')
})
it('refuses a changed scratch copy even if the real desk still matches', async () => {
  const f = await fixture(); f.desk.write('source.txt', 'before'); const id = await f.start()
  const root = readdirSync(f.options.cacheRoot).find((name) => name.startsWith('lca-command-'))!; writeFileSync(join(f.options.cacheRoot, root, 'source.txt'), 'TAMPERED')
  f.approve(id); await f.settled(); expect(f.invoke).not.toHaveBeenCalled(); expect(f.desk.read('source.txt')).toBe('before'); expect(f.commands.view()?.status).toBe('failed')
})
it('marks bounded output and never cuts a Unicode surrogate pair in half', async () => {
  const f = await fixture(false, async () => completed({ stdout: 'x'.repeat(15999) + '😀tail' })); f.store.append({ type: 'turn/start', turnId: 'model', trigger: 'user' })
  const pending = f.commands.tool().run({ command: 'echo unit' }, { store: f.store, clock: f.options.clock, signal: new AbortController().signal, turnId: 'model', callId: 'call' }); await f.wait(); f.approve(f.commands.view()!.id)
  const result = await pending; expect(result.visible).toMatchObject({ outputTruncated: true, output: expect.stringContaining('[truncated]') })
  const text = JSON.stringify(result.visible); expect(text).not.toContain('\\ud83d'); await f.settled()
})
it('reports an encoding refusal as failure without publishing files', async () => {
  const f = await fixture(false, async () => { throw new CommandProcessFailure('encoding') })
  f.approve(await f.start()); await f.settled(); expect(f.commands.view()).toMatchObject({ status: 'failed', error: { code: 'command-encoding-unsupported' } }); expect(f.desk.list()).toEqual([])
})
it('preflights all output versions and preserves external conflicts without any writeback', async () => {
  let actual = ''; const f = await fixture(false, async ({ root }) => { writeFileSync(join(root, 'a.txt'), 'new A'); writeFileSync(join(root, 'b.txt'), 'new B'); writeFileSync(join(actual, 'b.txt'), 'USER_EDIT'); return completed() }); actual = f.deskRoot
  f.desk.write('a.txt', 'old A'); f.desk.write('b.txt', 'old B'); const id = await f.start(); f.approve(id); await f.settled()
  expect(f.desk.read('a.txt')).toBe('old A'); expect(f.desk.read('b.txt')).toBe('USER_EDIT'); expect(f.commands.view()).toMatchObject({ status: 'failed', outcome: { publication: 'not-applied', changedFiles: 2, appliedFiles: 0 } })
})
it.each(['nonzero', 'timeout', 'output-limit'] as const)('does not publish files after %s execution', async (kind) => {
  const f = await fixture(false, async ({ root }) => { writeFileSync(join(root, 'bad.txt'), 'PARTIAL_PROCESS_OUTPUT'); return completed(kind === 'nonzero' ? { exitCode: 1 } : { status: kind, exitCode: null }) })
  f.approve(await f.start()); await f.settled(); expect(f.commands.view()?.status).toBe('failed'); expect(f.desk.read('bad.txt')).toBeNull(); expect(f.commands.view()?.outcome?.publication).toBe('not-applied')
})
it('rejects late output from an uncooperative cancelled process', async () => {
  let release!: () => void; const f = await fixture(false, async ({ root }) => { await new Promise<void>((done) => { release = done }); writeFileSync(join(root, 'late.txt'), 'LATE'); return completed() })
  const id = await f.start(); f.approve(id); await vi.waitFor(() => expect(f.invoke).toHaveBeenCalledOnce()); f.send({ type: 'flow.command.cancel', commandId: id }); release(); await f.settled()
  expect(f.commands.view()?.status).toBe('cancelled'); expect(f.desk.read('late.txt')).toBeNull()
})
it('reports partial writeback honestly when a later durable write fails', async () => {
  const f = await fixture(false, async ({ root }) => { writeFileSync(join(root, 'a.txt'), 'A'); writeFileSync(join(root, 'b.txt'), 'B'); return completed() }); f.partial()
  f.approve(await f.start()); await f.settled(); expect(f.desk.read('a.txt')).toBe('A'); expect(f.desk.read('b.txt')).toBeNull()
  expect(f.commands.view()).toMatchObject({ status: 'failed', outcome: { publication: 'partial', changedFiles: 2, appliedFiles: 1 } })
})
it('marks interrupted requests without replay and does not log command or output text in receipts', async () => {
  const f = await fixture(); const id = await f.start(); const reopened = createDeskCommands(f.options)
  expect(reopened.view()).toBeUndefined(); expect(reopened.dispatch(f.command({ type: 'flow.command.approve', commandId: id, allow: true }), 'h')).toBe('invalid-command')
  expect(f.invoke).not.toHaveBeenCalled(); expect(f.store.records().some((r) => r.type === 'flow/command' && r.id === id && r.status === 'interrupted')).toBe(true)
  expect(JSON.stringify(f.store.records().filter((row) => row.type === 'flow/command'))).not.toContain('echo unit'); await reopened.close()
})
it.each(['legacy-partial', 'pending-settlement', 'all-published'] as const)('recovers %s from durable files and a reopened journal without replay', async (stage) => {
  const f = await fixture(); const id = randomUUID(); const flowId = f.flow.id()!
  await f.commands.close(); f.flow.close()
  f.store.append({ type: 'flow/command', id, flowId, executionHash: 'a'.repeat(64), timeoutMs: 5000, status: 'running', fileCount: 0,
    ...(stage === 'all-published' ? { outcome: { exitCode: 0, elapsedMs: 7, processTreeTerminated: true, changedFiles: 2, appliedFiles: 0, publication: 'not-applied' as const } } : {}) })
  for (const path of stage === 'all-published' ? ['a.txt', 'b.txt'] : ['a.txt']) {
    const change = randomUUID(); f.store.append({ type: 'desk/change', id: change, flowId, commandId: id, path, before: null, after: path, pending: true }); f.desk.write(path, path)
    if (stage !== 'pending-settlement') f.store.append({ type: 'desk/settled', id: change, status: 'applied' })
  }
  f.store.close()
  const journal = openJournal(f.root, f.store.scope, f.options.clock)
  const store: SessionStore = { scope: journal.scope, records: journal.records, append: journal.append, projection: () => projectJournal(journal.records()), close: journal.close }
  // Open commands first to also verify standalone pending-settlement recovery.
  const recovered = createDeskCommands({ ...f.options, store }); const row = store.records().findLast((r) => r.type === 'flow/command' && r.id === id)
  expect(row).toMatchObject({ status: 'interrupted', outcome: { publication: stage === 'all-published' ? 'applied' : 'unknown', appliedFiles: stage === 'all-published' ? 2 : 1,
    elapsedMs: stage === 'all-published' ? 7 : null, changedFiles: stage === 'all-published' ? 2 : null } })
  const flow = createHeartFlow({ store, clock: f.options.clock, desk: f.desk, booth: false, busy: () => false, changed: () => {}, run: async () => '', prepare: async () => ({ messages: [], eligibleIndexes: [] }), emit: () => {} })
  expect(flow.dispatch(f.command({ type: 'flow.exit' }))).toBeUndefined()
  const close = store.records().findLast((r) => r.type === 'flow/close'); expect(close?.type === 'flow/close' && JSON.parse(close.summary).commandEvidence).toMatchObject([{ publication: stage === 'all-published' ? 'applied' : 'unknown', appliedFiles: stage === 'all-published' ? 2 : 1 }])
  expect(f.invoke).not.toHaveBeenCalled(); await recovered.close(); flow.close(); store.close()
})
it('enforces plan, booth, disabled, schema and known-credential gates', async () => {
  const f = await fixture(); f.send({ type: 'flow.mode', mode: 'plan' }); expect(f.send({ type: 'flow.command.run', command: 'echo unit' })).toBe('unavailable')
  f.send({ type: 'flow.mode', mode: 'execute' }); expect(f.send({ type: 'flow.command.run', command: 'echo SECRET_CANARY' })).toBe('unavailable'); f.commands.setEnabled(false); expect(f.send({ type: 'flow.command.run', command: 'echo unit' })).toBe('unavailable')
  f.commands.setEnabled(true); expect(f.send({ type: 'flow.command.run', command: 'powershell -EncodedCommand ' + Buffer.from("'SECRET_CANARY'", 'utf16le').toString('base64') })).toBe('unavailable')
  const booth = await fixture(true); expect(booth.send({ type: 'flow.command.run', command: 'echo unit' })).toBe('permission-denied'); expect(booth.invoke).not.toHaveBeenCalled()
  for (const command of ['x\ny', 'x\u202ey', '\ud800', 'x'.repeat(6001)]) expect(deskCommandInput.safeParse({ command }).success).toBe(false)
  expect(deskCommandInput.safeParse({ command: 'echo hi', timeoutMs: 30001 }).success).toBe(false)
})
it('keeps approval book-only and makes duplicate request IDs harmless', async () => {
  const f = await fixture(); const controller = createAppController(f.options.clock, undefined, f.store); controller.attachHeartFlow(f.flow)
  const command = { ...f.command({ type: 'flow.command.run', command: 'echo unit' }), epoch: controller.getSnapshot().epoch }
  expect(controller.dispatch(command, 'mini')).toMatchObject({ status: 'rejected', error: { code: 'permission-denied' } }); expect(controller.dispatch(command)).toMatchObject({ status: 'accepted' }); expect(controller.dispatch(command)).toMatchObject({ status: 'accepted' })
  await f.wait(); expect(f.store.records().filter((row) => row.type === 'flow/command' && row.status === 'preparing')).toHaveLength(1); controller.dispose()
})
it('new user work cancels old waiting approval and rejects unsupported output', async () => {
  const f = await fixture(false, async ({ root }) => { writeFileSync(join(root, 'binary.bin'), Buffer.from([0xff])); return completed() })
  await f.start(); f.flow.interruptDraft(); await f.settled(); expect(f.invoke).not.toHaveBeenCalled()
  f.approve(await f.start()); await f.settled(); expect(f.commands.view()?.status).toBe('failed'); expect(f.desk.list()).toEqual([])
})
