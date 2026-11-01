import type { ResolvedModelCapabilities } from '../../shared/model-capabilities'

const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), 'utf8')
const optionalLists = ['workCheckpoints', 'currentDecisions', 'memoryDirectory', 'memoryReference', 'earlierToday', 'previousDaysReference'] as const
export class ContextBudgetFailure extends Error { readonly code = 'context-too-large'; constructor() { super('CONTEXT_REFERENCE_BUDGET_EXCEEDED') } }

/** One budget for all producer projections. UTF-8 bytes are a conservative text
 * token estimate; DSH still owns actual tokenizer pressure and history compaction.
 * Current source restrictions/world state are indivisible. Optional facts are
 * whole references: truncating a negation or a revision would change its meaning. */
export function composeContext(input: {
  reference: Record<string, unknown>; capabilities?: ResolvedModelCapabilities
  systemText: string; tools: unknown; inputText: string; revealedText?: string
}) {
  const window = input.capabilities?.contextWindow ?? 32_768
  const output = input.capabilities?.maxOutputTokens ?? Math.min(4096, Math.floor(window / 4))
  const historyReserve = Math.floor(window / 2)
  const overhead = Buffer.byteLength(input.systemText + input.inputText, 'utf8') + bytes(input.tools) + 1024
  const budget = Math.max(0, Math.min(32_000, window - output - historyReserve - overhead))
  const result: Record<string, unknown> = Object.fromEntries(Object.entries(input.reference).filter(([key]) => !optionalLists.includes(key as typeof optionalLists[number])))
  const suffix = input.revealedText ? '\n\n' + input.revealedText : ''
  const length = () => bytes(result) + Buffer.byteLength(suffix, 'utf8')
  if (length() > budget) throw new ContextBudgetFailure()
  let omitted = 0
  for (const key of optionalLists) {
    const values = input.reference[key]
    if (!Array.isArray(values) || !values.length) continue
    const selected: unknown[] = []
    result[key] = selected
    // Reserve room to say that omission occurred; never imply full coverage.
    for (const value of values) {
      selected.push(value)
      if (length() + 96 > budget) { selected.pop(); omitted++ }
    }
    if (!selected.length) delete result[key]
  }
  if (omitted && length() + 96 <= budget) result.contextCoverage = { omittedReferences: omitted, fullHistory: false }
  return { reference: result, text: JSON.stringify(result) + suffix, budget, bytes: length(), omitted,
    capacitySource: input.capabilities?.contextWindow ? 'adapter' as const : 'conservative-default' as const }
}
