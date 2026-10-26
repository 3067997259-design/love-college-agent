import { expect, it, vi } from 'vitest'
import { createManualClock } from '../../src/main/clock'
import { createModelClient } from '../../src/main/model/client'
import { ModelFailure, type ModelRequest } from '../../src/main/model/types'

const key = 'sk-synthetic-diagnostic-key'
const config = { base_url: 'https://api.example.invalid/v1', api_key: key, model: 'demo-model' }
const request = (attempts?: number): ModelRequest => ({ messages: [{ role: 'user', content: 'Reply with OK only.' }], tools: [], signal: new AbortController().signal, toolsExecuted: false, ...(attempts ? { attempts } : {}) })
const failureOf = async (promise: Promise<unknown>) => { try { await promise } catch (error) { return error as ModelFailure } throw new Error('expected a failure') }

it('keeps the provider words of an HTTP failure for the connection test, without the key', async () => {
  const fetcher = vi.fn(async () => new Response(JSON.stringify({ error: { message: `Incorrect API key provided: ${key}.`, type: 'invalid_request_error', code: 'invalid_api_key' } }), { status: 401, headers: { 'Content-Type': 'application/json' } }))
  const failure = await failureOf(createModelClient(new Map([['chat', config]]), ['chat'], createManualClock(), fetcher).complete(request(1), () => {}))
  expect(failure).toBeInstanceOf(ModelFailure)
  expect(failure.kind).toBe('configuration'); expect(failure.httpStatus).toBe(401)
  expect(failure.diagnostic).toMatchObject({ code: 'invalid_api_key', message: 'Incorrect API key provided: [密钥已遮盖].' })
  expect(failure.diagnostic?.body).toContain('invalid_api_key')
  expect(JSON.stringify(failure.diagnostic)).not.toContain(key)
  // The model name stays: it is what the user needs to correct.
  const missing = vi.fn(async () => new Response(JSON.stringify({ error: { message: 'The model `demo-model` does not exist' } }), { status: 404 }))
  expect((await failureOf(createModelClient(new Map([['chat', config]]), ['chat'], createManualClock(), missing).complete(request(1), () => {}))).diagnostic?.message).toContain('demo-model')
})

it('names the socket error behind a failed fetch', async () => {
  const fetcher = vi.fn(async () => { throw Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('getaddrinfo ENOTFOUND api.example.invalid'), { code: 'ENOTFOUND' }) }) })
  const failure = await failureOf(createModelClient(new Map([['chat', config]]), ['chat'], createManualClock(), fetcher).complete(request(1), () => {}))
  expect(failure.kind).toBe('network')
  expect(failure.diagnostic).toEqual({ code: 'ENOTFOUND', message: 'getaddrinfo ENOTFOUND api.example.invalid' })
  expect(fetcher).toHaveBeenCalledTimes(1)
})

it('reports a web page answered with 200 as a wrong address, not a model reply', async () => {
  const fetcher = vi.fn(async () => new Response('<!doctype html><title>Welcome</title>', { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } }))
  const failure = await failureOf(createModelClient(new Map([['chat', config]]), ['chat'], createManualClock(), fetcher).complete(request(1), () => {}))
  expect(failure.kind).toBe('invalid-output')
  expect(failure.diagnostic?.body).toContain('<title>Welcome</title>')
})

it('a connection test makes one attempt; ordinary calls still retry', async () => {
  const busy = () => vi.fn(async () => new Response('busy', { status: 500 }))
  const once = busy()
  await failureOf(createModelClient(new Map([['chat', config]]), ['chat'], createManualClock(), once).complete(request(1), () => {}))
  expect(once).toHaveBeenCalledTimes(1)
  const clock = createManualClock(); const retried = busy()
  const pending = failureOf(createModelClient(new Map([['chat', config]]), ['chat'], clock, retried).complete(request(), () => {}))
  for (let i = 0; i < 10 && retried.mock.calls.length < 4; i++) { await new Promise((done) => setTimeout(done, 0)); clock.advanceBy(10_000) }
  await pending
  expect(retried.mock.calls.length).toBeGreaterThan(1)
})
