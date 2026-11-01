import type { MemoryEmbeddingInputType, MemoryEmbeddingMetadata, MemoryEmbeddingQueryMetadata } from '@proj-airi/memory-core'

import embedWorkerURL from '@xsai-transformers/embed/worker?worker&url'

import { createEmbedProvider } from '@xsai-transformers/embed'
import { embed } from '@xsai/embed'

/** Vector dimensions the memory stores can hold; anything else is rejected. */
export const MEMORY_EMBEDDING_SUPPORTED_DIMENSIONS = [768, 1024, 1536] as const

/** Whether a vector's dimension can be stored and mirrored at all. */
export function isSupportedMemoryVectorLength(length: number): boolean {
  return (MEMORY_EMBEDDING_SUPPORTED_DIMENSIONS as readonly number[]).includes(length)
}

export type MemoryEmbeddingKind = 'query' | 'document'

/** Provider-reported input usage for one embedding request. */
export interface MemoryEmbeddingUsage {
  promptTokens: number
  totalTokens: number
}

export interface MemoryEmbeddingSource {
  /**
   * Embeds one text into the source's vector space. `kind` marks retrieval
   * probes versus stored content for models whose API distinguishes them
   * (e.g. Voyage `input_type`); local models ignore it.
   */
  embed: (text: string, kind?: MemoryEmbeddingKind) => Promise<number[]>
  /** Returns usage from the most recent request, when the provider reported it. */
  getLastUsage?: () => MemoryEmbeddingUsage | undefined
  /**
   * Identifies the vector space. Stored vectors produced under a different
   * fingerprint are meaningless and must be re-embedded before recall.
   */
  fingerprint: string
  provider: string
  model: string
}

const localProvider = createEmbedProvider({ baseURL: `xsai-transformers:///?worker-url=${embedWorkerURL}` })
let localModelLoadPromise: Promise<void> | undefined

let installedSource: MemoryEmbeddingSource | undefined

/**
 * Installs the active embedding backend (an OpenAI-compatible endpoint
 * configured in the memory settings). The local worker stays the fallback so
 * the service keeps working without any configuration.
 */
export function installMemoryEmbeddingSource(source: MemoryEmbeddingSource | undefined): void {
  installedSource = source
}

/** Returns the fingerprint of the vector space new embeddings are produced in. */
export function activeMemoryEmbeddingFingerprint(): string {
  return installedSource?.fingerprint ?? `local:Xenova/nomic-embed-text-v1`
}

/** Returns provider usage for the most recent active-source request, if any. */
export function activeMemoryEmbeddingUsage(): MemoryEmbeddingUsage | undefined {
  return installedSource?.getLastUsage?.()
}

/** Returns metadata for a newly created vector without exposing credentials. */
export function activeMemoryEmbeddingMetadata(input: { kind: 'query', dimensions: number, embeddedAt?: number }): MemoryEmbeddingQueryMetadata
export function activeMemoryEmbeddingMetadata(input: { kind: 'document', dimensions: number, embeddedAt?: number }): MemoryEmbeddingMetadata
export function activeMemoryEmbeddingMetadata(input: { kind: MemoryEmbeddingInputType, dimensions: number, embeddedAt?: number }): MemoryEmbeddingMetadata | MemoryEmbeddingQueryMetadata {
  const source = installedSource
  return {
    embeddingProvider: source?.provider ?? 'local',
    embeddingModel: source?.model ?? 'Xenova/nomic-embed-text-v1',
    embeddingDimensions: input.dimensions,
    embeddingInputType: input.kind,
    embeddingSourceFingerprint: activeMemoryEmbeddingFingerprint(),
    embeddedAt: input.embeddedAt ?? Date.now(),
    embeddingStatus: 'active',
  }
}

/** Creates a memory embedding with the configured source, or the local worker. */
export async function embedMemoryText(text: string, kind?: MemoryEmbeddingKind): Promise<number[]> {
  if (installedSource)
    return installedSource.embed(text, kind)

  localModelLoadPromise ??= localProvider.loadEmbed('Xenova/nomic-embed-text-v1')
  await localModelLoadPromise

  const result = await embed({
    ...localProvider.embed('Xenova/nomic-embed-text-v1'),
    input: text,
  })
  return result.embedding
}

/**
 * Builds an OpenAI-compatible API embedding source.
 *
 * Voyage models are detected by the endpoint host and switch to their native
 * contract: no `dimensions` argument (the API rejects it; the model returns
 * its own fixed dimension) plus `input_type` on every call, which is
 * required for Voyage retrieval quality. Vector length is validated against
 * the supported store dimensions, so a model whose dimension the store
 * cannot hold fails fast instead of silently corrupting rows.
 */
export function createApiMemoryEmbeddingSource(input: { baseUrl: string, apiKey: string, model: string }): MemoryEmbeddingSource {
  // NOTICE: host-based vendor detection keeps the memory settings UI free of
  // vendor toggles; revisit if a second vendor with the same quirks appears.
  const isVoyage = /voyageai\./i.test(input.baseUrl)
  let lastUsage: MemoryEmbeddingUsage | undefined
  return {
    fingerprint: `api:${input.baseUrl}:${input.model}`,
    provider: isVoyage ? 'voyage' : 'openai-compatible',
    model: input.model,
    embed: async (text, kind) => {
      const result = await embed({
        baseURL: input.baseUrl,
        apiKey: input.apiKey,
        model: input.model,
        input: text,
        ...(isVoyage ? { input_type: kind === 'query' ? 'query' : 'document' } : {}),
      })
      lastUsage = Number.isFinite(result.usage.prompt_tokens) && Number.isFinite(result.usage.total_tokens)
        ? { promptTokens: result.usage.prompt_tokens, totalTokens: result.usage.total_tokens }
        : undefined
      const vector = result.embedding
      if (!(MEMORY_EMBEDDING_SUPPORTED_DIMENSIONS as readonly number[]).includes(vector.length))
        throw new Error(`Embedding model returned ${vector.length} dimensions; the store supports ${MEMORY_EMBEDDING_SUPPORTED_DIMENSIONS.join('/')}`)
      return vector
    },
    getLastUsage: () => lastUsage,
  }
}
