import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { createModelSettings } from '../../src/main/config/model-settings'
import { createManualClock } from '../../src/main/clock'
import type { AppCommand } from '../../src/shared'
import type { DshProbeResult } from '../../src/shared/dsh-protocol'

const roots: string[] = []
afterEach(() => {
  vi.unstubAllGlobals()
  for (const root of roots.splice(0)) { if (!resolve(root).startsWith(join(resolve(tmpdir()), 'lca-probe-'))) throw new Error('UNSAFE'); rmSync(root, { recursive: true, force: true }) }
})
const chatKey = 'sk-synthetic-probe-chat', memoryKey = 'sk-synthetic-probe-memory'
function setup(probeDsh?: (role: 'chat' | 'work') => Promise<DshProbeResult>) {
  const root = mkdtempSync(join(tmpdir(), 'lca-probe-')); roots.push(root)
  mkdirSync(join(root, 'connections'))
  writeFileSync(join(root, 'connections', 'providers.json'), JSON.stringify({ providers: {
    chat: { base_url: 'https://chat.example.invalid/v1', api_key: chatKey, model: 'synthetic-chat' },
    background: { base_url: 'https://memory.example.invalid/v1', api_key: memoryKey, model: 'synthetic-memory' },
  }, routing: { background: 'independent', privacy: 'follow-main', work: 'follow-main' } }))
  const clock = createManualClock()
  const settings = createModelSettings({ root, developer: false, slots: ['chat', 'background'], clock, canConfigure: () => true, choose: async () => null, changed: () => {}, ...(probeDsh ? { probeDsh } : {}) })
  return { settings, clock }
}
const probe = (slot: string) => ({ type: 'models.probe', slot } as AppCommand)
const snapshotSafe = (view: unknown) => { const text = JSON.stringify(view); for (const secret of [chatKey, memoryKey, 'example.invalid', 'Incorrect API key', 'does not exist', 'req-synthetic']) expect(text).not.toContain(secret) }

it('tests chat and work through DSH, the path her turns use', async () => {
  const roles: string[] = []
  const f = setup(async (role) => { roles.push(role); return { ok: false, durationMs: 640, route: { provider: 'lca-chat', model: 'synthetic-chat' }, failure: { code: 'AUTH', message: `401 Incorrect API key provided: ${chatKey}`, requestId: 'req-synthetic' } } })
  const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher)
  expect(f.settings.dispatch(probe('chat'))).toBeUndefined(); await f.settings.idle()
  const view = f.settings.view()
  expect(view.probe).toMatchObject({ slot: 'chat', status: 'failed', code: 'configuration-failed', detail: { path: 'dsh', adapter: 'lca-chat', durationMs: 640, issue: { kind: 'key-rejected', httpStatus: 401, code: 'AUTH' } } })
  snapshotSafe(view)
  // The details come only on request, for the test being shown, and still without a key.
  const read = f.settings.readProbe('chat')
  expect(read).toMatchObject({ slot: 'chat', atMs: view.probe!.atMs, model: 'synthetic-chat', endpoint: 'https://chat.example.invalid/v1/chat/completions', requestId: 'req-synthetic' })
  expect(read.message).toContain('Incorrect API key provided: [密钥已遮盖]')
  expect(JSON.stringify(read)).not.toContain(chatKey)
  expect(() => f.settings.readProbe('background')).toThrow('CONNECTION_TEST_UNAVAILABLE')
  // Work follows chat here: DSH's work route is the chat model, and the test says so.
  f.settings.dispatch(probe('work')); await f.settings.idle()
  expect(roles).toEqual(['chat', 'work'])
  expect(() => f.settings.readProbe('chat')).toThrow('CONNECTION_TEST_UNAVAILABLE')
  expect(fetcher).not.toHaveBeenCalled()
})

it('says plainly when DSH is not there to test with', async () => {
  const f = setup(async () => { throw new Error('DSH starts once a chat model is saved; save the chat model first') })
  f.settings.dispatch(probe('chat')); await f.settings.idle()
  expect(f.settings.view().probe).toMatchObject({ status: 'failed', code: 'unavailable', detail: { path: 'dsh', issue: { kind: 'engine-unavailable' } } })
  expect(f.settings.readProbe('chat').message).toBe('DSH starts once a chat model is saved; save the chat model first')
})

it('tests memory and diary through LCA’s own client, once, with the provider’s words on request', async () => {
  const f = setup(async () => { throw new Error('not used') })
  const fetcher = vi.fn(async () => new Response(JSON.stringify({ error: { message: 'The model `synthetic-memory` does not exist', code: 'model_not_found' } }), { status: 404 }))
  vi.stubGlobal('fetch', fetcher)
  f.settings.dispatch(probe('background')); await f.settings.idle()
  expect(fetcher).toHaveBeenCalledTimes(1)
  expect(f.settings.view().probe).toMatchObject({ slot: 'background', status: 'failed', detail: { path: 'direct', issue: { kind: 'model-not-found', httpStatus: 404, code: 'model_not_found' } } })
  snapshotSafe(f.settings.view())
  expect(f.settings.readProbe('background')).toMatchObject({ endpoint: 'https://memory.example.invalid/v1/chat/completions', model: 'synthetic-memory', message: 'The model `synthetic-memory` does not exist' })
})

it('a test that runs out of time is a timeout, not a cancellation', async () => {
  const f = setup()
  vi.stubGlobal('fetch', vi.fn((_url: string, init: RequestInit) => new Promise((_done, fail) => init.signal?.addEventListener('abort', () => fail(new DOMException('aborted', 'AbortError'))))))
  f.settings.dispatch(probe('background'))
  await new Promise((done) => setTimeout(done, 0)); f.clock.advanceBy(20_000); await f.settings.idle()
  expect(f.settings.view().probe).toMatchObject({ status: 'failed', code: 'connection-failed', detail: { issue: { kind: 'timeout', code: 'TIMEOUT' } } })
})

it('a passing test reports its path and time; changing a connection drops the old details', async () => {
  const f = setup(async () => ({ ok: true, durationMs: 812, route: { provider: 'deepseek-official', model: 'synthetic-chat' } }))
  f.settings.dispatch(probe('chat')); await f.settings.idle()
  expect(f.settings.view().probe).toMatchObject({ status: 'ok', detail: { path: 'dsh', adapter: 'deepseek-official', durationMs: 812 } })
  expect(f.settings.view().probe?.code).toBeUndefined()
  f.settings.dispatch({ type: 'models.routing.set', slot: 'work', mode: 'independent' } as AppCommand); await f.settings.idle()
  expect(f.settings.view().probe).toBeUndefined()
  expect(() => f.settings.readProbe('chat')).toThrow('CONNECTION_TEST_UNAVAILABLE')
})
