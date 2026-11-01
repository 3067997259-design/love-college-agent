import { describe, expect, it, vi } from 'vitest'
import { createManualClock } from '../../../src/main/clock'
import { createApiMemoryEmbeddingSource, createMemoryEmbeddingRuntime } from '../../../src/main/memory/airi/embedding'

describe('main-owned AIRI embeddings', () => {
  it('uses provider input roles, validates vectors and exposes measured usage without credentials', async () => {
    const request = vi.fn(async () => new Response(JSON.stringify({ data: [{ embedding: Array(1024).fill(0.5) }], usage: { prompt_tokens: 4, total_tokens: 4 } })))
    const clock = createManualClock(17)
    const source = createApiMemoryEmbeddingSource({ baseUrl: 'https://api.voyageai.com/v1', apiKey: 'synthetic-key', model: 'fixture', clock, fetch: request })
    const runtime = createMemoryEmbeddingRuntime(clock, () => source)
    await runtime.configure()
    expect(await runtime.embedMemoryText('query', 'query')).toHaveLength(1024)
    const args = request.mock.calls[0] as unknown as [URL, RequestInit]
    expect(JSON.parse(String(args[1].body))).toEqual({ model: 'fixture', input: 'query', input_type: 'query' })
    expect(runtime.activeMemoryEmbeddingUsage()).toEqual({ promptTokens: 4, totalTokens: 4 })
    expect(runtime.activeMemoryEmbeddingMetadata({ kind: 'document', dimensions: 1024 }).embeddedAt).toBe(17)
    expect(JSON.stringify(runtime.activeMemoryEmbeddingMetadata({ kind: 'query', dimensions: 1024 }))).not.toContain('synthetic-key')
  })

  it('rejects unsupported dimensions and discards results from a changed source', async () => {
    let release!: (value: number[]) => void
    const first = { fingerprint: 'first', provider: 'fixture', model: 'first', embed: () => new Promise<number[]>(resolve => { release = resolve }) }
    let source = first
    const runtime = createMemoryEmbeddingRuntime(createManualClock(), () => source)
    await runtime.configure()
    const result = runtime.embedMemoryText('fact')
    source = { ...first, fingerprint: 'second', model: 'second', embed: async () => [1, 2] }
    await runtime.configure(); release(Array(768).fill(0))
    await expect(result).rejects.toThrow('SOURCE_CHANGED')
    await expect(runtime.embedMemoryText('fact')).rejects.toThrow('INVALID_VECTOR')
  })

  it('leaves absent sources explicitly unconfigured', async () => {
    const runtime = createMemoryEmbeddingRuntime(createManualClock(), () => undefined)
    expect(await runtime.configure()).toBe(false)
    await expect(runtime.embedMemoryText('fact')).rejects.toThrow('UNCONFIGURED')
  })

  it('binds vectors to the full endpoint and model without persisting URL material', () => {
    const clock = createManualClock(), config = { baseUrl: 'https://fixture.invalid/private-path/v1', apiKey: 'test-key', model: 'model-one', clock }
    const first = createApiMemoryEmbeddingSource(config)
    expect(first.fingerprint).toMatch(/^api:[a-f0-9]{64}$/)
    expect(first.fingerprint).toBe(createApiMemoryEmbeddingSource({ ...config, baseUrl: config.baseUrl + '/' }).fingerprint)
    expect(first.fingerprint).not.toBe(createApiMemoryEmbeddingSource({ ...config, model: 'model-two' }).fingerprint)
    expect(first.fingerprint).not.toBe(createApiMemoryEmbeddingSource({ ...config, baseUrl: 'https://fixture.invalid/another/v1' }).fingerprint)
    expect(() => createApiMemoryEmbeddingSource({ ...config, baseUrl: config.baseUrl + '?api-key=hidden' })).toThrow('CONFIGURATION_REQUIRED')
    expect(() => createApiMemoryEmbeddingSource({ ...config, baseUrl: config.baseUrl + '#fragment' })).toThrow('CONFIGURATION_REQUIRED')
  })
})
