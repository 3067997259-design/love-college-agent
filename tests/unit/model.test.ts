import { describe, expect, it, vi } from 'vitest'
import { createManualClock } from '../../src/main/clock'
import { createModelClient } from '../../src/main/model/client'
import type { ModelAttempt, ModelRequest } from '../../src/main/model/types'
import type { ProviderConfig, ProviderSlot } from '../../src/main/config/providers'

const config: ProviderConfig = { base_url: 'https://synthetic.invalid/v1', api_key: 'synthetic-private-key', model: 'synthetic-config-model' }
const configs = new Map<ProviderSlot, ProviderConfig>([['chat', config], ['chat_google', { ...config, base_url: 'https://backup.invalid/v1' }]])
const request = (signal = new AbortController().signal): ModelRequest => ({ messages: [{ role: 'user', content: 'synthetic input' }], tools: [], signal, toolsExecuted: false })
const frame = (delta: unknown, finish_reason: string | null = null) => `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason }] })}\r\n\r\n`
const usageFrame = (usage: unknown) => `data: ${JSON.stringify({ choices: [], usage })}\r\n\r\n`
function stream(text = 'test reply') { return new Response(frame({ content: text, reasoning_content: 'must not surface' }, 'stop') + 'data: [DONE]\n\n') }

describe('private compatible model client', () => {
  it('keeps game JPEG resolution separate from desk PNG authority', async () => {
    const jpeg = Buffer.from('ffd8ffe000040000ffc0000808000c001003ffd9', 'hex'); const ref = 'game-frame:' + 'b'.repeat(64)
    const game: ModelRequest = { ...request(), messages: [{ role: 'tool', content: 'bounded game metadata', toolCallId: 'shot', imageRefs: [ref] }] }
    const fetcher = vi.fn(async () => stream()); const resolve = vi.fn(() => jpeg)
    await createModelClient(configs, ['chat'], createManualClock(), fetcher, { scope: 'game', resolve }).complete(game, () => {})
    const messages = JSON.parse((fetcher.mock.calls[0] as unknown as [string, RequestInit])[1].body as string).messages
    expect(messages[1].content[1].image_url.url).toBe('data:image/jpeg;base64,' + jpeg.toString('base64'))
    expect(messages[1].content[0].text).toContain('Minecraft')
    const denied = vi.fn(); await expect(createModelClient(configs, ['chat'], createManualClock(), denied, { resolve }).complete(game, () => {})).rejects.toMatchObject({ kind: 'configuration' })
    const work = { ...game, messages: [{ ...game.messages[0], imageRefs: ['work-frame:' + 'a'.repeat(64)] }] }
    await expect(createModelClient(configs, ['chat'], createManualClock(), denied, { scope: 'game', resolve }).complete(work, () => {})).rejects.toMatchObject({ kind: 'configuration' }); expect(denied).not.toHaveBeenCalled()
  })
  it('attaches only bounded owned work images after an entire tool batch, never unresolved files/URLs', async () => {
    const png = Buffer.alloc(33); Buffer.from('89504e470d0a1a0a', 'hex').copy(png); png.writeUInt32BE(800, 16); png.writeUInt32BE(600, 20)
    const ref = 'work-frame:' + 'a'.repeat(64); const fetcher = vi.fn(async () => stream()); const resolve = vi.fn(() => png)
    const work: ModelRequest = { ...request(), messages: [{ role: 'assistant', content: '', toolCalls: [{ id: 'first', name: 'observe', arguments: '{}' }, { id: 'second', name: 'read', arguments: '{}' }] }, { role: 'tool', content: 'untrusted frame metadata', toolCallId: 'first', imageRefs: [ref] }, { role: 'tool', content: 'untrusted second tool data', toolCallId: 'second' }] }
    await createModelClient(configs, ['chat'], createManualClock(), fetcher, { resolve }).complete(work, () => {})
    const messages = JSON.parse((fetcher.mock.calls[0] as unknown as [string, RequestInit])[1].body as string).messages
    expect(messages.map((message: { role: string }) => message.role)).toEqual(['assistant', 'tool', 'tool', 'user']); expect(messages[3].content[1]).toEqual({ type: 'image_url', image_url: { url: 'data:image/png;base64,' + png.toString('base64'), detail: 'low' } }); expect(resolve).toHaveBeenCalledWith(ref)
    const denied = vi.fn(); await expect(createModelClient(configs, ['chat'], createManualClock(), denied).complete(work, () => {})).rejects.toMatchObject({ kind: 'configuration' }); expect(denied).not.toHaveBeenCalled()
  })
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
  it('records DeepSeek prompt cache hit and miss tokens on the reply and attempt', async () => {
    // 250 is deliberately not 1000 - 700, so removing the miss parser and falling back to derivation would fail.
    const fetcher = vi.fn(async () => new Response(frame({ content: 'cached reply' }, 'stop')
      + usageFrame({ prompt_tokens: 1000, completion_tokens: 12, prompt_cache_hit_tokens: 700, prompt_cache_miss_tokens: 250 }) + 'data: [DONE]\n\n'))
    const attempts: ModelAttempt[] = []
    const reply = await createModelClient(configs, ['chat'], createManualClock(), fetcher).complete(request(), (attempt) => attempts.push(attempt))
    expect(reply.usage).toEqual({ inputTokens: 1000, outputTokens: 12, cachedInputTokens: 700, uncachedInputTokens: 250 })
    expect(attempts.find((attempt) => attempt.status === 'success')).toMatchObject({ inputTokens: 1000, outputTokens: 12, cachedInputTokens: 700, uncachedInputTokens: 250 })
  })
  it('keeps a cache observation when a later usage frame only repeats totals', async () => {
    const fetcher = vi.fn(async () => new Response(frame({ content: 'split usage' }, 'stop')
      + usageFrame({ prompt_tokens: 1000, completion_tokens: 12, prompt_cache_hit_tokens: 768 })
      + usageFrame({ prompt_tokens: 1000, completion_tokens: 12 }) + 'data: [DONE]\n\n'))
    const attempts: ModelAttempt[] = []
    const reply = await createModelClient(configs, ['chat'], createManualClock(), fetcher).complete(request(), (attempt) => attempts.push(attempt))
    expect(reply.usage).toEqual({ inputTokens: 1000, outputTokens: 12, cachedInputTokens: 768, uncachedInputTokens: 232 })
    expect(attempts.find((attempt) => attempt.status === 'success')).toMatchObject({ cachedInputTokens: 768, uncachedInputTokens: 232 })
  })
  it('derives uncached input from OpenAI-compatible prompt_tokens_details.cached_tokens', async () => {
    const fetcher = vi.fn(async () => new Response(frame({ content: 'cached reply' }, 'stop')
      + usageFrame({ prompt_tokens: 1000, completion_tokens: 12, prompt_tokens_details: { cached_tokens: 768 } }) + 'data: [DONE]\n\n'))
    const attempts: ModelAttempt[] = []
    const reply = await createModelClient(configs, ['chat'], createManualClock(), fetcher).complete(request(), (attempt) => attempts.push(attempt))
    expect(reply.usage).toEqual({ inputTokens: 1000, outputTokens: 12, cachedInputTokens: 768, uncachedInputTokens: 232 })
    expect(attempts.find((attempt) => attempt.status === 'success')).toMatchObject({ inputTokens: 1000, outputTokens: 12, cachedInputTokens: 768, uncachedInputTokens: 232 })
  })
  it('keeps cache fields absent when the provider reports none', async () => {
    const fetcher = vi.fn(async () => new Response(frame({ content: 'no cache detail' }, 'stop')
      + usageFrame({ prompt_tokens: 30, completion_tokens: 3 }) + 'data: [DONE]\n\n'))
    const attempts: ModelAttempt[] = []
    const reply = await createModelClient(configs, ['chat'], createManualClock(), fetcher).complete(request(), (attempt) => attempts.push(attempt))
    const success = attempts.find((attempt) => attempt.status === 'success')
    expect(reply.usage).toStrictEqual({ inputTokens: 30, outputTokens: 3 })
    expect(success).toMatchObject({ inputTokens: 30, outputTokens: 3 })
    // Object.entries also catches own keys written with an undefined value; the contract is "not reported at all".
    expect(Object.entries(success ?? {}).filter(([key]) => /cached/i.test(key))).toEqual([])
  })
  it('keeps a reported zero cache hit distinct from a missing field', async () => {
    const fetcher = vi.fn(async () => new Response(frame({ content: 'no cache hit' }, 'stop')
      + usageFrame({ prompt_tokens: 30, completion_tokens: 3, prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 30 }) + 'data: [DONE]\n\n'))
    const attempts: ModelAttempt[] = []
    const reply = await createModelClient(configs, ['chat'], createManualClock(), fetcher).complete(request(), (attempt) => attempts.push(attempt))
    expect(reply.usage).toEqual({ inputTokens: 30, outputTokens: 3, cachedInputTokens: 0, uncachedInputTokens: 30 })
    expect(attempts.find((attempt) => attempt.status === 'success')).toMatchObject({ cachedInputTokens: 0, uncachedInputTokens: 30 })
  })
  it('ignores malformed cache observations without failing the reply', async () => {
    const fetcher = vi.fn(async () => new Response(frame({ content: 'malformed cache' }, 'stop')
      + usageFrame({ prompt_tokens: 1000, completion_tokens: 12, prompt_cache_hit_tokens: -5, prompt_tokens_details: 'unexpected' }) + 'data: [DONE]\n\n'))
    const attempts: ModelAttempt[] = []
    const reply = await createModelClient(configs, ['chat'], createManualClock(), fetcher).complete(request(), (attempt) => attempts.push(attempt))
    expect(reply.text).toBe('malformed cache')
    expect(reply.usage).toStrictEqual({ inputTokens: 1000, outputTokens: 12 })
    expect(Object.entries(attempts.find((attempt) => attempt.status === 'success') ?? {}).filter(([key]) => /cached/i.test(key))).toEqual([])
  })
  it('drops cache observations that contradict the prompt token count', async () => {
    const fetcher = vi.fn(async () => new Response(frame({ content: 'inconsistent cache' }, 'stop')
      + usageFrame({ prompt_tokens: 10, completion_tokens: 1, prompt_cache_hit_tokens: 12 }) + 'data: [DONE]\n\n'))
    const reply = await createModelClient(configs, ['chat'], createManualClock(), fetcher).complete(request(), () => {})
    expect(reply.usage).toStrictEqual({ inputTokens: 10, outputTokens: 1 })
  })
  it('derives the cached side when only the miss count is reported', async () => {
    const fetcher = vi.fn(async () => new Response(frame({ content: 'miss only' }, 'stop')
      + usageFrame({ prompt_tokens: 1000, completion_tokens: 5, prompt_cache_miss_tokens: 200 }) + 'data: [DONE]\n\n'))
    const reply = await createModelClient(configs, ['chat'], createManualClock(), fetcher).complete(request(), () => {})
    expect(reply.usage).toEqual({ inputTokens: 1000, outputTokens: 5, cachedInputTokens: 800, uncachedInputTokens: 200 })
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
