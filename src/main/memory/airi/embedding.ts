// Host adaptation of AIRI local-memory-embedding.ts (MIT). Provider identity,
// supported dimensions and query/document roles retain the upstream contract.
import type { Clock } from '../../clock'
import type { MemoryEmbeddingRuntime } from './host-ports'
import type { MemoryEmbeddingMetadata, MemoryEmbeddingQueryMetadata } from './core'

export const MEMORY_EMBEDDING_SUPPORTED_DIMENSIONS = [768, 1024, 1536] as const
export interface MemoryEmbeddingSource {
  fingerprint: string
  provider: string
  model: string
  embed(text: string, kind?: 'query' | 'document'): Promise<number[]>
  getLastUsage?(): { promptTokens: number; totalTokens: number } | undefined
}

function validateVector(value: unknown): number[] {
  if (!Array.isArray(value) || !MEMORY_EMBEDDING_SUPPORTED_DIMENSIONS.includes(value.length as 768)
    || value.some(entry => typeof entry !== 'number' || !Number.isFinite(entry))) throw new Error('MEMORY_EMBEDDING_INVALID_VECTOR')
  return value as number[]
}

/** Credentials stay in this main-owned closure and never enter metadata or state. */
export function createApiMemoryEmbeddingSource(input: { baseUrl: string; apiKey: string; model: string; clock: Clock; fetch?: typeof fetch }): MemoryEmbeddingSource {
  const base = new URL(input.baseUrl.endsWith('/') ? input.baseUrl : input.baseUrl + '/')
  if (!['https:', 'http:'].includes(base.protocol) || base.username || base.password || !input.apiKey.trim() || !input.model.trim()) throw new Error('MEMORY_EMBEDDING_CONFIGURATION_REQUIRED')
  const endpoint = new URL('embeddings', base)
  const isVoyage = /(^|\.)voyageai\./i.test(base.hostname)
  let usage: { promptTokens: number; totalTokens: number } | undefined
  return {
    fingerprint: `api:${base.href}:${input.model}`,
    provider: isVoyage ? 'voyage' : 'openai-compatible',
    model: input.model,
    embed: async (text, kind = 'document') => {
      usage = undefined
      const controller = new AbortController()
      const cancel = input.clock.after(30_000, () => controller.abort())
      try {
        const response = await (input.fetch ?? fetch)(endpoint, {
          method: 'POST', headers: { Authorization: `Bearer ${input.apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: input.model, input: text, ...(isVoyage ? { input_type: kind } : {}) }), signal: controller.signal,
        })
        if (!response.ok || !response.body) throw new Error('MEMORY_EMBEDDING_REQUEST_FAILED')
        const reader = response.body.getReader()
        const chunks: Uint8Array[] = []
        let bytes = 0
        try {
          while (true) {
            const chunk = await reader.read()
            if (chunk.done) break
            bytes += chunk.value.length
            if (bytes > 2 * 1024 * 1024) { await reader.cancel(); throw new Error('MEMORY_EMBEDDING_RESPONSE_TOO_LARGE') }
            chunks.push(chunk.value)
          }
        } finally { reader.releaseLock() }
        const result = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { data?: { embedding?: unknown }[]; usage?: { prompt_tokens?: unknown; total_tokens?: unknown } }
        const vector = validateVector(result.data?.[0]?.embedding)
        const tokens = result.usage
        if (typeof tokens?.prompt_tokens === 'number' && Number.isFinite(tokens.prompt_tokens) && tokens.prompt_tokens >= 0
          && typeof tokens.total_tokens === 'number' && Number.isFinite(tokens.total_tokens) && tokens.total_tokens >= 0) {
          usage = { promptTokens: tokens.prompt_tokens, totalTokens: tokens.total_tokens }
        }
        return vector
      } catch { throw new Error('MEMORY_EMBEDDING_REQUEST_FAILED') }
      finally { cancel() }
    },
    getLastUsage: () => usage,
  }
}

/** An installation has one explicit source. Missing/broken configuration cannot
 * silently replace its vector space. A local source can use this same IO port. */
export function createMemoryEmbeddingRuntime(clock: Clock, configuredSource: () => MemoryEmbeddingSource | undefined): MemoryEmbeddingRuntime {
  let source: MemoryEmbeddingSource | undefined
  let generation = 0
  function metadata(input: { kind: 'document'; dimensions: number }): MemoryEmbeddingMetadata
  function metadata(input: { kind: 'query'; dimensions: number }): MemoryEmbeddingQueryMetadata
  function metadata(input: { kind: 'query' | 'document'; dimensions: number }): MemoryEmbeddingMetadata | MemoryEmbeddingQueryMetadata {
    if (!source) throw new Error('MEMORY_EMBEDDING_UNCONFIGURED')
    return { embeddingProvider: source.provider, embeddingModel: source.model, embeddingDimensions: input.dimensions, embeddingInputType: input.kind,
      embeddingSourceFingerprint: source.fingerprint, embeddedAt: clock.nowMs(), embeddingStatus: 'active' }
  }
  return {
    async configure() {
      const next = configuredSource()
      if (next !== source) { source = next; generation++ }
      return !!source
    },
    activeMemoryEmbeddingFingerprint: () => source?.fingerprint ?? '',
    activeMemoryEmbeddingMetadata: metadata,
    activeMemoryEmbeddingUsage: () => source?.getLastUsage?.(),
    async embedMemoryText(text, kind = 'document') {
      const active = source; const epoch = generation
      if (!active) throw new Error('MEMORY_EMBEDDING_UNCONFIGURED')
      const result = validateVector(await active.embed(text, kind))
      if (epoch !== generation) throw new Error('MEMORY_EMBEDDING_SOURCE_CHANGED')
      return result
    },
  }
}
