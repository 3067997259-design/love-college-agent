import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { AppCommand, PublicErrorCode, VoiceRead, VoiceView } from '../../shared'
import type { Clock } from '../clock'
import type { SessionStore } from '../store/session'
import { calendarDay } from '../life/service'
import type { VoicePort } from './port'
import { ResourceFailure, type ResourceAdmissions } from '../resources/ledger'

export function createVoice(options: { store: SessionStore; clock: Clock; port: VoicePort | null; blocked(): boolean; changed(): void; safeText(text: string): string; budget?: ResourceAdmissions }) {
  const { store, clock, port } = options; const rows = () => store.history?.() ?? store.records()
  let enabled = rows().findLast((row) => row.type === 'voice/settings')?.enabled ?? false
  let utterance: VoiceView['utterance']; let chunks: Buffer[] = []; let error: VoiceView['error']; let active: AbortController | undefined; let worker: Promise<void> | undefined; let closed = false
  const observed = new Set(rows().flatMap((row) => row.type === 'assistant/message' ? [row.id] : []))
  const state = (): VoiceView => ({ enabled, available: !!port, source: port?.source ?? 'none', ...(utterance ? { utterance: { ...utterance } } : {}), ...(error ? { error } : {}) })
  const stop = () => { active?.abort(); if (utterance && !['cancelled', 'failed'].includes(utterance.status) && utterance.playback !== 'ended') { utterance = { ...utterance, status: 'cancelled', playback: 'ended' }; chunks = []; options.changed() } }
  const observe = () => {
    const messages = store.projection().messages.filter((message) => message.role === 'assistant' && !observed.has(message.id))
    for (const message of messages) observed.add(message.id)
    const message = messages.findLast((message) => { const record = rows().find((row) => row.type === 'assistant/message' && row.id === message.id); return message.status === 'complete' && message.text.trim() && record?.type === 'assistant/message' && !record.toolCalls?.length && rows().some((row) => row.type === 'turn/end' && row.turnId === record.turnId && row.reason === 'completed') })
    if (!message || closed || !enabled || !port || options.blocked()) return
    stop(); if (worker) return // Never overlap requests, even when a provider ignores cancellation.
    const text = options.safeText(message.text); const attempts = rows().filter((row) => row.type === 'voice/attempt' && row.dayKey === calendarDay(clock))
    if (!text.trim() || text.length > 1200 || !options.budget && (attempts.length >= 30 || attempts.reduce((n, row) => n + (row.type === 'voice/attempt' ? row.charCount : 0), 0) + text.length > 12000)) { error = { code: 'quota-exhausted', retryable: false }; options.changed(); return }
    let resourceReservationId: string | undefined
    try { resourceReservationId = options.budget?.reserveSpeech(text.length) } catch (cause) { error = { code: cause instanceof ResourceFailure ? cause.code : 'unavailable', retryable: false }; options.changed(); return }
    const abort = new AbortController(); active = abort; chunks = []; error = undefined
    utterance = { id: randomUUID(), messageId: message.id, status: 'synthesizing', playback: 'idle', chunkCount: 0, byteLength: 0, createdAtMs: clock.nowMs() }; const id = utterance.id
    store.append({ type: 'voice/attempt', id, dayKey: calendarDay(clock), charCount: text.length, source: port.source, ...(resourceReservationId ? { resourceReservationId } : {}) })
    const timeout = clock.after(30_000, () => { abort.abort(); if (utterance?.id === id && utterance.status === 'synthesizing') { utterance.status = 'failed'; utterance.playback = 'ended'; chunks = []; error = { code: 'connection-failed', retryable: true }; options.changed() } })
    worker = port.synthesize(text, abort.signal, (data) => {
      abort.signal.throwIfAborted()
      if (closed || !enabled || options.blocked() || utterance?.id !== id || data.byteLength < 2 || data.byteLength > 16384 || data.byteLength % 2 || utterance.byteLength + data.byteLength > 1_440_000 || chunks.length >= 256) throw new Error('VOICE_UNAVAILABLE')
      chunks.push(Buffer.from(data)); utterance.chunkCount = chunks.length; utterance.byteLength += data.byteLength; options.changed()
    }).then(() => { abort.signal.throwIfAborted(); if (!chunks.length || options.blocked()) throw new Error('VOICE_UNAVAILABLE'); utterance!.status = 'ready' }, () => { throw new Error('VOICE_UNAVAILABLE') }).catch(() => {
      if (utterance?.id === id && utterance.status !== 'cancelled') { utterance.status = 'failed'; utterance.playback = 'ended'; chunks = []; error = { code: 'connection-failed', retryable: true } }
    }).finally(() => { timeout(); active = undefined; worker = undefined; options.changed() })
  }
  return {
    view: state, observe,
    stateChanged: () => { if (options.blocked()) stop() },
    interrupt: stop,
    read: (input: unknown): VoiceRead => {
      const { utteranceId, afterChunk } = z.strictObject({ utteranceId: z.string().uuid(), afterChunk: z.number().int().min(-1).max(255) }).parse(input)
      if (!enabled || options.blocked() || !utterance || utterance.id !== utteranceId || ['cancelled', 'failed'].includes(utterance.status) || afterChunk >= chunks.length) throw new Error('VOICE_UNAVAILABLE')
      const batch = chunks.slice(afterChunk + 1, afterChunk + 9)
      return { utteranceId, format: 'pcm_s16le', sampleRate: 24000, channels: 1, chunks: batch.map((pcm, index) => ({ index: afterChunk + index + 1, pcmBase64: pcm.toString('base64') })), done: utterance.status === 'ready' && afterChunk + batch.length === chunks.length - 1 }
    },
    dispatch: (command: AppCommand): PublicErrorCode | undefined => {
      if (closed) return 'unavailable'
      if (command.type === 'voice.set') { if (command.enabled && !port) return 'not-configured'; enabled = command.enabled; store.append({ type: 'voice/settings', enabled }); if (!enabled) stop(); options.changed(); return }
      if (!utterance || !('utteranceId' in command) || command.utteranceId !== utterance.id) return 'invalid-command'
      if (command.type === 'voice.stop') { stop(); return }
      if (command.type === 'voice.playback') {
        if (['cancelled', 'failed'].includes(utterance.status) || !enabled || options.blocked()) return 'unavailable'
        if (command.status === 'ended' && utterance.status !== 'ready' || command.status === 'playing' && !chunks.length) return 'invalid-command'
        utterance.playback = command.status; if (command.status === 'failed') stop(); options.changed(); return
      }
      return 'invalid-command'
    },
    close: async () => { closed = true; stop(); await worker },
    idle: async () => { await worker },
  }
}
export type VoiceService = ReturnType<typeof createVoice>
