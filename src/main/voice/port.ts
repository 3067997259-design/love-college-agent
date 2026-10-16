import { readFile } from 'node:fs/promises'
import { z } from 'zod'
import type { Clock } from '../clock'

export const voiceConfigSchema = z.strictObject({ protocol: z.literal('openai-speech'), base_url: z.string().url().max(4096).refine((value) => { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password && !url.hash && !url.search }), api_key: z.string().min(1).max(4096), model: z.string().min(1).max(128), voice: z.string().min(1).max(128) })
export type VoiceConfig = z.infer<typeof voiceConfigSchema>
export interface VoicePort { source: 'real' | 'fake'; synthesize(text: string, signal: AbortSignal, chunk: (pcm: Uint8Array) => void): Promise<void> }
/** Main only. An explicit protocol, model and stock/designed voice are required; nothing defaults to another provider. */
export async function readVoiceConfig(filename: string): Promise<VoiceConfig | null> {
  try {
    return voiceConfigSchema.parse(JSON.parse(await readFile(filename, 'utf8')).providers?.tts)
  } catch { return null }
}
export function createSpeechPort(config: VoiceConfig, transport: typeof fetch = fetch, source: VoicePort['source'] = 'real'): VoicePort {
  return { source, synthesize: async (text, signal, chunk) => {
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
    try {
      const response = await transport(config.base_url.replace(/\/$/, '') + '/audio/speech', { method: 'POST', redirect: 'error', signal,
        headers: { Authorization: 'Bearer ' + config.api_key, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: config.model, voice: config.voice, input: text, response_format: 'pcm' }) })
      if (!response.ok || !response.body || !/^(audio\/(?:pcm|raw)|application\/octet-stream)(?:;|$)/i.test(response.headers.get('content-type') ?? '')) { await response.body?.cancel(); throw new Error('VOICE_UNAVAILABLE') }
      reader = response.body.getReader(); let total = 0
      const key = Buffer.from(config.api_key); const keep = Math.max(key.length - 1, 1)
      const pending = Buffer.alloc(8192 + keep); let length = 0
      for (;;) {
        const next = await reader.read(); signal.throwIfAborted()
        if (next.done) break
        total += next.value.byteLength; if (total > 1_440_000) throw new Error('VOICE_UNAVAILABLE')
        // Transport reads have no audio meaning. Coalesce into fixed application frames while
        // withholding enough bytes to detect a credential split across any network boundary.
        for (let offset = 0; offset < next.value.length;) {
          const count = Math.min(pending.length - length, next.value.length - offset); pending.set(next.value.subarray(offset, offset + count), length); length += count; offset += count
          if (pending.subarray(0, length).includes(key)) throw new Error('VOICE_UNAVAILABLE')
          if (length === pending.length) { chunk(Buffer.from(pending.subarray(0, 8192))); pending.copyWithin(0, 8192, length); length -= 8192 }
        }
      }
      if (!total || total % 2) throw new Error('VOICE_UNAVAILABLE')
      for (let offset = 0; offset < length; offset += 8192) chunk(Buffer.from(pending.subarray(offset, Math.min(length, offset + 8192))))
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
