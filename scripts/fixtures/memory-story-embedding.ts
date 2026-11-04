import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import type { Clock } from '../../src/main/clock'
import { createApiMemoryEmbeddingSource } from '../../src/main/memory/airi/embedding'
import { observeProbeTransport } from './probe-transport'

/** Diagnostic codes only: no exception messages, URL, headers or body. */
export function probeErrorCodes(error: unknown): string[] {
  const codes: string[] = []
  for (let current = error, depth = 0; current && typeof current === 'object' && depth < 4; depth++) {
    const { code, cause } = current as { code?: unknown; cause?: unknown }
    if (typeof code === 'string' && /^[A-Z][A-Z0-9_]{1,63}$/.test(code)) codes.push(code)
    current = cause
  }
  return [...new Set(codes)]
}

/** Same production adapter; completions belong to their own requests, not samples.at(-1). */
export function createStoryEmbeddingProbe(input: {
  config: { baseUrl: string; apiKey: string; model: string }; clock: Clock; selfTest: boolean
  samples: Record<string, unknown>[]; story(): string; ready(): boolean
  admit(ticket: string, text: string): void; sent(): void; save(): void; fail(code: string): void
  fetch?: typeof fetch
}) {
  const metadata = createApiMemoryEmbeddingSource({ ...input.config, clock: input.clock })
  const pending = new Map<Promise<number[]>, Record<string, unknown>>()
  const drain = { pendingAtClose: 0, settledWithoutRetry: true }
  let lastUsage: ReturnType<NonNullable<typeof metadata.getLastUsage>>
  const source = { ...metadata, getLastUsage: () => lastUsage, embed: (text: string, kind: 'document' | 'query' = 'document') => {
    assert.ok(input.ready(), 'BATCH_HALTED')
    const began = input.clock.nowMs()
    const sample: Record<string, unknown> = { story: input.story(), kind: 'embedding', inputType: kind, characters: text.length,
      ok: false, status: null, headersMs: null, vectorReadyMs: null, elapsedMs: null }
    input.samples.push(sample)
    let phase = 'VECTOR_ADMISSION_FAILED', observer: ReturnType<typeof observeProbeTransport> | undefined
    const adapter = createApiMemoryEmbeddingSource({ ...input.config, clock: input.clock, fetch: async (url, init) => {
      try {
        if (!input.selfTest) { observer = observeProbeTransport(String(url), input.clock.nowMs); sample.transport = observer.diagnostics; input.sent() }
        const response = input.selfTest
          ? new Response(JSON.stringify({ data: [{ embedding: Array.from({ length: 1024 }, (_, i) => i === 0 ? 1 : 0) }] }))
          : await (input.fetch ?? fetch)(url, { ...init, redirect: 'error' })
        sample.status = response.status; sample.headersMs = input.clock.nowMs() - began
        phase = response.ok ? 'VECTOR_PROTOCOL_FAILED' : 'VECTOR_HTTP_FAILED'
        assert.ok(response.ok, 'VECTOR_HTTP_FAILED'); return response
      } catch (error) { sample.errorCodes = probeErrorCodes(error); throw error }
      finally { input.save() }
    } })
    const request = (async () => {
      try {
        input.admit(randomUUID(), text); phase = 'VECTOR_TRANSPORT_FAILED'; input.save()
        const vector = await adapter.embed(text, kind)
        sample.ok = true; sample.vectorReadyMs = input.clock.nowMs() - began; lastUsage = adapter.getLastUsage?.()
        return vector
      } catch (error) {
        sample.error = phase; sample.errorCodes ??= probeErrorCodes(error); input.fail(phase); throw new Error(phase, { cause: error })
      } finally { observer?.close(); sample.elapsedMs = input.clock.nowMs() - began; input.save() }
    })()
    pending.set(request, sample)
    void request.then(() => pending.delete(request), () => pending.delete(request))
    return request
  } }
  return { source, state: () => ({ inFlight: pending.size, drain }),
    admitModel(runtimeFailure: string | null = null) {
      // Work delivery may assemble a second reference while the user model starts.
      // In-flight is not failure: only the production runtime can declare its recall expired.
      if (runtimeFailure) { input.fail(runtimeFailure); return false }
      return input.ready()
    },
    pendingSnapshot: () => structuredClone([...pending.values()]),
    async close() {
      // Drain issued requests under the original 30s adapter timeout; never send or retry.
      if (pending.size) {
        let cancel = () => {}
        try { await Promise.race([Promise.allSettled([...pending.keys()]), new Promise<void>(resolve => { cancel = input.clock.after(31_000, resolve) })]) }
        finally { cancel() }
      }
      drain.pendingAtClose = pending.size; drain.settledWithoutRetry = pending.size === 0; input.save()
    },
  }
}
