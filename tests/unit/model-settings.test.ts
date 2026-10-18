import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { createModelSettings } from '../../src/main/config/model-settings'
import { createManualClock } from '../../src/main/clock'
import { readVoiceConfig } from '../../src/main/voice/port'
import { readModelProviders } from '../../src/main/config/providers'
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
  expect(JSON.stringify(reopened.view())).not.toContain('synthetic-'); await reopened.close()
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
it.each(['missing-voice', 'protocol', 'http', 'extra', 'chat-extra'])('rejects invalid %s atomically without replacing a saved configuration (#23)', async (kind) => {
  const root = mkdtempSync(join(tmpdir(), 'lca-slot-')); roots.push(root); const file = join(root, 'input.json'); const tts: Record<string, string> = { protocol: 'openai-speech', base_url: 'https://speech.invalid/v1', api_key: 'synthetic-only', model: 'synthetic-model', voice: 'synthetic-voice' }
  const options = { root, developer: false, slots: [] as const, clock: createManualClock(), canConfigure: () => true, choose: async () => file, changed: () => {} }; const settings = createModelSettings(options)
  writeFileSync(file, JSON.stringify({ providers: { tts } })); settings.dispatch({ type: 'models.configure' } as AppCommand); await settings.idle(); const path = join(root, 'connections', 'providers.json'); const saved = readFileSync(path)
  if (kind === 'missing-voice') delete tts.voice; if (kind === 'protocol') tts.protocol = 'unrecognized'; if (kind === 'http') tts.base_url = 'http://speech.invalid'; if (kind === 'extra') tts.unknown = 'synthetic-only'
  writeFileSync(file, JSON.stringify({ providers: kind === 'chat-extra' ? { chat: tts } : { tts } })); settings.dispatch({ type: 'models.configure' } as AppCommand); await settings.idle()
  expect(settings.view()).toMatchObject({ status: 'failed', error: { code: 'configuration-failed' } }); expect(readFileSync(path)).toEqual(saved); await settings.close()
})
