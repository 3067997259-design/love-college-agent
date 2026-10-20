import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { createModelSettings } from '../../src/main/config/model-settings'
import { createManualClock } from '../../src/main/clock'
import { readVoiceConfig } from '../../src/main/voice/port'
import { readModelProviders, readModelRouting, resolveModelProviders } from '../../src/main/config/providers'
import type { AppCommand } from '../../src/shared'
const roots: string[] = []; afterEach(() => { for (const root of roots.splice(0)) { if (!resolve(root).startsWith(join(resolve(tmpdir()), 'lca-slot-'))) throw new Error('UNSAFE'); rmSync(root, { recursive: true, force: true }) } })
it('imports explicit TTS fields, preserves mixed chat/privacy slots, and reads the persisted voice configuration after reopen (#23)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'lca-slot-')); roots.push(root); const file = join(root, 'synthetic-input.json')
  const tts = { protocol: 'openai-speech', base_url: 'https://speech.invalid/v1', api_key: 'synthetic-speech-only', model: 'synthetic-speech-model', voice: 'synthetic-stock-voice' }
  const config = { providers: { chat: { base_url: 'https://chat.invalid/v1', api_key: 'synthetic-chat-only', model: 'synthetic-chat-model' }, privacy: { base_url: '', api_key: '', model: '' }, tts } }
  writeFileSync(file, JSON.stringify(config)); const options = { root, developer: false, slots: [] as const, clock: createManualClock(), canConfigure: () => true, choose: async () => file, changed: () => {} }
  const settings = createModelSettings(options); expect(settings.dispatch({ type: 'models.configure' } as AppCommand)).toBeUndefined(); await settings.idle(); expect(settings.view()).toMatchObject({ status: 'saved', restartRequired: true, configuredSlots: ['chat'] })
  const saved = join(root, 'connections', 'providers.json'); expect(JSON.parse(readFileSync(saved, 'utf8'))).toEqual(config); await settings.close()
  const reopened = createModelSettings(options); expect(await readVoiceConfig(saved)).toEqual(tts); expect((await readModelProviders(saved)).has('chat')).toBe(true); expect((await readModelProviders(saved)).has('privacy')).toBe(false)
  const shown = JSON.stringify(reopened.view())
  for (const secret of ['synthetic-chat-only', 'synthetic-speech-only', 'chat.invalid', 'speech.invalid', 'synthetic-stock-voice']) expect(shown).not.toContain(secret)
  expect(reopened.view().details?.chat).toEqual({ vendor: null, host: 'cha•••.invalid', model: 'synthetic-chat-model' }); await reopened.close()
// Real Windows filesystem import/readback can exceed 5s on a hosted worker.
// Assertions and application deadlines stay unchanged; this fixture has no network.
}, 15000)
it('saves and removes one GUI provider while preserving mail/tts and keeping values out of the view (#provider-gui)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'lca-slot-')); roots.push(root); const file = join(root, 'connections', 'providers.json'); mkdirSync(join(root, 'connections'), { recursive: true })
  const tts = { protocol: 'openai-speech', base_url: 'https://speech.invalid/v1', api_key: 'synthetic-speech-only', model: 'synthetic-speech-model', voice: 'synthetic-stock-voice' }
  const mail = { host: 'imap.invalid', port: 993, tls: true, user: 'synthetic-user', auth_code: 'synthetic-mail-secret', folder: '桃子' }
  writeFileSync(file, JSON.stringify({ providers: { tts }, mail }))
  const options = { root, developer: false, slots: [] as const, clock: createManualClock(), canConfigure: () => true, choose: async () => null, changed: () => {} }
  const settings = createModelSettings(options)
  expect(settings.dispatch({ type: 'models.provider.save', slot: 'chat', baseUrl: 'https://chat.invalid/v1', model: 'synthetic-chat', apiKey: 'synthetic-chat-secret' } as AppCommand)).toBeUndefined()
  await settings.idle(); expect(settings.view().configuredSlots).toEqual(['chat']); expect(JSON.stringify(settings.view())).not.toContain('synthetic-chat-secret'); expect(JSON.stringify(settings.view())).not.toContain('chat.invalid')
  let saved = JSON.parse(readFileSync(file, 'utf8')); expect(saved.providers.tts).toEqual(tts); expect(saved.mail).toEqual(mail); expect(saved.providers.chat).toEqual({ base_url: 'https://chat.invalid/v1', api_key: 'synthetic-chat-secret', model: 'synthetic-chat' })
  expect(settings.dispatch({ type: 'models.provider.remove', slot: 'chat' } as AppCommand)).toBeUndefined(); await settings.idle()
  saved = JSON.parse(readFileSync(file, 'utf8')); expect(settings.view().configuredSlots).toEqual([]); expect(saved.providers.tts).toEqual(tts); expect(saved.mail).toEqual(mail); expect(saved.providers.chat).toBeUndefined(); await settings.close()
})
it.each(['missing-voice', 'protocol', 'http', 'model-type', 'routing'])('rejects invalid %s atomically without replacing a saved configuration (#23)', async (kind) => {
  const root = mkdtempSync(join(tmpdir(), 'lca-slot-')); roots.push(root); const file = join(root, 'input.json'); const tts: Record<string, unknown> = { protocol: 'openai-speech', base_url: 'https://speech.invalid/v1', api_key: 'synthetic-only', model: 'synthetic-model', voice: 'synthetic-voice' }
  const options = { root, developer: false, slots: [] as const, clock: createManualClock(), canConfigure: () => true, choose: async () => file, changed: () => {} }; const settings = createModelSettings(options)
  writeFileSync(file, JSON.stringify({ providers: { tts } })); settings.dispatch({ type: 'models.configure' } as AppCommand); await settings.idle(); const path = join(root, 'connections', 'providers.json'); const saved = readFileSync(path)
  if (kind === 'missing-voice') delete tts.voice; if (kind === 'protocol') tts.protocol = 'unrecognized'; if (kind === 'http') tts.base_url = 'http://speech.invalid'; if (kind === 'model-type') tts.model = 42
  writeFileSync(file, JSON.stringify({ providers: { tts }, ...(kind === 'routing' ? { routing: { privacy: 'automatic' } } : {}) })); settings.dispatch({ type: 'models.configure' } as AppCommand); await settings.idle()
  expect(settings.view()).toMatchObject({ status: 'failed', error: { code: 'configuration-failed' } }); expect(readFileSync(path)).toEqual(saved); await settings.close()
})

it('hot-applies GUI configuration and explicit routes without losing the fallback configuration', async () => {
  const root = mkdtempSync(join(tmpdir(), 'lca-slot-')); roots.push(root)
  const fallback = join(root, 'fallback.json'); const chat = { base_url: 'https://chat.invalid/v1', api_key: 'only-synthetic-secret', model: 'synthetic-model' }
  writeFileSync(fallback, JSON.stringify({ description: 'synthetic legacy annotation', providers: { chat: { ...chat, description: 'synthetic slot annotation' }, privacy: { base_url: '', api_key: '', model: '' } } }))
  const before = readFileSync(fallback); let applied = 0
  const settings = createModelSettings({ root, fallback, apply: async () => { applied++ }, developer: false, slots: ['chat'], clock: createManualClock(), canConfigure: () => true, choose: async () => null, changed: () => {} })
  expect(settings.view().routing).toEqual({ background: 'follow-main', privacy: 'independent', work: 'follow-main' })
  settings.dispatch({ type: 'models.routing.set', slot: 'privacy', mode: 'follow-main' } as AppCommand); await settings.idle()
  expect(applied).toBe(1); expect(settings.view().restartRequired).toBe(false); expect(readFileSync(fallback)).toEqual(before)
  const file = join(root, 'connections', 'providers.json'); expect((await readModelProviders(file)).get('chat')).toEqual(chat)
  const routing = await readModelRouting(file); expect(routing.privacy).toBe('follow-main'); expect(resolveModelProviders(await readModelProviders(file), routing).get('background')).toEqual(chat)
  settings.dispatch({ type: 'models.routing.set', slot: 'privacy', mode: 'independent' } as AppCommand); await settings.idle()
  settings.dispatch({ type: 'models.provider.remove', slot: 'privacy' } as AppCommand); await settings.idle()
  expect((await readModelRouting(file)).privacy).toBe('independent'); expect(resolveModelProviders(await readModelProviders(file), await readModelRouting(file)).has('privacy')).toBe(false)
  expect(applied).toBe(3); await settings.close()
})

it('imports annotated bootstrap configuration and a UTF-8 BOM without changing credentials, services or privacy policy', async () => {
  const root = mkdtempSync(join(tmpdir(), 'lca-slot-')); roots.push(root); const file = join(root, 'annotated.json')
  const chat = { base_url: 'https://chat.invalid/v1', api_key: 'synthetic-chat-secret', model: 'synthetic-chat-model' }
  const privacy = { base_url: '', api_key: '', model: '' }
  const tts = { protocol: 'openai-speech', base_url: 'https://speech.invalid/v1', api_key: 'synthetic-speech-secret', model: 'synthetic-speech', voice: 'synthetic-voice' }
  const mail = { host: 'imap.invalid', port: 1993, tls: true, user: 'synthetic-user', auth_code: 'synthetic-mail-secret', folder: '桃子' }
  const routing = { background: 'follow-main', privacy: 'independent' }
  writeFileSync(file, '\uFEFF' + JSON.stringify({ notes: 'synthetic root annotation', providers: { chat: { ...chat, description: 'synthetic provider annotation' }, privacy, tts: { ...tts, description: 'synthetic voice annotation' } }, mail: { ...mail, description: 'synthetic mail annotation' }, routing }))
  const before = readFileSync(file)
  const settings = createModelSettings({ root, developer: false, slots: [], clock: createManualClock(), canConfigure: () => true, choose: async () => file, changed: () => {} })
  settings.dispatch({ type: 'models.configure' } as AppCommand); await settings.idle()
  expect(settings.view()).toMatchObject({ status: 'saved', configuredSlots: ['chat'], routing, services: { mail: true, tts: true } })
  const saved = join(root, 'connections', 'providers.json')
  expect(JSON.parse(readFileSync(saved, 'utf8'))).toEqual({ providers: { chat, privacy, tts }, mail, routing })
  expect(readFileSync(file)).toEqual(before)
  for (const secret of ['synthetic-chat-secret', 'synthetic-speech-secret', 'synthetic-mail-secret', 'synthetic-user', 'synthetic-voice', 'chat.invalid', 'annotation']) expect(JSON.stringify(settings.view())).not.toContain(secret)
  expect(await readVoiceConfig(saved)).toEqual(tts); expect((await readModelRouting(saved)).privacy).toBe('independent')
  await settings.close()
})

it('accepts Rodin address/key without a fictitious model and preserves a non-default mail port on credential edits', async () => {
  const root = mkdtempSync(join(tmpdir(), 'lca-slot-')); roots.push(root)
  const settings = createModelSettings({ root, developer: false, slots: [], clock: createManualClock(), canConfigure: () => true, choose: async () => null, changed: () => {} })
  settings.dispatch({ type: 'models.service.save', service: 'rodin', baseUrl: 'https://rodin.invalid', model: '', apiKey: 'synthetic-rodin-key' } as AppCommand); await settings.idle(); expect(settings.view().status).toBe('saved')
  settings.dispatch({ type: 'mail.configure', host: 'imap.invalid', port: 1993, user: 'synthetic-user', authCode: 'synthetic-old-code' } as AppCommand); await settings.idle()
  settings.dispatch({ type: 'mail.configure', host: '', user: '', authCode: 'synthetic-new-code' } as AppCommand); await settings.idle()
  const saved = JSON.parse(readFileSync(join(root, 'connections', 'providers.json'), 'utf8')); expect(saved.mail.port).toBe(1993); expect(saved.mail.auth_code).toBe('synthetic-new-code'); expect(saved.providers.rodin.api_key).toBe('synthetic-rodin-key')
  await settings.close()
})

it('keeps a thinking level per role, applies it without a restart, and drops it when that model changes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'lca-slot-')); roots.push(root); const file = join(root, 'connections', 'providers.json'); mkdirSync(join(root, 'connections'), { recursive: true })
  writeFileSync(file, JSON.stringify({ providers: { chat: { base_url: 'https://api.deepseek.com/v1', api_key: 'synthetic-chat-secret', model: 'deepseek-flash' } } }))
  let applied = 0; const changes: unknown[] = []
  // Busy work must not block a level change: it applies from her next step.
  const settings = createModelSettings({ root, apply: async () => { applied++ }, developer: false, slots: ['chat'], clock: createManualClock(), canConfigure: () => false, choose: async () => null, changed: () => {}, effortsChanged: (efforts) => { changes.push(efforts) } })
  expect(settings.view().details?.chat).toEqual({ vendor: 'DeepSeek', host: 'api•••.com', model: 'deepseek-flash' })
  expect(settings.view().routing?.work).toBe('follow-main')
  expect(settings.dispatch({ type: 'models.effort.set', role: 'work', effort: 'max' } as AppCommand)).toBeUndefined(); await settings.idle()
  expect(settings.dispatch({ type: 'models.effort.set', role: 'chat', effort: 'low' } as AppCommand)).toBeUndefined(); await settings.idle()
  expect(JSON.parse(readFileSync(file, 'utf8')).efforts).toEqual({ work: 'max', chat: 'low' })
  expect(settings.view().efforts).toEqual({ work: 'max', chat: 'low' }); expect(changes).toEqual([{ work: 'max' }, { work: 'max', chat: 'low' }]); expect(applied).toBe(0)
  expect(settings.dispatch({ type: 'models.provider.save', slot: 'chat', baseUrl: '', model: 'deepseek-v4-pro' } as AppCommand)).toBe('unavailable')
  await settings.close()
  // A different chat model starts from its provider's default; work followed it, so its level goes too.
  const free = createModelSettings({ root, apply: async () => {}, developer: false, slots: ['chat'], clock: createManualClock(), canConfigure: () => true, choose: async () => null, changed: () => {} })
  free.setLevels({ chat: ['low', 'medium', 'high', 'bogus'], work: null })
  expect(free.view().levels).toEqual({ chat: ['low', 'medium', 'high'] })
  free.dispatch({ type: 'models.provider.save', slot: 'chat', baseUrl: '', model: 'deepseek-v4-pro' } as AppCommand); await free.idle()
  expect(JSON.parse(readFileSync(file, 'utf8')).efforts).toEqual({}); expect(free.view().levels).toBeUndefined()
  free.dispatch({ type: 'models.provider.save', slot: 'work', baseUrl: 'https://api.moonshot.cn/v1', model: 'kimi-k3', apiKey: 'synthetic-work-secret' } as AppCommand); await free.idle()
  expect(free.view().routing?.work).toBe('independent'); expect(free.view().details?.work).toEqual({ vendor: 'Kimi', host: 'api•••.cn', model: 'kimi-k3' })
  expect(JSON.stringify(free.view())).not.toContain('synthetic-work-secret')
  expect(resolveModelProviders(await readModelProviders(file), await readModelRouting(file)).get('work')?.model).toBe('kimi-k3')
  await free.close()
})
