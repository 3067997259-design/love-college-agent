import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createManualClock } from '../../src/main/clock'
import { createMemorySettings, type MemorySettingsService } from '../../src/main/config/memory-settings'
import { createMemoryEngine } from '../../src/main/memory/engine'
import { createMemoryDatabaseClient } from '../../src/main/memory/storage/client'
import { createNativeMemoryDatabase } from '../../src/main/memory/storage/neo'
import type { AppCommand, MemorySettingsCommand } from '../../src/shared'
import type { MemoryHostPort } from '../../src/main/memory/airi/runtime'
import { ensureContinuityIdentity, restoredContinuityIdentity } from '../../src/main/continuity/identity'
import { createAppController } from '../../src/main/bridge/controller'

const closes: (() => Promise<void>)[] = []
afterEach(async () => { for (const close of closes.splice(0)) await close() })
const owner = { userId: 'settings-user', characterId: 'settings-character', dataRootId: 'settings-root' }
const scope = { userId: owner.userId, characterId: owner.characterId }
const vector = (dimensions: number) => Array.from({ length: dimensions }, (_, index) => index === 0 ? 1 : 0)
function fixture() {
  const root = mkdtempSync(join(resolve('test-results'), 'memory-settings-'))
  const clock = createManualClock(1790000000000)
  let held = false; let fail = false
  const embed = vi.fn(async (_text: string, model: string) => { if (fail) throw new Error('synthetic-upstream-secret'); return vector(model === 'first' ? 768 : 1024) })
  const reserve = vi.fn()
  const mirror: MemoryHostPort = { configure: vi.fn(async ({ connectionString }) => ({ status: connectionString ? 'ready' as const : 'unconfigured' as const })),
    getStatus: async () => ({ status: 'ready' }), insert: vi.fn(async () => ({ id: 'remote' })), update: async () => ({}), remove: async () => ({}), list: async () => [], search: async () => [] }
  const engine = createMemoryEngine({ root: join(root, 'facts'), owner, clock, embedding: () => settings?.source(), mirror, held: () => held,
    waitForRestore: async () => {}, journal: () => {}, openDatabase: async path => { const db = createMemoryDatabaseClient(createNativeMemoryDatabase(), clock); await db.open(path); return db } })
  const options = { root, clock, runtime: () => engine.runtime, canConfigure: () => !held, held: () => held, prepare: async () => { engine.runtime.revoke(); await engine.runtime.idle() }, changed: () => {}, reserve,
    source: (input: { model: string; baseUrl: string }) => ({ provider: 'fixture', model: input.model, fingerprint: `fixture:${input.model}`, embed: (text: string) => embed(text, input.model) }) }
  const settings: MemorySettingsService = createMemorySettings(options)
  closes.push(async () => { await settings.close(); await engine.dispose() })
  const dispatch = async (command: MemorySettingsCommand) => { const result = settings.dispatch(command as AppCommand); await settings.idle(); return result }
  const insert = async (content = 'A persistent fact') => (await engine.runtime.initialize())!.insert({ scope, content, category: 'chat', memoryType: 'long_term', importance: 5, valence: 0, arousal: 0, tags: [], reviewStatus: 'approved', pinned: true })
  return { root, clock, engine, settings, dispatch, insert, embed, mirror, reserve, options, held: (value: boolean) => { held = value }, fail: (value: boolean) => { fail = value } }
}

describe('private memory connection settings', () => {
  it('accepts private settings only from the book and deduplicates requests without echoing credentials', async () => {
    const f = fixture(); const controller = createAppController(f.clock)
    controller.attachMemorySettings(f.settings)
    const command = { protocolVersion: 1, epoch: controller.getSnapshot().epoch, requestId: 'settings-request', type: 'memory.settings.configure',
      embedding: { baseUrl: 'https://fixture.invalid/private', apiKey: 'synthetic-secret', model: 'first' } }
    for (const surface of ['mini', 'diagnostics'] as const) expect(controller.dispatch(command, surface)).toMatchObject({ status: 'rejected', error: { code: 'permission-denied' } })
    expect(controller.dispatch({ ...command, arbitraryPath: 'C:/private' }).status).toBe('rejected')
    expect(controller.dispatch(command).status).toBe('accepted')
    expect(controller.dispatch(command).status).toBe('accepted')
    expect(controller.dispatch({ ...command, requestId: 'another' })).toMatchObject({ status: 'rejected', error: { code: 'unavailable' } })
    await f.settings.idle()
    expect(JSON.stringify(controller.getSnapshot())).not.toMatch(/synthetic-secret|fixture\.invalid|\/private/)
    expect(controller.getSnapshot().messages).toEqual([])
    controller.dispose()
  })

  it('installs locally, persists private configuration and never exposes secrets or endpoint paths', async () => {
    const f = fixture(); await f.engine.runtime.initialize(); await f.settings.initialize()
    expect(f.embed).not.toHaveBeenCalled(); expect(f.mirror.configure).not.toHaveBeenCalled()
    await f.insert()
    expect(await f.dispatch({ type: 'memory.settings.configure', embedding: { baseUrl: 'https://private.example.invalid/secret-path/v1', apiKey: 'synthetic-api-secret', model: 'first' } })).toBeUndefined()
    expect(f.settings.view().status).toBe('idle'); expect(f.embed).toHaveBeenCalledTimes(1); expect(f.reserve).toHaveBeenCalledTimes(1)
    const projection = JSON.stringify(f.settings.view())
    for (const secret of ['synthetic-api-secret', 'secret-path', 'private.example.invalid']) expect(projection).not.toContain(secret)
    expect(JSON.parse(readFileSync(join(f.root, 'connections/memory.json'), 'utf8')).embedding.apiKey).toBe('synthetic-api-secret')
    const reopened = createMemorySettings(f.options)
    expect(reopened.view().embedding.configured).toBe(true); expect(f.embed).toHaveBeenCalledTimes(1)
    await reopened.close()
    expect(await f.dispatch({ type: 'memory.settings.configure', embedding: { baseUrl: 'https://another.invalid/v1', model: 'second' } })).toBe('configuration-failed')
    expect(f.settings.view().embedding.model).toBe('first')
  })

  it('changes vector space in the actual native store and resumes a failed migration without replacing facts', async () => {
    const f = fixture(); const fact = await f.insert()
    const configure = (model: string) => f.dispatch({ type: 'memory.settings.configure', embedding: { baseUrl: 'https://fixture.invalid/v1', apiKey: 'synthetic-secret', model } })
    await configure('first')
    const repo = (await f.engine.runtime.initialize())!
    expect((await repo.list({ scope }))[0]).toMatchObject({ id: fact.id, embeddingModel: 'first', embeddingStatus: 'active', contentVector: vector(768) })
    f.fail(true); await configure('second')
    expect(f.settings.view()).toMatchObject({ status: 'failed', error: 'embedding' })
    expect(JSON.stringify(f.settings.view())).not.toContain('synthetic-upstream-secret')
    expect((await repo.list({ scope }))[0]).toMatchObject({ id: fact.id, embeddingStatus: 'stale' })
    expect(f.engine.runtime.databaseStatus.value).toBe('ready')
    f.fail(false); await f.dispatch({ type: 'memory.settings.retry', target: 'embedding' })
    expect(await repo.list({ scope })).toEqual([expect.objectContaining({ id: fact.id, embeddingModel: 'second', embeddingStatus: 'active', contentVector: vector(1024) })])
    expect(f.engine.runtime.embeddingMigration.value.state).toBe('complete')
    await f.dispatch({ type: 'memory.settings.configure', embedding: null })
    expect(f.settings.source()).toBeUndefined(); expect(await repo.list({ scope })).toHaveLength(1)
  })

  it('connects only the explicit mirror, preserves outbox intent when paused, and rejects held settings', async () => {
    const f = fixture(); await f.insert()
    await f.dispatch({ type: 'memory.settings.configure', embedding: { baseUrl: 'https://fixture.invalid/v1', apiKey: 'synthetic-secret', model: 'first' } })
    const connectionString = 'postgresql://fixture:synthetic-password@host.invalid/db'
    await f.dispatch({ type: 'memory.settings.configure', mirror: { connectionString, enabled: false } })
    expect(f.mirror.configure).toHaveBeenLastCalledWith({ connectionString: undefined })
    expect(f.mirror.insert).not.toHaveBeenCalled()
    await f.dispatch({ type: 'memory.settings.configure', mirror: { enabled: true } })
    expect(f.mirror.configure).toHaveBeenLastCalledWith({ connectionString })
    expect(f.mirror.insert).toHaveBeenCalled()
    expect(JSON.stringify(f.settings.view())).not.toMatch(/synthetic-password|host\.invalid|postgresql/)
    await f.dispatch({ type: 'memory.settings.configure', mirror: { enabled: false } })
    expect(f.engine.runtime.longTermSyncEnabled.value).toBe(false)
    f.held(true)
    expect(await f.dispatch({ type: 'memory.settings.retry', target: 'mirror' })).toBe('unavailable')
  })
})

it('persists a movable data-root identity and prepares owner-specific restore epochs', () => {
  const firstRoot = mkdtempSync(join(resolve('test-results'), 'continuity-identity-'))
  const secondRoot = mkdtempSync(join(resolve('test-results'), 'continuity-identity-copy-'))
  const first = ensureContinuityIdentity(firstRoot, owner)
  const other = ensureContinuityIdentity(firstRoot, { ...owner, characterId: 'other-character' })
  writeFileSync(join(secondRoot, 'continuity.json'), readFileSync(join(firstRoot, 'continuity.json')))
  expect(ensureContinuityIdentity(secondRoot, owner)).toEqual(first)
  const restored = restoredContinuityIdentity(secondRoot, owner)
  expect(ensureContinuityIdentity(secondRoot, owner)).toEqual(first)
  writeFileSync(join(secondRoot, 'continuity.json'), restored)
  const next = ensureContinuityIdentity(secondRoot, owner)
  expect(next.owner).toEqual(first.owner); expect(next.mirrorEpoch).not.toBe(first.mirrorEpoch)
  expect(ensureContinuityIdentity(secondRoot, { ...owner, characterId: 'other-character' })).toEqual(other)
})
