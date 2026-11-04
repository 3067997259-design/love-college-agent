import { expect, it } from 'vitest'
import { createManualClock } from '../../src/main/clock'
import { createStoryEmbeddingProbe, probeErrorCodes } from '../../scripts/fixtures/memory-story-embedding'
import { retrievalRuntimeFailure } from '../../scripts/fixtures/memory-retrieval-diagnostics'

const vectorBody = JSON.stringify({ data: [{ embedding: Array.from({ length: 1024 }, (_, i) => i === 0 ? 1 : 0) }] })
function barrier<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
function setup(fetch: typeof globalThis.fetch, admit?: () => void) {
  const clock = createManualClock(), samples: Record<string, unknown>[] = [], failures: string[] = []
  let requests = 0, halted = false
  const probe = createStoryEmbeddingProbe({ config: { baseUrl: 'https://api.voyageai.com/v1', apiKey: 'never-log-key', model: 'voyage-4-large' },
    clock, samples, selfTest: false, story: () => 'S23', ready: () => !halted, admit: () => admit?.(),
    sent: () => { requests++ }, save: () => {}, fail: code => { halted = true; failures.push(code) }, fetch })
  return { probe, clock, samples, failures, requests: () => requests }
}

it('keeps a late vector on its own sample and denies a runtime-confirmed expired recall', async () => {
  const entered = barrier<void>(), release = barrier<Response>()
  const h = setup(async () => { entered.resolve(); return release.promise })
  const request = h.probe.source.embed('synthetic-query', 'query'); await entered.promise
  h.clock.advanceBy(3000)
  const expired = retrievalRuntimeFailure(true, 'Memory embedding exceeded 3000 ms; directory remains available')
  expect(h.probe.admitModel(expired?.code)).toBe(false)
  expect(h.failures).toEqual(['EMBEDDING_INTERACTION_DEADLINE_EXCEEDED'])
  const atFailure = h.probe.pendingSnapshot()
  const unrelated = { kind: 'model', ok: false, elapsedMs: 42 }; h.samples.push(unrelated)
  const close = h.probe.close(); release.resolve(new Response(vectorBody)); await request; await close
  expect(h.samples[0]).toMatchObject({ ok: true, elapsedMs: 3000, vectorReadyMs: 3000 })
  expect(unrelated).toEqual({ kind: 'model', ok: false, elapsedMs: 42 })
  expect(atFailure[0]).toMatchObject({ ok: false, elapsedMs: null })
  expect(h.probe.admitModel()).toBe(false)
  expect(() => h.probe.source.embed('no-retry')).toThrow('BATCH_HALTED')
  expect(h.requests()).toBe(1)
  expect(h.probe.state()).toEqual({ inFlight: 0, drain: { pendingAtClose: 0, settledWithoutRetry: true } })
})

it('preserves a sanitized transport cause without leaking the exception text', async () => {
  const h = setup(async () => { throw new TypeError('never-log-key https://private.example/body', { cause: { code: 'ECONNRESET', message: 'never-log-body' } }) })
  await expect(h.probe.source.embed('private text')).rejects.toThrow('VECTOR_TRANSPORT_FAILED')
  await h.probe.close()
  expect(h.samples[0]).toMatchObject({ ok: false, status: null, errorCodes: ['ECONNRESET'] })
  expect(JSON.stringify(h.samples)).not.toMatch(/never-log|private\.example|private text/)
  expect(h.probe.admitModel()).toBe(false)
  expect(h.requests()).toBe(1)
})

it('separates HTTP, vector protocol, and local quota failures without retries', async () => {
  for (const [response, code] of [[() => new Response('', { status: 503 }), 'VECTOR_HTTP_FAILED'],
    [() => new Response('{"data":[{"embedding":[1]}]}'), 'VECTOR_PROTOCOL_FAILED']] as const) {
    const h = setup(async () => response())
    await expect(h.probe.source.embed('query')).rejects.toThrow(code); await h.probe.close()
    expect(h.failures).toEqual([code]); expect(h.requests()).toBe(1); expect(h.probe.admitModel()).toBe(false)
  }
  const h = setup(async () => { throw Error('must never fetch') }, () => { throw Error('quota') })
  await expect(h.probe.source.embed('query')).rejects.toThrow('VECTOR_ADMISSION_FAILED'); await h.probe.close()
  expect(h.requests()).toBe(0); expect(h.failures).toEqual(['VECTOR_ADMISSION_FAILED'])
})

it('waits for the production transport timeout only and does not manufacture a late success', async () => {
  const entered = barrier<void>()
  const h = setup(async (_url, init) => { entered.resolve(); return new Promise((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })
  }) })
  const request = h.probe.source.embed('query'), rejected = expect(request).rejects.toThrow('VECTOR_TRANSPORT_FAILED')
  await entered.promise; h.clock.advanceBy(3000); expect(h.probe.admitModel('EMBEDDING_INTERACTION_DEADLINE_EXCEEDED')).toBe(false)
  const close = h.probe.close(); h.clock.advanceBy(27000); await rejected; await close
  expect(h.samples[0]).toMatchObject({ ok: false, elapsedMs: 30000, vectorReadyMs: null })
  expect(h.requests()).toBe(1); expect(h.probe.state().inFlight).toBe(0)
})

it('allows the unchanged successful path and bounds sanitized error traversal', async () => {
  const h = setup(async () => new Response(vectorBody))
  expect((await h.probe.source.embed('query')).length).toBe(1024)
  expect(h.probe.admitModel()).toBe(true); expect(h.failures).toEqual([]); await h.probe.close()
  const cyclic: { code: string; cause?: unknown } = { code: 'ECONNRESET' }; cyclic.cause = cyclic
  expect(probeErrorCodes(cyclic)).toEqual(['ECONNRESET'])
  expect(probeErrorCodes({ code: 'private-token/123', cause: { code: 'UND_ERR_CONNECT_TIMEOUT' } })).toEqual(['UND_ERR_CONNECT_TIMEOUT'])
})

it('allows a user model while a checkpoint reference is still reading a healthy vector', async () => {
  const entered = barrier<void>(), release = barrier<Response>()
  const h = setup(async () => { entered.resolve(); return release.promise })
  const checkpoint = h.probe.source.embed('checkpoint recall', 'query'); await entered.promise
  const model = { kind: 'model', ok: true, elapsedMs: 12 }; h.samples.push(model)
  h.clock.advanceBy(100)
  expect(h.probe.state().inFlight).toBe(1)
  expect(h.probe.admitModel(retrievalRuntimeFailure(true, undefined)?.code)).toBe(true)
  h.clock.advanceBy(247); release.resolve(new Response(vectorBody)); await checkpoint; await h.probe.close()
  expect(h.failures).toEqual([]); expect(h.requests()).toBe(1)
  expect(h.samples[0]).toMatchObject({ ok: true, elapsedMs: 347 }); expect(model.elapsedMs).toBe(12)
})

it('blocks real runtime failures even after all vector requests have settled', async () => {
  const h = setup(async () => new Response(vectorBody)); await h.probe.source.embed('query')
  expect(h.probe.state().inFlight).toBe(0)
  expect(h.probe.admitModel(retrievalRuntimeFailure(false, undefined)?.code)).toBe(false)
  expect(h.failures).toEqual(['RETRIEVAL_DATABASE_UNAVAILABLE']); await h.probe.close()
})

it('still stops the window if an overlapping reference later fails', async () => {
  let reject!: (reason: unknown) => void
  const entered = barrier<void>()
  const h = setup(async () => { entered.resolve(); return new Promise<Response>((_resolve, fail) => { reject = fail }) })
  const request = h.probe.source.embed('checkpoint recall'), rejected = expect(request).rejects.toThrow('VECTOR_TRANSPORT_FAILED')
  await entered.promise; expect(h.probe.admitModel()).toBe(true)
  const settled = h.probe.close()
  reject(new TypeError('synthetic only', {cause:{code:'ECONNRESET'}})); await rejected; await settled
  expect(h.failures).toEqual(['VECTOR_TRANSPORT_FAILED']); expect(h.probe.admitModel()).toBe(false)
  expect(h.probe.state().inFlight).toBe(0); expect(h.requests()).toBe(1)
})
