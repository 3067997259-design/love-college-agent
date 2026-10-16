import type { AppBridge, AppSnapshot } from '../../../shared'

/** A single book player. The main process controls which public message may be spoken. */
export function createVoicePlayer(bridge: AppBridge, makeAudio: () => AudioContext = () => new AudioContext()) {
  let snapshot: AppSnapshot | undefined; let audio: AudioContext | undefined; let id: string | undefined; let after = -1; let endAt = 0; let pumping = false; let closed = false; let started = false; let ended = false
  const nodes = new Set<AudioBufferSourceNode>()
  const stop = () => { id = undefined; for (const node of nodes) { node.onended = null; node.stop() }; nodes.clear(); after = -1; endAt = 0; started = false; ended = false }
  const report = async (utteranceId: string, status: 'playing' | 'ended' | 'failed') => { if (snapshot) await bridge.dispatch({ protocolVersion: 1, requestId: crypto.randomUUID(), epoch: snapshot.epoch, type: 'voice.playback', utteranceId, status }) }
  const finish = () => { const utterance = snapshot?.voice?.utterance; if (id && !ended && utterance?.id === id && utterance.status === 'ready' && after === utterance.chunkCount - 1 && !nodes.size) { ended = true; void report(id, 'ended').catch(() => {}) } }
  const pump = async () => {
    if (pumping || closed || !id || !bridge.readVoice) return
    pumping = true; const current = id
    try {
      audio ??= makeAudio(); await audio.resume()
      while (!closed && id === current && snapshot?.voice?.utterance?.id === current && after < snapshot.voice.utterance.chunkCount - 1) {
        const batch = await bridge.readVoice({ utteranceId: current, afterChunk: after })
        if (closed || id !== current) return
        if (batch.utteranceId !== current || batch.format !== 'pcm_s16le' || batch.sampleRate !== 24000 || batch.channels !== 1 || !batch.chunks.length || batch.chunks.length > 8) throw new Error('INVALID_AUDIO')
        for (const chunk of batch.chunks) {
          if (closed || id !== current) return
          const bytes = atob(chunk.pcmBase64); if (chunk.index !== after + 1 || bytes.length < 2 || bytes.length > 16384 || bytes.length % 2) throw new Error('INVALID_AUDIO')
          const buffer = audio.createBuffer(1, bytes.length / 2, 24000); const samples = buffer.getChannelData(0)
          for (let i = 0; i < samples.length; i++) { const value = bytes.charCodeAt(i * 2) | bytes.charCodeAt(i * 2 + 1) << 8; samples[i] = (value >= 32768 ? value - 65536 : value) / 32768 }
          const node = audio.createBufferSource(); node.buffer = buffer; node.connect(audio.destination); nodes.add(node)
          node.onended = () => { nodes.delete(node); if (!closed && id === current) finish() }
          endAt = Math.max(audio.currentTime + 0.02, endAt); node.start(endAt); endAt += buffer.duration; after = chunk.index
          if (!started) { started = true; await report(current, 'playing') }
        }
      }
      finish()
    } catch { if (!closed && id === current) { stop(); await report(current, 'failed').catch(() => {}) } }
    finally { pumping = false; if (!closed && id && id !== current) void pump() }
  }
  return {
    update: (next: AppSnapshot) => {
      snapshot = next; const voice = next.voice; const utterance = voice?.utterance
      if (!voice?.enabled || !utterance || !['synthesizing', 'ready'].includes(utterance.status) || ['ended', 'failed'].includes(utterance.playback) || id !== utterance.id && utterance.playback !== 'idle' || next.companion.lightsOut || next.companion.mode === 'quiet' || next.pomodoro.phase === 'focus' || next.heartFlow?.activeId || next.minecraft?.status === 'playing') { stop(); return }
      if (id !== utterance.id) { stop(); id = utterance.id }
      if (!ended) void pump()
    },
    close: () => { closed = true; stop(); void audio?.close().catch(() => {}) },
  }
}
