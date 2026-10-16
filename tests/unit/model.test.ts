import { describe, expect, it, vi } from 'vitest'
import { createManualClock } from '../../src/main/clock'
import { createModelClient } from '../../src/main/model/client'
import type { ModelAttempt, ModelRequest } from '../../src/main/model/types'
import type { ProviderConfig, ProviderSlot } from '../../src/main/config/providers'

const config: ProviderConfig = { base_url: 'https://synthetic.invalid/v1', api_key: 'synthetic-private-key', model: 'synthetic-config-model' }
const configs = new Map<ProviderSlot, ProviderConfig>([['chat', config], ['chat_google', { ...config, base_url: 'https://backup.invalid/v1' }]])
const request = (signal = new AbortController().signal): ModelRequest => ({ messages: [{ role: 'user', content: 'synthetic input' }], tools: [], signal, toolsExecuted: false })
const frame = (delta: unknown, finish_reason: string | null = null) => `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason }] })}\r\n\r\n`
function stream(text = 'test reply') { return new Response(frame({ content: text, reasoning_content: 'must not surface' }, 'stop') + 'data: [DONE]\n\n') }

describe('private compatible model client', () => {
  it('rejects a budget reservation before any actual request', async () => {
    const fetcher = vi.fn()
    await expect(createModelClient(configs, ['chat'], createManualClock(), fetcher).complete(request(), () => { throw new Error('synthetic reservation denied') })).rejects.toThrow('synthetic reservation denied')
    expect(fetcher).not.toHaveBeenCalled()
  })
  it('assembles split UTF-8/SSE/function deltas and excludes metadata/config values', async () => {
    const payload = frame({ content: '你好 synthetic-private-key synthetic-config-model https://synthetic.invalid/v1', reasoning_content: 'private reasoning' })
      + frame({ tool_calls: [{ index: 0, id: 'c1', function: { name: 'get_', arguments: '{"n":' } }] })
      + frame({ tool_calls: [{ index: 0, function: { name: 'timer', arguments: '1}' } }] }, 'tool_calls')
      + 'data: {"choices":[],"usage":{"prompt_tokens":4,"completion_tokens":8}}\n\n'
    const bytes = new TextEncoder().encode(payload)
    const fetcher = vi.fn(async (_url: string, init: RequestInit) => {
      expect((init.headers as Record<string, string>).Authorization).toBe('Bearer synthetic-private-key')
      expect(JSON.parse(init.body as string).model).toBe('synthetic-config-model')
      return new Response(new ReadableStream({ start(controller) { for (let offset = 0; offset < bytes.length; offset += 3) controller.enqueue(bytes.slice(offset, offset + 3)); controller.close() } }))
    })
    const attempts: ModelAttempt[] = []
    const reply = await createModelClient(configs, ['chat'], createManualClock(), fetcher).complete(request(), (attempt) => attempts.push(attempt))
    expect(reply.text).toBe('你好 [redacted] [redacted] [redacted]')
    expect(reply.toolCalls).toEqual([{ id: 'c1', name: 'get_timer', arguments: '{"n":1}' }])
    expect(reply.usage).toEqual({ inputTokens: 4, outputTokens: 8 })
    expect(JSON.stringify(attempts)).not.toMatch(/synthetic-private|synthetic-config|https:/)
  })
  it('rereads Retry-After for each 429 and uses injected time', async () => {
    const clock = createManualClock()
    const fetcher = vi.fn().mockResolvedValueOnce(new Response('', { status: 429, headers: { 'retry-after': '2' } }))
      .mockResolvedValueOnce(new Response('', { status: 429, headers: { 'retry-after': '3' } })).mockResolvedValueOnce(stream())
    const attempts: ModelAttempt[] = []
    const pending = createModelClient(configs, ['chat'], clock, fetcher).complete(request(), (attempt) => attempts.push(attempt))
    await vi.waitFor(() => expect(attempts.filter((attempt) => attempt.status === 'retry')).toHaveLength(1))
    clock.advanceBy(2000)
    await vi.waitFor(() => expect(attempts.filter((attempt) => attempt.status === 'retry')).toHaveLength(2))
    clock.advanceBy(3000)
    expect((await pending).text).toBe('test reply')
    expect(attempts.filter((attempt) => attempt.status === 'retry').map((attempt) => attempt.waitMs)).toEqual([2000, 3000])
  })
  it('switches configured chat slots after two 503s, but privacy never falls back', async () => {
    const clock = createManualClock()
    const fetcher = vi.fn().mockResolvedValueOnce(new Response('', { status: 503 })).mockResolvedValueOnce(new Response('', { status: 503 })).mockResolvedValueOnce(stream())
    const attempts: ModelAttempt[] = []
    const pending = createModelClient(configs, ['chat', 'chat_google'], clock, fetcher).complete(request(), (attempt) => attempts.push(attempt))
    await vi.waitFor(() => expect(attempts.some((attempt) => attempt.status === 'retry')).toBe(true))
    clock.advanceBy(1000)
    await pending
    expect(attempts.filter((attempt) => attempt.status === 'started').map((attempt) => attempt.slot)).toEqual(['chat', 'chat', 'chat_google'])
    const privacyFetch = vi.fn()
    await expect(createModelClient(configs, ['privacy', 'chat'], clock, privacyFetch).complete(request(), () => {})).rejects.toMatchObject({ kind: 'configuration' })
    expect(privacyFetch).not.toHaveBeenCalled()
  })
  it('does not retry configuration/quota failures, and cancellation aborts a retry wait', async () => {
    const clock = createManualClock()
    const badConfig = vi.fn(async () => new Response('synthetic-private-key invalid key', { status: 401 }))
    await expect(createModelClient(configs, ['chat'], clock, badConfig).complete(request(), () => {})).rejects.toMatchObject({ kind: 'configuration', message: 'MODEL_REQUEST_FAILED' })
    expect(badConfig).toHaveBeenCalledTimes(1)
    const quota = vi.fn(async () => new Response('insufficient balance synthetic-private-key', { status: 429 }))
    await expect(createModelClient(configs, ['chat', 'chat_google'], clock, quota).complete(request(), () => {})).rejects.toMatchObject({ kind: 'quota' })
    expect(quota).toHaveBeenCalledTimes(1)
    const abort = new AbortController()
    const pending = createModelClient(configs, ['chat'], clock, async () => new Response('', { status: 500 })).complete(request(abort.signal), (attempt) => { if (attempt.status === 'retry') abort.abort() })
    await expect(pending).rejects.toMatchObject({ kind: 'cancelled' })
  })
  it('keeps a partial reply on disconnect, blocks reasoning tags, and never replays after tools', async () => {
    const clock = createManualClock()
    const fetcher = vi.fn(async () => new Response(frame({ content: 'partial synthetic-private-key' })))
    await expect(createModelClient(configs, ['chat', 'chat_google'], clock, fetcher).complete({ ...request(), toolsExecuted: true }, () => {}))
      .rejects.toMatchObject({ kind: 'interrupted', partialText: 'partial [redacted]' })
    expect(fetcher).toHaveBeenCalledTimes(1)
    await expect(createModelClient(configs, ['chat'], clock, async () => stream('<think>not public</think>answer')).complete(request(), () => {})).rejects.toMatchObject({ kind: 'invalid-output', partialText: '' })
  })
  it('times out an idle request through the unified clock and releases cancellation', async () => {
    const clock = createManualClock()
    const abort = new AbortController()
    const fetcher = vi.fn((_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => init.signal?.addEventListener('abort', () => reject(new Error('synthetic private failure')), { once: true })))
    const attempts: ModelAttempt[] = []
    const pending = createModelClient(configs, ['chat'], clock, fetcher).complete({ ...request(abort.signal), toolsExecuted: true }, (attempt) => attempts.push(attempt))
    const checked = expect(pending).rejects.toMatchObject({ kind: 'timeout' })
    clock.advanceBy(30_000)
    await checked
    expect(attempts.at(-1)?.error).toBe('timeout')
    expect(fetcher).toHaveBeenCalledTimes(1)
  })
})
