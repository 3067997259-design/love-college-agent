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
function setup(patch: Partial<DshHostOptions> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'lca-dsh-host-')); roots.push(root)
  const bridge = join(root, 'bridge'); mkdirSync(bridge)
  const child = Object.assign(new EventEmitter(), {
    connected: true, stderr: { resume: vi.fn() }, kill: vi.fn(),
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
  const opening = f.host.open('project')
  await Promise.resolve()
  const command = f.child.send.mock.calls.at(-1)![0]
  expect(command).toMatchObject({ t: 'open', cwd: 'project' })
  f.emit({ t: 'session', ref: command.ref, sessionId: 's' })
  expect(await opening).toBe('s')
  f.host.send('s', 'hello')
  expect(f.child.send.mock.calls.at(-1)![0]).toMatchObject({ t: 'send', sessionId: 's', text: 'hello' })
  const closing = f.host.close(); f.child.emit('exit', 0); expect(await closing).toBe(0)
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
  f.emit({ t: 'lca-call', id: 'tool', sessionId: 's', callId: 'c', name: 'read' })
  f.emit({ t: 'approval', id: 'approval', sessionId: 's' })
  f.emit({ t: 'question', id: 'question', sessionId: 's', questions: [] })
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
  expect(() => f.child.emit('error', new Error('spawn failed'))).not.toThrow()
  f.child.emit('close', null)
  await rejected; expect(await f.host.close()).toBe(null)
  f.clock.advanceBy(10_000); expect(f.child.kill).not.toHaveBeenCalled()
})
