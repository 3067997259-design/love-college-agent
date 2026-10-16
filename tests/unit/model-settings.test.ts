import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { createModelSettings } from '../../src/main/config/model-settings'
import { readVoiceConfig } from '../../src/main/voice/port'
import { readModelProviders } from '../../src/main/config/providers'
import type { AppCommand } from '../../src/shared'
const roots: string[] = []; afterEach(() => { for (const root of roots.splice(0)) { if (!resolve(root).startsWith(join(resolve(tmpdir()), 'lca-slot-'))) throw new Error('UNSAFE'); rmSync(root, { recursive: true, force: true }) } })
it('imports explicit TTS fields, preserves mixed chat/privacy slots, and reads the persisted voice configuration after reopen (#23)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'lca-slot-')); roots.push(root); const file = join(root, 'synthetic-input.json')
  const tts = { protocol: 'openai-speech', base_url: 'https://speech.invalid/v1', api_key: 'synthetic-speech-only', model: 'synthetic-speech-model', voice: 'synthetic-stock-voice' }
  const config = { providers: { chat: { base_url: 'https://chat.invalid/v1', api_key: 'synthetic-chat-only', model: 'synthetic-chat-model' }, privacy: { base_url: '', api_key: '', model: '' }, tts } }
  writeFileSync(file, JSON.stringify(config)); const options = { root, developer: false, slots: [] as const, canConfigure: () => true, choose: async () => file, changed: () => {} }
  const settings = createModelSettings(options); expect(settings.dispatch({ type: 'models.configure' } as AppCommand)).toBeUndefined(); await settings.idle(); expect(settings.view()).toMatchObject({ status: 'saved', restartRequired: true })
  const saved = join(root, 'connections', 'providers.json'); expect(JSON.parse(readFileSync(saved, 'utf8'))).toEqual(config); await settings.close()
  const reopened = createModelSettings(options); expect(await readVoiceConfig(saved)).toEqual(tts); expect((await readModelProviders(saved)).has('chat')).toBe(true); expect((await readModelProviders(saved)).has('privacy')).toBe(false)
  expect(JSON.stringify(reopened.view())).not.toContain('synthetic-'); await reopened.close()
})
it.each(['missing-voice', 'protocol', 'http', 'extra', 'chat-extra'])('rejects invalid %s atomically without replacing a saved configuration (#23)', async (kind) => {
  const root = mkdtempSync(join(tmpdir(), 'lca-slot-')); roots.push(root); const file = join(root, 'input.json'); const tts: Record<string, string> = { protocol: 'openai-speech', base_url: 'https://speech.invalid/v1', api_key: 'synthetic-only', model: 'synthetic-model', voice: 'synthetic-voice' }
  const options = { root, developer: false, slots: [] as const, canConfigure: () => true, choose: async () => file, changed: () => {} }; const settings = createModelSettings(options)
  writeFileSync(file, JSON.stringify({ providers: { tts } })); settings.dispatch({ type: 'models.configure' } as AppCommand); await settings.idle(); const path = join(root, 'connections', 'providers.json'); const saved = readFileSync(path)
  if (kind === 'missing-voice') delete tts.voice; if (kind === 'protocol') tts.protocol = 'unrecognized'; if (kind === 'http') tts.base_url = 'http://speech.invalid'; if (kind === 'extra') tts.unknown = 'synthetic-only'
  writeFileSync(file, JSON.stringify({ providers: kind === 'chat-extra' ? { chat: tts } : { tts } })); settings.dispatch({ type: 'models.configure' } as AppCommand); await settings.idle()
  expect(settings.view()).toMatchObject({ status: 'failed', error: { code: 'configuration-failed' } }); expect(readFileSync(path)).toEqual(saved); await settings.close()
})
