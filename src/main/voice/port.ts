import { readFile } from 'node:fs/promises'
import { z } from 'zod'
import type { Clock } from '../clock'

const configSchema = z.strictObject({ protocol: z.literal('openai-speech'), base_url: z.string().url(), api_key: z.string().min(1).max(4096), model: z.string().min(1).max(128), voice: z.string().min(1).max(128) })
export type VoiceConfig = z.infer<typeof configSchema>
export interface VoicePort { source: 'real' | 'fake'; synthesize(text: string, signal: AbortSignal, chunk: (pcm: Uint8Array) => void): Promise<void> }
/** Main only. An explicit protocol, model and stock/designed voice are required; nothing defaults to another provider. */
export async function readVoiceConfig(filename: string): Promise<VoiceConfig | null> {
  try {
    const parsed = configSchema.parse(JSON.parse(await readFile(filename, 'utf8')).providers?.tts); const url = new URL(parsed.base_url)
    if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.search) return null
    return parsed
  } catch { return null }
}
export function createSpeechPort(config: VoiceConfig, transport: typeof fetch = fetch, source: VoicePort['source'] = 'real'): VoicePort {
  return { source, synthesize: async (text, signal, chunk) => {
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
    try {
      const response = await transport(config.base_url.replace(/\/$/, '') + '/audio/speech', { method: 'POST', redirect: 'error', signal,
        headers: { Authorization: 'Bearer ' + config.api_key, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: config.model, voice: config.voice, input: text, response_format: 'pcm' }) })
      if (!response.ok || !response.body || !/^(audio\/(?:pcm|raw)|application\/octet-stream)(?:;|$)/i.test(response.headers.get('content-type') ?? '')) { await response.body?.cancel(); throw new Error('VOICE_UNAVAILABLE') }
      reader = response.body.getReader(); let pending = Buffer.alloc(0); let total = 0
      const key = Buffer.from(config.api_key); const keep = Math.max(key.length - 1, 1)
      for (;;) {
        const next = await reader.read(); signal.throwIfAborted()
        if (next.done) break
        total += next.value.byteLength; if (total > 1_440_000) throw new Error('VOICE_UNAVAILABLE')
        pending = Buffer.concat([pending, next.value]); if (pending.includes(key)) throw new Error('VOICE_UNAVAILABLE')
        const ready = Math.max(0, pending.length - keep) & ~1
        for (let offset = 0; offset < ready; offset += 8192) chunk(pending.subarray(offset, Math.min(ready, offset + 8192)))
        pending = pending.subarray(ready)
      }
      if (!total || total % 2) throw new Error('VOICE_UNAVAILABLE')
      if (pending.length) chunk(pending)
    } catch { throw new Error('VOICE_UNAVAILABLE') } finally { await reader?.cancel().catch(() => {}); reader?.releaseLock() }
  } }
}
/** A short test tone, never described as a voice or a real synthesis. */
export function createFakeVoice(clock: Clock): VoicePort {
  return { source: 'fake', synthesize: async (_text, signal, chunk) => {
    for (let index = 0; index < 3; index++) {
      signal.throwIfAborted(); const pcm = Buffer.alloc(4800)
      for (let i = 0; i < 2400; i++) pcm.writeInt16LE(Math.round(Math.sin((index * 2400 + i) * Math.PI * 440 / 12000) * 600), i * 2)
      chunk(pcm)
      await new Promise<void>((done, reject) => { const cancel = clock.after(100, () => { signal.removeEventListener('abort', abort); done() }); const abort = () => { cancel(); reject(new Error('VOICE_CANCELLED')) }; signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort() })
    }
  } }
}
