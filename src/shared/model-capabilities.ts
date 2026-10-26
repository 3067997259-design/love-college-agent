import type { ReasoningEffort } from './state'

/** Optional overrides, never a claim that a supplier has been probed. Null off omits the wire parameter. */
export interface ManualModelCapabilities {
  contextWindow?: number
  maxOutputTokens?: number
  inputModalities?: readonly ('text' | 'image')[]
  reasoning?: false | Partial<Record<ReasoningEffort, string | null>>
}
/** Detached metadata from the selected DSH adapter; may include runtime defaults. */
export interface ResolvedModelCapabilities {
  contextWindow?: number
  maxOutputTokens?: number
  inputModalities?: readonly ('text' | 'image')[]
  reasoningLevels?: readonly ReasoningEffort[]
}
export interface ModelCapabilityView {
  editable: boolean
  declared?: ManualModelCapabilities
  resolved?: ResolvedModelCapabilities
}
