import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { createModelSettings } from '../../src/main/config/model-settings'
import { createManualClock } from '../../src/main/clock'
import { readModelProviders, resolveModelProviders } from '../../src/main/config/providers'
import { manualCapabilitiesSchema, modelCapabilityRef } from '../../src/main/config/model-capabilities'
import { dshRoutes } from '../../src/main/dsh/routes'
import type { AppCommand, ManualModelCapabilities } from '../../src/shared'
import { createModelClient } from '../../src/main/model/client'
import type { ModelRequest } from '../../src/main/model/types'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) { if (!root.startsWith(join(tmpdir(), 'lca-capabilities-'))) throw Error('UNSAFE_CLEANUP'); rmSync(root, { recursive: true, force: true }) } })
const chat = { base_url: 'https://synthetic.invalid/v1', api_key: 'synthetic-only-key', model: 'model-a' }
const declared: ManualModelCapabilities = { contextWindow: 65536, maxOutputTokens: 512, inputModalities: ['text', 'image'], reasoning: { off: null, medium: 'vendor_medium', high: 'vendor_high' } }
function setup(providers: Record<string, typeof chat> = { chat }) {
  const root = mkdtempSync(join(tmpdir(), 'lca-capabilities-')); roots.push(root)
  const file = join(root, 'connections', 'providers.json'); mkdirSync(join(root, 'connections')); writeFileSync(file, JSON.stringify({ providers, efforts: { chat: 'medium', work: 'high' } }))
  let applies = 0
  const settings = createModelSettings({ root, developer: false, slots: ['chat'], clock: createManualClock(), canConfigure: () => true, choose: async () => null, changed: () => {}, apply: async () => { applies++ } })
  const save = (capabilities: unknown, modelRef = settings.view().details!.chat!.modelRef!, slot = 'chat') => settings.dispatch({ type: 'models.capabilities.save', slot, modelRef, capabilities } as AppCommand)
  const provider = async (model: string, apiKey?: string) => { settings.dispatch({ type: 'models.provider.save', slot: 'chat', baseUrl: '', model, ...(apiKey ? { apiKey } : {}) } as AppCommand); await settings.idle() }
  return { root, file, settings, save, provider, applies: () => applies }
}

it('persists declarations, hot-applies them and passes actual fields to the DSH route', async () => {
  const f = setup(); expect(f.save(declared)).toBeUndefined(); await f.settings.idle()
  expect(f.applies()).toBe(1)
  expect(f.settings.view().details!.chat!.capabilities).toEqual({ editable: true, declared })
  expect(JSON.stringify(f.settings.view())).not.toContain(chat.api_key)
  expect(JSON.stringify(f.settings.view())).not.toContain(chat.base_url)
  const loaded = (await readModelProviders(f.file)).get('chat')!
  expect(loaded.capabilities).toEqual(declared)
  const resolved = resolveModelProviders(new Map([['chat', loaded]]), { work: 'follow-main', background: 'follow-main', privacy: 'independent' })
  expect(resolved.get('work')!.capabilities).toEqual(declared)
  const route = dshRoutes(loaded, resolved.get('work')!, { chat: 'medium' })
  const entry = JSON.parse(route.env.LCA_DSH_ROUTES).providers['lca-chat'].models[0]
  expect(entry).toEqual({ id: chat.model, contextWindow: 65536, maxTokens: 512, input: ['text', 'image'], reasoningEfforts: declared.reasoning })
  expect(JSON.parse(readFileSync(f.file, 'utf8')).modelCapabilities[modelCapabilityRef(chat)]).toEqual(declared)
  await f.settings.close()
})

it('does not carry declarations to another model or key, and restores them when returning to the original binding', async () => {
  const f = setup(); f.save(declared); await f.settings.idle()
  const originalRef = f.settings.view().details!.chat!.modelRef!
  await f.provider('model-b'); expect(f.settings.view().details!.chat!.capabilities!.declared).toBeUndefined()
  expect(f.save({ contextWindow: 1 }, originalRef)).toBe('stale-epoch')
  await f.provider('model-a'); expect(f.settings.view().details!.chat!.capabilities!.declared).toEqual(declared)
  await f.provider('model-a', 'another-synthetic-key'); expect(f.settings.view().details!.chat!.capabilities!.declared).toBeUndefined()
  await f.provider('model-a', chat.api_key); expect(f.settings.view().details!.chat!.capabilities!.declared).toEqual(declared)
  await f.settings.close()
})

it('shares one connection/model declaration across independent slots and clears unsupported effort selections', async () => {
  const f = setup({ chat, work: chat }); f.save(declared); await f.settings.idle()
  const ref = f.settings.view().details!.work!.modelRef!
  expect(ref).toBe(f.settings.view().details!.chat!.modelRef)
  f.save({ reasoning: false }, ref, 'work'); await f.settings.idle()
  expect(f.settings.view().details!.chat!.capabilities!.declared).toEqual({ reasoning: false })
  expect(f.settings.view().efforts).toEqual({})
  f.save(null); await f.settings.idle(); expect(f.settings.view().details!.chat!.capabilities!.declared).toBeUndefined()
  await f.settings.close()
})

it('removes declarations without leaving a stale chosen reasoning level', async () => {
  const f = setup(); f.save(declared); await f.settings.idle(); f.save(null); await f.settings.idle()
  expect(f.settings.view().efforts).toEqual({})
  expect((await readModelProviders(f.file)).get('chat')!.capabilities).toBeUndefined()
  await f.settings.close()
})

it.each([
  {}, { contextWindow: 0 }, { maxOutputTokens: 1.5 }, { contextWindow: 10, maxOutputTokens: 11 }, { contextWindow: 100_000_001 },
  { inputModalities: ['image'] }, { inputModalities: ['text', 'text'] }, { reasoning: { off: null } }, { reasoning: { high: null } },
  { reasoning: { low: 'not valid' } }, { reasoning: { ultra: 'ultra' } }, { command: 'shell' },
])('rejects malformed declarations atomically: %j', async (value) => {
  expect(manualCapabilitiesSchema.safeParse(value).success).toBe(false)
  const f = setup(), before = readFileSync(f.file)
  expect(f.save(value)).toBe('invalid-command'); expect(readFileSync(f.file)).toEqual(before); expect(f.applies()).toBe(0)
  await f.settings.close()
})

it('keeps native DeepSeek on its adapter and labels runtime facts separately from declarations', async () => {
  const f = setup({ chat: { ...chat, base_url: 'https://api.deepseek.com/v1', model: 'deepseek-flash' } })
  expect(f.settings.view().details!.chat!.capabilities!.editable).toBe(false)
  expect(f.save(declared)).toBe('unavailable')
  f.settings.setLevels({ chat: ['off', 'high', 'max'], work: null, capabilities: { chat: { contextWindow: 1000000, maxOutputTokens: 1000, inputModalities: ['text'] } } })
  expect(f.settings.view().details!.chat!.capabilities).toEqual({ editable: false, resolved: { contextWindow: 1000000, maxOutputTokens: 1000, inputModalities: ['text'] } })
  await f.settings.close()
})

it('imports declared capabilities without losing them and rejects invalid imported declarations atomically', async () => {
  const f = setup(); await f.settings.close()
  const input = join(f.root, 'input.json'), registry = { [modelCapabilityRef(chat)]: declared }
  writeFileSync(input, '\uFEFF' + JSON.stringify({ providers: { chat }, modelCapabilities: registry }))
  const settings = createModelSettings({ root: f.root, developer: false, slots: ['chat'], clock: createManualClock(), canConfigure: () => true, choose: async () => input, changed: () => {} })
  settings.dispatch({ type: 'models.configure' } as AppCommand); await settings.idle()
  expect(settings.view().details!.chat!.capabilities!.declared).toEqual(declared)
  const before = readFileSync(f.file)
  writeFileSync(input, JSON.stringify({ providers: { chat }, modelCapabilities: { [modelCapabilityRef(chat)]: { contextWindow: -1 } } }))
  settings.dispatch({ type: 'models.configure' } as AppCommand); await settings.idle()
  expect(settings.view().status).toBe('failed'); expect(readFileSync(f.file)).toEqual(before)
  await settings.close()
})

it('limits background-client output and rejects undeclared image input before fetching', async () => {
  const requests: Record<string, unknown>[] = []
  const fetcher = vi.fn(async (_url: string, options: RequestInit) => { requests.push(JSON.parse(options.body as string)); return new Response('data: {"choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n') })
  const client = createModelClient(new Map([['background', { ...chat, capabilities: { maxOutputTokens: 17, inputModalities: ['text'] as const } }]]), ['background'], createManualClock(), fetcher)
  const request: ModelRequest = { messages: [{ role: 'user', content: 'synthetic' }], signal: new AbortController().signal, tools: [], toolsExecuted: false, maxOutputTokens: 99 }
  await client.complete(request, () => {}); expect(requests[0].max_tokens).toBe(17)
  await expect(client.complete({ ...request, messages: [{ role: 'user', content: 'image', imageRefs: ['work-frame:' + 'a'.repeat(64)] }] }, () => {})).rejects.toMatchObject({ kind: 'configuration' })
  expect(fetcher).toHaveBeenCalledTimes(1)
})
