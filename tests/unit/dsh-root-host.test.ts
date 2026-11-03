import { expect, it, vi } from 'vitest'
import { createManualClock } from '../../src/main/clock'
import { createRootHost } from '../../src/main/dsh/root-host'
import type { DshHost, DshHostOptions, startDshHost } from '../../src/main/dsh/host'

function fixture(close = async () => null as number | null) {
  const hosts: { close: ReturnType<typeof vi.fn>; cancel: ReturnType<typeof vi.fn> }[] = []
  const launch = vi.fn(() => {
    const host = { started: Promise.resolve(), available: () => true, tools: () => true, open: async (_cwd: string, id: string) => id,
      release: async () => {}, cancel: vi.fn(() => true), close: vi.fn(close) }
    hosts.push(host); return host as unknown as DshHost
  }) as unknown as typeof startDshHost
  const pool = createRootHost({ dataDir: '/synthetic', launch })
  const options: DshHostOptions = { clock: createManualClock(0), dshRoot: '/unused', dataDir: '/synthetic', bridge: '/unused', workspace: '/synthetic/project', routes: null,
    guardedRoots: [], persona: '', tools: [], onEvent: () => {}, onCall: async () => ({ value: null, source: null }), onApproval: async () => 'rejected' }
  return { pool, hosts, options }
}

it('keeps another lease alive and requires all leases to close before a physical restart', async () => {
  const f = fixture(), foreground = f.pool.launch(f.options), worker = f.pool.launch(f.options)
  await foreground.open('/synthetic/project', 'foreground'); await worker.open('/synthetic/project', 'worker')
  await foreground.close()
  await expect(f.pool.restart()).rejects.toThrow('DSH_ROOT_HOST_BUSY')
  expect(f.hosts[0].close).not.toHaveBeenCalled()
  expect(f.hosts[0].cancel.mock.calls).toEqual([['foreground']])
  expect(worker.available()).toBe(true)
  expect(() => foreground.cancel('worker')).toThrow('DSH_ROOT_UNAVAILABLE')
  await worker.close(); await f.pool.restart()
  expect(f.hosts[0].close).toHaveBeenCalledOnce()
  const next = f.pool.launch(f.options); await next.open('/synthetic/project', 'foreground')
  expect(f.hosts).toHaveLength(2)
  expect(() => foreground.cancel('foreground')).toThrow('DSH_ROOT_UNAVAILABLE')
  await next.close(); await f.pool.close()
})

it('waits for the old process to close before permitting a new shared host', async () => {
  let release!: (code: number | null) => void
  const closing = new Promise<number | null>(done => { release = done })
  const f = fixture(() => closing), lease = f.pool.launch(f.options)
  await lease.close()
  const restart = f.pool.restart()
  expect(f.pool.restart()).toBe(restart)
  expect(() => f.pool.launch(f.options)).toThrow('DSH_ROOT_HOST_RESTARTING')
  expect(f.hosts).toHaveLength(1)
  release(0); await restart
  const next = f.pool.launch(f.options)
  expect(f.hosts).toHaveLength(2)
  await next.close(); await f.pool.close()
})
