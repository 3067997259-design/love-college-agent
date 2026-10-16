import type { Clock } from '../clock'
import { readModelProviders } from '../config/providers'
import { createModelClient } from '../model/client'
import { ModelFailure } from '../model/types'

export async function probeModel(filename: string, clock: Clock) {
  const providers = await readModelProviders(filename)
  if (!providers.has('chat')) return { ok: false, probe: 'model', error: 'NOT_CONFIGURED' }
  const abort = new AbortController()
  const stop = clock.after(20_000, () => abort.abort())
  try {
    const reply = await createModelClient(providers, ['chat'], clock).complete({
      messages: [{ role: 'user', content: 'Reply with OK only.' }], tools: [], signal: abort.signal, toolsExecuted: false, maxOutputTokens: 16,
    }, () => {})
    return { ok: Boolean(reply.text), probe: 'model', streamed: true, textPresent: Boolean(reply.text), toolCalls: reply.toolCalls.length }
  } catch (error) { return { ok: false, probe: 'model', error: 'MODEL_PROBE_FAILED', reason: error instanceof ModelFailure ? error.kind : 'unknown' } }
  finally { stop() }
}
