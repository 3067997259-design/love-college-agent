import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { afterEach, expect, it, vi } from 'vitest'
import { createManualClock } from '../../src/main/clock'
import { createVoice } from '../../src/main/voice/service'
import { createSpeechPort, readVoiceConfig, type VoicePort } from '../../src/main/voice/port'
import { openJournal } from '../../src/main/journal/file'
import { projectJournal } from '../../src/main/journal/projection'
import type { SessionStore } from '../../src/main/store/session'
import type { AppCommand } from '../../src/shared'

const cleanup: (() => void)[] = []; afterEach(() => cleanup.splice(0).reverse().forEach((fn) => fn()))
function fixture(port: VoicePort | null = { source: 'fake', synthesize: async (_text, _signal, chunk) => { chunk(new Uint8Array([0, 0, 1, 0])) } }) {
  const root = mkdtempSync(join(tmpdir(), 'lca-voice-')); cleanup.push(() => { if (!resolve(root).startsWith(join(resolve(tmpdir()), 'lca-voice-'))) throw new Error('UNSAFE'); rmSync(root, { recursive: true, force: true }) })
  const clock = createManualClock(1000); const j = openJournal(root, { userId: 'u', characterId: 'c' }, clock); cleanup.push(j.close)
  const store: SessionStore = { scope: j.scope, append: j.append, records: j.records, projection: () => projectJournal(j.records()), close: j.close }
  let blocked = false; const changed = vi.fn(); const options = { store, clock, port, blocked: () => blocked, changed, safeText: (text: string) => text.replaceAll('PRIVATE_KEY_CANARY', '[redacted]') }
  const voice = createVoice(options)
  const say = (text = 'PUBLIC_REPLY', reason: 'completed' | 'error' = 'completed') => { const id = randomUUID(); store.append({ type: 'turn/start', turnId: id, trigger: 'user' }); store.append({ type: 'assistant/message', id, turnId: id, text, status: 'complete' }); store.append({ type: 'turn/end', turnId: id, reason }); voice.observe(); return id }
  const send = (body: object) => voice.dispatch(body as AppCommand)
  return { root, clock, store, voice, say, send, options, block: () => { blocked = true; voice.stateChanged() } }
}
it('defaults to silence, fails closed without configuration and never replays old messages on enable/restart', async () => {
  const f = fixture(); f.say(); expect(f.voice.view().utterance).toBeUndefined(); f.send({ type: 'voice.set', enabled: true }); f.voice.observe(); expect(f.voice.view().utterance).toBeUndefined()
  f.say(); await f.voice.idle(); const view = f.voice.view(); expect(view.utterance).toMatchObject({ status: 'ready', chunkCount: 1, byteLength: 4 })
  expect(JSON.stringify(view)).not.toContain('PUBLIC_REPLY'); expect(JSON.stringify(f.store.records().filter((r) => r.type.startsWith('voice/')))).not.toContain('PUBLIC_REPLY')
  expect(f.voice.read({ utteranceId: view.utterance!.id, afterChunk: -1 })).toMatchObject({ done: true, chunks: [{ index: 0, pcmBase64: 'AAABAA==' }] })
  expect(() => f.voice.read({ utteranceId: randomUUID(), afterChunk: -1 })).toThrow(); expect(() => f.voice.read({ utteranceId: view.utterance!.id, afterChunk: 1 })).toThrow()
  const restarted = createVoice(f.options); expect(restarted.view().enabled).toBe(true); restarted.observe(); expect(restarted.view().utterance).toBeUndefined(); await restarted.close(); await f.voice.close()
  const none = fixture(null); expect(none.send({ type: 'voice.set', enabled: true })).toBe('not-configured'); none.say(); expect(none.voice.view()).toMatchObject({ enabled: false, available: false, source: 'none' })
})
it('voices only complete public success, scrubs credentials and keeps text available after synthesis failure', async () => {
  const texts: string[] = []; const f = fixture({ source: 'fake', synthesize: async (text) => { texts.push(text); throw new Error('PRIVATE_UPSTREAM_BODY') } }); f.send({ type: 'voice.set', enabled: true })
  f.say('FAILED_TURN_PARTIAL', 'error'); expect(texts).toEqual([])
  f.say('Hello PRIVATE_KEY_CANARY'); await f.voice.idle(); expect(texts).toEqual(['Hello [redacted]']); expect(f.voice.view()).toMatchObject({ utterance: { status: 'failed' }, error: { code: 'connection-failed' } })
  expect(f.store.projection().messages.at(-1)?.text).toBe('Hello PRIVATE_KEY_CANARY'); expect(JSON.stringify(f.voice.view())).not.toContain('PRIVATE_UPSTREAM_BODY'); await f.voice.close()
})
it.each(['block', 'mute', 'interrupt', 'timeout'] as const)('cancels on %s and refuses late chunks from an abort-ignoring provider', async (action) => {
  let push!: (pcm: Uint8Array) => void; let done!: () => void; let signal!: AbortSignal
  const f = fixture({ source: 'fake', synthesize: async (_text, input, chunk) => { signal = input; push = chunk; await new Promise<void>((resolve) => { done = resolve }) } }); f.send({ type: 'voice.set', enabled: true }); f.say()
  push(new Uint8Array(4)); const id = f.voice.view().utterance!.id
  if (action === 'block') f.block(); if (action === 'mute') f.send({ type: 'voice.set', enabled: false }); if (action === 'interrupt') f.voice.interrupt(); if (action === 'timeout') f.clock.advanceBy(30000)
  expect(signal.aborted).toBe(true); expect(() => push(new Uint8Array(4))).toThrow(); expect(() => f.voice.read({ utteranceId: id, afterChunk: -1 })).toThrow(); done(); await f.voice.idle()
  expect(f.voice.view().utterance?.status).toBe(action === 'timeout' ? 'failed' : 'cancelled'); await f.voice.close()
})
it('bounds chunks, text and daily attempts without retrying the provider', async () => {
  const synthesize = vi.fn(async (_text, _signal, chunk: (pcm: Uint8Array) => void) => { chunk(new Uint8Array(3)) })
  const f = fixture({ source: 'fake', synthesize }); f.send({ type: 'voice.set', enabled: true }); f.say(); await f.voice.idle(); expect(f.voice.view().utterance?.status).toBe('failed')
  const before = synthesize.mock.calls.length; f.say('x'.repeat(1201)); expect(synthesize).toHaveBeenCalledTimes(before)
  for (let i = 0; i < 29; i++) { f.say(); await f.voice.idle() }; f.say(); expect(synthesize).toHaveBeenCalledTimes(30); expect(f.voice.view().error?.code).toBe('quota-exhausted'); await f.voice.close()
})
it('requires an explicit secure speech protocol, model and voice in main-only configuration', async () => {
  const f = fixture(); const file = join(f.root, 'providers.json'); const write = (tts: unknown) => writeFileSync(file, JSON.stringify({ providers: { tts } }))
  write({ base_url: 'https://speech.invalid/v1', api_key: 'synthetic', model: 'configured', voice: 'configured' }); expect(await readVoiceConfig(file)).toBeNull()
  write({ protocol: 'openai-speech', base_url: 'http://speech.invalid/v1', api_key: 'synthetic', model: 'configured', voice: 'configured' }); expect(await readVoiceConfig(file)).toBeNull()
  write({ protocol: 'openai-speech', base_url: 'https://speech.invalid/v1', api_key: 'synthetic', model: 'configured', voice: 'configured' }); expect(await readVoiceConfig(file)).not.toBeNull()
})
it('streams uneven HTTP chunks into even PCM, refuses secret echoes, JSON/errors, empty and oversized audio', async () => {
  const config = { protocol: 'openai-speech' as const, base_url: 'https://speech.invalid/v1', api_key: 'SYNTHETIC_SPEECH_CREDENTIAL', model: 'configured-model', voice: 'configured-stock-voice' }
  const calls: { url: string; body: Record<string, unknown> }[] = []
  const make = (parts: Uint8Array[], type = 'audio/pcm', status = 200) => createSpeechPort(config, (async (url, options) => { calls.push({ url: String(url), body: JSON.parse(options!.body as string) }); return new Response(new ReadableStream({ start(controller) { for (const part of parts) controller.enqueue(part); controller.close() } }), { status, headers: { 'Content-Type': type } }) }) as typeof fetch, 'fake')
  const chunks: Buffer[] = []; await make([new Uint8Array(19), new Uint8Array(27), new Uint8Array(8000)]).synthesize('PUBLIC_INPUT', new AbortController().signal, (pcm) => chunks.push(Buffer.from(pcm)))
  expect(Buffer.concat(chunks)).toHaveLength(8046); for (const chunk of chunks) expect(chunk.length % 2).toBe(0)
  expect(calls[0]).toEqual({ url: 'https://speech.invalid/v1/audio/speech', body: { input: 'PUBLIC_INPUT', response_format: 'pcm', model: 'configured-model', voice: 'configured-stock-voice' } })
  for (const port of [make([Buffer.from(config.api_key.slice(0, 10)), Buffer.from(config.api_key.slice(10))]), make([new Uint8Array(4)], 'application/json'), make([new Uint8Array(4)], 'audio/pcm', 503), make([]), make([new Uint8Array(1_440_002)]), make([new Uint8Array(3)])]) {
    const output: Buffer[] = []; await expect(port.synthesize('public', new AbortController().signal, (pcm) => output.push(Buffer.from(pcm)))).rejects.toThrow('VOICE_UNAVAILABLE'); expect(Buffer.concat(output).includes(Buffer.from(config.api_key))).toBe(false)
  }
})
it('uses the actual HTTP streaming reader and cancels an open loopback response', async () => {
  let authorized = false
  const server = createServer((request, response) => { authorized = request.headers.authorization === 'Bearer synthetic-local-test'; response.writeHead(200, { 'Content-Type': 'audio/pcm' }); response.write(Buffer.alloc(4800)) })
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done)); const address = server.address(); if (!address || typeof address === 'string') throw new Error('NO_PORT')
  const abort = new AbortController(); let bytes = 0
  try {
    const port = createSpeechPort({ protocol: 'openai-speech', base_url: `http://127.0.0.1:${address.port}/v1`, api_key: 'synthetic-local-test', model: 'fake', voice: 'test-tone' }, fetch, 'fake')
    await expect(port.synthesize('LOOPBACK_ONLY', abort.signal, (chunk) => { bytes += chunk.byteLength; abort.abort() })).rejects.toThrow('VOICE_UNAVAILABLE')
    expect(bytes).toBeGreaterThan(0); expect(authorized).toBe(true)
  } finally { abort.abort(); server.closeAllConnections(); await new Promise<void>((done) => server.close(() => done())) }
})
