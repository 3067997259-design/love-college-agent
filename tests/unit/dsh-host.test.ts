import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { createManualClock } from '../../src/main/clock'
import { startDshHost, type DshHostOptions } from '../../src/main/dsh/host'

const mocked = vi.hoisted(() => ({ spawn: vi.fn() }))
vi.mock('node:child_process', () => ({ spawn: mocked.spawn }))
const roots: string[] = []
afterEach(() => {
  vi.clearAllMocks()
  for (const root of roots.splice(0)) {
    if (!resolve(root).startsWith(join(resolve(tmpdir()), 'lca-dsh-host-'))) throw new Error('Unsafe test cleanup path')
    rmSync(root, { recursive: true, force: true })
  }
})
const deferred = <T>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

it('targets compaction at a registered root and waits for the actual DSH outcome', async () => {
  const f = setup(); await f.start()
  const opening = f.host.open('/fixture', 'compact-root')
  await Promise.resolve(); const open = f.child.send.mock.calls.at(-1)![0]
  f.emit({ t: 'session', ref: open.ref, sessionId: 'compact-root' }); await opening
  const result = f.host.compact('compact-root', 'manual-1')
  await Promise.resolve(); const request = f.child.send.mock.calls.at(-1)![0]
  expect(request).toMatchObject({ t: 'compact', sessionId: 'compact-root', operationId: 'manual-1' })
  f.emit({ t: 'compacted', ref: request.ref, rootSessionId: 'compact-root', outcome: 'no_range' })
  expect(await result).toEqual({ rootSessionId: 'compact-root', outcome: 'no_range' })
  await expect(f.host.compact('unknown-root', 'manual-2')).rejects.toThrow('DSH_ORIGIN_UNAVAILABLE')
  const closing = f.host.close(); f.child.emit('exit', 0); await closing
})

it('bounds a silent extension request and ignores its late reply', async () => {
  const f = setup(); await f.start()
  const result = f.host.extensions({ action: 'reconcile', operationId: 'op' })
  const rejected = expect(result).rejects.toThrow('DSH_REQUEST_TIMEOUT')
  await Promise.resolve(); const request = f.child.send.mock.calls.at(-1)![0]
  f.clock.advanceBy(30_000); await rejected
  f.emit({ t: 'extensions', ref: request.ref, value: { items: [] } })
  expect(f.host.available()).toBe(true)
})

it('disconnect rejects in-flight management without replaying the operation', async () => {
  const f = setup(); await f.start()
  const result = f.host.extensions({ action: 'remove', operationId: 'op', target: 'fixture', fingerprint: 'hash' })
  const rejected = expect(result).rejects.toThrow('DSH_HOST_EXITED')
  await Promise.resolve(); f.child.connected = false; f.child.emit('disconnect'); await rejected
  expect(f.host.available()).toBe(false)
  expect(f.child.send.mock.calls.filter(([input]) => input.t === 'extensions')).toHaveLength(1)
})
function setup(patch: Partial<DshHostOptions> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'lca-dsh-host-')); roots.push(root)
  const bridge = join(root, 'bridge'); mkdirSync(bridge)
  const child = Object.assign(new EventEmitter(), {
    connected: true, pid: 1234 as number | undefined, stderr: Object.assign(new EventEmitter(), { resume: vi.fn() }), kill: vi.fn(),
    send: vi.fn((_command: Record<string, unknown>, callback?: (error: Error | null) => void) => { callback?.(null); return true }),
  })
  mocked.spawn.mockReturnValue(child)
  const clock = createManualClock(0)
  const options: DshHostOptions = { clock, dshRoot: root, dataDir: root, bridge, workspace: join(root, 'work'), routes: null, guardedRoots: [], persona: '', tools: [],
    onEvent: vi.fn(), onCall: vi.fn(async () => ({ value: 'ok', source: null })), onApproval: vi.fn(async () => 'rejected' as const), ...patch }
  const host = startDshHost(options)
  const emit = (message: Record<string, unknown>) => child.emit('message', message)
  const start = async () => { emit({ t: 'hello' }); emit({ t: 'init-ok' }); await host.started }
  return { host, child, clock, options, emit, start }
}

it('preserves startup and request/reply while IPC is connected', async () => {
  const f = setup(); await f.start()
  const opening = f.host.open('project', 's')
  await Promise.resolve()
  const command = f.child.send.mock.calls.at(-1)![0]
  expect(command).toMatchObject({ t: 'open', cwd: 'project' })
  f.emit({ t: 'session', ref: command.ref, sessionId: 's' })
  expect(await opening).toBe('s')
  f.host.send('s', 'hello')
  expect(f.child.send.mock.calls.at(-1)![0]).toMatchObject({ t: 'send', sessionId: 's', text: 'hello' })
  const closing = f.host.close(); f.child.emit('exit', 0); expect(await closing).toBe(0)
})

it('only passes state requests from the current registered root to main', async () => {
  const onState = vi.fn(() => true), f = setup({ onState }); await f.start()
  const opening = f.host.open('project', 's'); await Promise.resolve()
  const command = f.child.send.mock.calls.at(-1)![0]
  const origin = { ...command.binding as object, rootSessionId: 's', sessionId: 's', parentSessionId: null }
  f.emit({ t: 'session', ref: command.ref, sessionId: 's' }); await opening
  const request = { t: 'state-request', id: 'state', sessionId: 's', origin, state: { mode: 'work', token: 'token' } }
  f.emit(request); expect(onState).toHaveBeenCalledTimes(1)
  expect(f.child.send.mock.calls.at(-1)![0]).toMatchObject({ t: 'state-answer', ok: true })
  const child = { ...origin, sessionId: 'child', parentSessionId: 's' }
  f.emit({ t: 'member', origin: child }); f.emit({ ...request, origin: child })
  f.emit({ ...request, origin: { ...origin, runtimeId: 'old-runtime' } })
  f.host.cancel('s'); f.emit(request)
  expect(onState).toHaveBeenCalledTimes(1)
  expect(f.child.send.mock.calls.at(-1)![0]).toMatchObject({ t: 'state-answer', ok: false })
  const closing = f.host.close(); f.child.emit('exit', 0); await closing
})

it('rejects pending requests and stops all commands after disconnect', async () => {
  const f = setup(); await f.start()
  const opening = f.host.open('project'); const rejected = expect(opening).rejects.toThrow('DSH_HOST_EXITED')
  await Promise.resolve()
  f.child.connected = false; f.child.emit('disconnect')
  await rejected
  const count = f.child.send.mock.calls.length
  f.host.send('s', 'late'); f.host.cancel('s'); f.host.tools([]); f.host.efforts({ chat: 'high' }); f.host.trust('s'); f.host.untrust('s')
  await expect(f.host.describe()).rejects.toThrow('DSH_HOST_EXITED')
  const closing = f.host.close(); f.child.emit('exit', 0); await closing
  expect(f.child.send).toHaveBeenCalledTimes(count)
})

it.each(['callback', 'throw'] as const)('handles the IPC disconnect race reported by %s without an uncaught error', async (mode) => {
  const f = setup(); await f.start()
  const error = Object.assign(new Error('channel closed'), { code: 'ERR_IPC_CHANNEL_CLOSED' })
  let reply!: (error: Error | null) => void
  f.child.send.mockImplementation((_command, callback) => {
    if (mode === 'throw') throw error
    reply = callback!; return false
  })
  const describing = f.host.describe(); const rejected = expect(describing).rejects.toThrow('DSH_HOST_EXITED')
  await Promise.resolve()
  if (mode === 'callback') reply(error)
  await rejected
  const count = f.child.send.mock.calls.length
  expect(() => f.host.cancel('s')).not.toThrow()
  expect(f.child.send).toHaveBeenCalledTimes(count)
  f.child.emit('exit', 1); await f.host.close()
})

it.each(['close', 'disconnect'] as const)('drops late tool, approval and question replies after %s', async (mode) => {
  const tool = deferred<Awaited<ReturnType<DshHostOptions['onCall']>>>()
  const approval = deferred<'allowed-once' | 'rejected'>()
  const question = deferred<{ answers: unknown[] }>()
  let signal!: AbortSignal
  const f = setup({ onCall: () => tool.promise, onApproval: () => approval.promise, onQuestion: (request) => { signal = request.signal; return question.promise } })
  await f.start()
  const opening = f.host.open('project', 's'); await Promise.resolve()
  const command = f.child.send.mock.calls.at(-1)![0]
  const origin = { ...command.binding as object, rootSessionId: 's', sessionId: 's', parentSessionId: null }
  f.emit({ t: 'session', ref: command.ref, sessionId: 's' }); await opening
  f.emit({ t: 'lca-call', id: 'tool', sessionId: 's', origin, callId: 'c', name: 'read' })
  f.emit({ t: 'approval', id: 'approval', approvalId: 'approval', activationId: 'a1', policyRevision: 0, sessionId: 's', origin })
  f.emit({ t: 'question', id: 'question', sessionId: 's', origin, questions: [] })
  const closing = mode === 'close' ? f.host.close() : undefined
  if (mode === 'disconnect') { f.child.connected = false; f.child.emit('disconnect') }
  expect(signal.aborted).toBe(true)
  const count = f.child.send.mock.calls.length
  tool.resolve({ value: 'late', source: null }); approval.resolve('allowed-once'); question.resolve({ answers: [] })
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve()
  f.emit({ t: 'admit', id: 'late' }); f.emit({ t: 'hello' })
  expect(f.child.send).toHaveBeenCalledTimes(count)
  f.child.emit('exit', 0); await (closing ?? f.host.close())
})

it('closes once, rejects an opening request, and kills a child that never exits', async () => {
  const f = setup(); await f.start()
  const opening = f.host.open('project'); const rejected = expect(opening).rejects.toThrow('DSH_HOST_EXITED')
  await Promise.resolve()
  const closing = f.host.close(); expect(f.host.close()).toBe(closing)
  await rejected
  expect(f.child.send.mock.calls.filter(([command]) => command.t === 'shutdown')).toHaveLength(1)
  f.clock.advanceBy(10_000); expect(f.child.kill).toHaveBeenCalledOnce()
  f.child.emit('exit', null); await closing
  f.clock.advanceBy(10_000); expect(f.child.kill).toHaveBeenCalledOnce()
})

it('handles a spawn failure before startup without waiting for an exit event', async () => {
  const f = setup(); const rejected = expect(f.host.started).rejects.toThrow('DSH_HOST_EXITED')
  f.child.pid = undefined
  expect(() => f.child.emit('error', new Error('spawn failed'))).not.toThrow()
  expect(() => f.child.stderr.emit('error', Object.assign(new Error('read ENOTCONN'), { code: 'ENOTCONN' }))).not.toThrow()
  await rejected; expect(await f.host.close()).toBe(null)
  f.clock.advanceBy(10_000); expect(f.child.kill).not.toHaveBeenCalled()
})

it('does not treat a live stderr failure as proof the child has exited', async () => {
  const f = setup(); await f.start()
  expect(() => f.child.stderr.emit('error', new Error('synthetic pipe failure'))).not.toThrow()
  expect(f.host.available()).toBe(false)
  const closing = f.host.close()
  f.clock.advanceBy(10_000); expect(f.child.kill).toHaveBeenCalledOnce()
  f.child.emit('exit', 1); expect(await closing).toBe(1)
})

it('admits registered descendants and refuses stale, foreign and unregistered origins before invoking handlers', async () => {
  const onAdmit = vi.fn(() => true), f = setup({ onAdmit }); await f.start()
  const opening = f.host.open('project', 'root'); await Promise.resolve()
  const command = f.child.send.mock.calls.at(-1)![0]
  f.emit({ t: 'session', ref: command.ref, sessionId: 'root' }); await opening
  const origin = { ...command.binding as object, rootSessionId: 'root', sessionId: 'child', parentSessionId: 'root' }
  const request = { t: 'admit', id: 'admit', sessionId: 'root', origin, units: 15 }
  f.emit(request); expect(onAdmit).not.toHaveBeenCalled()
  f.emit({ t: 'member', origin }); f.emit(request); expect(onAdmit).toHaveBeenCalledOnce()
  for (const patch of [{ runtimeId: 'old' }, { projectId: 'other' }, { cwd: 'other' }, { parentSessionId: null }, { protocolVersion: 1 }]) {
    f.emit({ ...request, origin: { ...origin, ...patch } })
    f.emit({ t: 'approval', id: 'approval', sessionId: 'root', origin: { ...origin, ...patch } })
    f.emit({ t: 'lca-call', id: 'call', sessionId: 'root', origin: { ...origin, ...patch } })
  }
  expect(onAdmit).toHaveBeenCalledOnce(); expect(f.options.onApproval).not.toHaveBeenCalled(); expect(f.options.onCall).not.toHaveBeenCalled()
  f.emit({ ...request, sessionId: 'another-root' }); expect(onAdmit).toHaveBeenCalledOnce()
  const closing = f.host.close(); f.child.emit('exit', 0); await closing
})

it('refuses a step if the resource handler throws', async () => {
  const f = setup({ onAdmit: () => { throw new Error('ledger unavailable') } }); await f.start()
  const opening = f.host.open('project', 'root'); await Promise.resolve()
  const command = f.child.send.mock.calls.at(-1)![0]
  f.emit({ t: 'session', ref: command.ref, sessionId: 'root' }); await opening
  f.emit({ t: 'admit', id: 'admit', sessionId: 'root', origin: { ...command.binding as object, rootSessionId: 'root', sessionId: 'root', parentSessionId: null } })
  expect(f.child.send.mock.calls.at(-1)![0]).toMatchObject({ t: 'admit-answer', ok: false })
  const closing = f.host.close(); f.child.emit('exit', 0); await closing
})

it.each(['cancel', 'untrust', 'withdraw'] as const)('cancels the member approval on %s and drops old replies after reactivation', async (action) => {
  const answer = deferred<'allowed-once' | 'rejected'>()
  let signal!: AbortSignal
  const onApproval = vi.fn((request) => { signal = request.signal; return answer.promise })
  const f = setup({ onApproval }); await f.start()
  const opening = f.host.open('project', 'root'); await Promise.resolve()
  const command = f.child.send.mock.calls.at(-1)![0]
  f.emit({ t: 'session', ref: command.ref, sessionId: 'root' }); await opening
  const origin = { ...command.binding as object, rootSessionId: 'root', sessionId: 'member', parentSessionId: 'root' }
  f.emit({ t: 'member', origin })
  const request = { t: 'approval', id: 'a', approvalId: 'a', activationId: 'member-turn', policyRevision: 0, sessionId: 'root', origin }
  f.emit(request); expect(onApproval).toHaveBeenCalledOnce(); expect(signal.aborted).toBe(false)
  if (action === 'withdraw') f.emit({ t: 'approval-cancel', id: 'a' }); else f.host[action]('root')
  expect(signal.aborted).toBe(true)
  f.host.send('root', 'new authorization')
  f.emit({ ...request, id: 'old', approvalId: 'old' })
  expect(onApproval).toHaveBeenCalledOnce()
  answer.resolve('allowed-once'); await Promise.resolve(); await Promise.resolve()
  expect(f.child.send.mock.calls.some(([message]) => message.t === 'approval-answer' && message.outcome === 'allowed-once')).toBe(false)
  const closing = f.host.close(); f.child.emit('exit', 0); await closing
})

it('does not reuse a pending approval when the same root is reopened', async () => {
  const answer = deferred<'allowed-once' | 'rejected'>(); let signal!: AbortSignal
  const f = setup({ onApproval: (request) => { signal = request.signal; return answer.promise } }); await f.start()
  const opening = f.host.open('project', 'root'); await Promise.resolve()
  const first = f.child.send.mock.calls.at(-1)![0]
  f.emit({ t: 'session', ref: first.ref, sessionId: 'root' }); await opening
  f.emit({ t: 'approval', id: 'a', approvalId: 'a', activationId: 'old', policyRevision: 0, sessionId: 'root', origin: { ...first.binding as object, rootSessionId: 'root', sessionId: 'root', parentSessionId: null } })
  const reopened = f.host.open('project', 'root'); await Promise.resolve()
  expect(signal.aborted).toBe(true)
  const second = f.child.send.mock.calls.at(-1)![0]
  f.emit({ t: 'session', ref: second.ref, sessionId: 'root' }); await reopened
  answer.resolve('allowed-once'); await Promise.resolve(); await Promise.resolve()
  expect(f.child.send.mock.calls.some(([message]) => message.t === 'approval-answer' && message.outcome === 'allowed-once')).toBe(false)
  const closing = f.host.close(); f.child.emit('exit', 0); await closing
})

it('asks the bridge for one connection test and bounds what comes back', async () => {
  const f = setup(); await f.start()
  const probing = f.host.probe('work')
  await Promise.resolve()
  const command = f.child.send.mock.calls.at(-1)![0]
  expect(command).toMatchObject({ t: 'probe', role: 'work' })
  f.emit({ t: 'probed', ref: command.ref, ok: false, durationMs: 1200, route: { provider: 'lca-work', model: 'synthetic' },
    failure: { code: 'AUTH', message: 'x'.repeat(9000), status: 401, requestId: 'req-1' } })
  const result = await probing
  expect(result).toMatchObject({ ok: false, durationMs: 1200, route: { provider: 'lca-work', model: 'synthetic' }, failure: { code: 'AUTH', status: 401, requestId: 'req-1' } })
  expect(result.failure!.message).toHaveLength(4000)
  // The bridge stops its own request after 30 s; the host gives up on a silent bridge after 45 s.
  const silent = f.host.probe('chat'); const rejected = expect(silent).rejects.toThrow('DSH_REQUEST_TIMEOUT')
  await Promise.resolve(); f.clock.advanceBy(45_000); await rejected
})
