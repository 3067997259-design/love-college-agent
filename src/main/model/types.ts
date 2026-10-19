import type { ContextMessage } from '../journal/schema'
import type { ProviderSlot } from '../config/providers'

export type ModelFailureKind = 'configuration' | 'network' | 'timeout' | 'upstream' | 'quota' | 'cancelled' | 'invalid-output' | 'interrupted' | 'content-filtered'
export class ModelFailure extends Error {
  constructor(readonly kind: ModelFailureKind, readonly partialText = '', readonly httpStatus?: number, readonly retryAfterMs?: number) {
    super('MODEL_REQUEST_FAILED')
  }
}
export interface ModelTool { name: string; description: string; parameters: Record<string, unknown> }
/** Cache fields stay absent when the provider did not report them, so a reported zero remains distinguishable. */
export interface ModelUsage {
  inputTokens: number
  outputTokens: number
  cachedInputTokens?: number
  uncachedInputTokens?: number
}
export interface ModelReply {
  text: string
  toolCalls: { id: string; name: string; arguments: string }[]
  usage: ModelUsage
}
export interface ModelRequest {
  messages: readonly ContextMessage[]
  tools: readonly ModelTool[]
  signal: AbortSignal
  toolsExecuted: boolean
  maxOutputTokens?: number
}
export interface ModelAttempt {
  slot: ProviderSlot; attempt: number; status: 'started' | 'success' | 'failed' | 'retry'; waitMs: number
  httpStatus?: number; error?: ModelFailureKind; inputTokens?: number; outputTokens?: number
  cachedInputTokens?: number; uncachedInputTokens?: number
}
export interface ModelClient {
  readonly source: 'real' | 'fake'
  complete(request: ModelRequest, onAttempt: (attempt: ModelAttempt) => void): Promise<ModelReply>
}
