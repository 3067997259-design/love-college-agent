import { describe, expect, it, vi } from 'vitest'
import { createManualClock } from '../../../src/main/clock'
import { createMemoryMirrorHost, memoryMirrorNamespace } from '../../../src/main/memory/airi/mirror'
import { memoryPostgresOptions, type MemoryPgvectorConnection } from '../../../src/main/memory/airi/pgvector/repository'

const owner = { userId: 'user-a', characterId: 'taozi', dataRootId: 'isolated-a' }
const scope = { userId: owner.userId, characterId: owner.characterId }
describe('main-owned mirror routing', () => {
  it('isolates roots, characters and restored epochs without disclosing credentials', async () => {
    const ensureSchema = vi.fn(async (_connection: string, _namespace?: string) => {})
    const close = vi.fn(async () => {})
    const list = vi.fn(async () => [])
    const insert = vi.fn(async () => ({ id: 'remote', originId: null }))
    const updateByOriginId = vi.fn(async () => undefined)
    const removeByOriginId = vi.fn(async () => {})
    const repository = { list, search: vi.fn(async () => []), insert, updateByOriginId, removeByOriginId } as unknown as MemoryPgvectorConnection['repository']
    const connect = vi.fn(() => ({ repository, close }))
    let held = false
    const host = createMemoryMirrorHost({ clock: createManualClock(1), owner, epoch: 'first', held: () => held, ensureSchema, connect })
    try {
      expect(await host.port.getStatus()).toEqual({ status: 'unconfigured' })
      expect(connect).not.toHaveBeenCalled()
      expect(host.namespace).not.toContain(owner.userId)
      expect(host.namespace).not.toBe(memoryMirrorNamespace({ ...owner, dataRootId: 'isolated-b' }, 'first'))
      expect(host.namespace).not.toBe(memoryMirrorNamespace({ ...owner, characterId: 'other' }, 'first'))
      expect(host.namespace).not.toBe(memoryMirrorNamespace(owner, 'restored'))
      expect(memoryPostgresOptions(host.namespace).connection.search_path).toBe(`${host.namespace},public`)
      expect(() => memoryPostgresOptions('public;DROP SCHEMA public')).toThrow('NAMESPACE_INVALID')
      expect(await host.port.configure({ connectionString: 'postgres://user:private-password@mirror.invalid/memory' })).toEqual({ status: 'ready' })
      expect(ensureSchema.mock.calls[0]?.[1]).toBe(host.namespace)
      await host.port.list({ scope })
      expect(list).toHaveBeenCalledWith(expect.objectContaining({ scope }))
      expect(() => host.port.list({ scope: { ...scope, userId: 'stranger' } })).toThrow('SCOPE_MISMATCH')
      expect(await host.port.insert({ scope, originId: 'local', content: 'Tea', memoryType: 'long_term', category: 'chat' })).toEqual({ id: 'remote', originId: undefined })
      held = true
      await expect(host.port.remove({ originId: 'local' })).rejects.toThrow('UNAVAILABLE')
      expect(removeByOriginId).not.toHaveBeenCalled()
      held = false
      await host.port.configure({ connectionString: 'https://secret.invalid/?private-password' })
      expect(JSON.stringify(await host.port.getStatus())).not.toContain('private-password')
    } finally { await host.close() }
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('does not submit queued writes after configuration changes or close', async () => {
    let release!: () => void
    const closed = new Promise<void>(resolve => { release = resolve })
    const removeByOriginId = vi.fn(async () => {})
    const repository = { removeByOriginId } as unknown as MemoryPgvectorConnection['repository']
    const host = createMemoryMirrorHost({ clock: createManualClock(), owner, epoch: 'first', held: () => false,
      ensureSchema: async () => {}, connect: () => ({ repository, close: () => closed }) })
    await host.port.configure({ connectionString: 'postgres://fixture.invalid/test' })
    const reconfigure = host.port.configure({})
    const stale = host.port.remove({ originId: 'local' })
    const rejection = expect(stale).rejects.toThrow('UNAVAILABLE')
    release(); await reconfigure; await rejection
    expect(removeByOriginId).not.toHaveBeenCalled()
    await host.close()
  })

  it('does not publish a late effect receipt across a connection generation', async () => {
    let release!: () => void, started!: () => void
    const entered = new Promise<void>(done => { started = done })
    const effect = new Promise<void>(done => { release = done })
    const removeByOriginId = vi.fn(async () => { started(); await effect })
    const repository = { removeByOriginId } as unknown as MemoryPgvectorConnection['repository']
    const host = createMemoryMirrorHost({ clock: createManualClock(), owner, epoch: 'first', held: () => false,
      ensureSchema: async () => {}, connect: () => ({ repository, close: async () => {} }) })
    await host.port.configure({ connectionString: 'postgres://first.invalid/test' })
    const pending = host.port.remove({ originId: 'local' }); await entered
    const rejected = expect(pending).rejects.toThrow('UNAVAILABLE')
    const replacement = host.port.configure({ connectionString: 'postgres://second.invalid/test' })
    release(); await rejected; expect(await replacement).toEqual({ status: 'ready' })
    expect(await host.port.getStatus()).toEqual({ status: 'ready' })
    await host.close()
  })

  it('does not install a connection whose schema preparation finished after revocation', async () => {
    let release!: () => void, started!: () => void
    const entered = new Promise<void>(done => { started = done }), preparation = new Promise<void>(done => { release = done })
    const connect = vi.fn(() => ({ repository: {} as MemoryPgvectorConnection['repository'], close: async () => {} }))
    const host = createMemoryMirrorHost({ clock: createManualClock(), owner, epoch: 'first', held: () => false,
      ensureSchema: async () => { started(); await preparation }, connect })
    const configuring = host.port.configure({ connectionString: 'postgres://first.invalid/test' }); await entered
    const disconnecting = host.port.configure({}); release()
    expect(await configuring).toMatchObject({ status: 'error' }); expect(await disconnecting).toEqual({ status: 'unconfigured' })
    expect(connect).not.toHaveBeenCalled(); await host.close()
  })
})
