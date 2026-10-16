import { z } from 'zod'
import type { Clock } from '../clock'
import { redactFixed } from '../privacy/redact'
import type { SeenFragment } from './seen'
import { memoryDigest, userOrigins } from './seen'
import { groundedIn } from './grounding'
import type { MemoryEntry, MemorySource } from './schema'
import fixtures from './fixtures.json'

export interface MemoryModel { source: 'real' | 'fake'; extract(input: readonly SeenFragment[], signal: AbortSignal): Promise<unknown>; summarize(input: readonly SeenFragment[], signal: AbortSignal): Promise<unknown> }
export class MemoryFailure extends Error { constructor(readonly code: 'memory-invalid-output' | 'not-configured' | 'connection-failed' | 'budget-exceeded' | 'unavailable' | 'context-too-large') { super('MEMORY_OPERATION_FAILED') } }
export async function boundedMemoryCall(model: MemoryModel | null, kind: 'extract' | 'summarize', input: readonly SeenFragment[], clock: Clock, signal: AbortSignal) {
  if (!model) throw new MemoryFailure('not-configured')
  const abort = new AbortController(); const combined = AbortSignal.any([abort.signal, signal]); const cancel = clock.after(30_000, () => abort.abort()); let remove = () => {}
  try {
    const stopped = new Promise<never>((_resolve, reject) => { const listener = () => reject(new MemoryFailure(signal.aborted ? 'unavailable' : 'connection-failed')); combined.addEventListener('abort', listener, { once: true }); remove = () => combined.removeEventListener('abort', listener); if (combined.aborted) listener() })
    return await Promise.race([model[kind](input, combined), stopped])
  } catch (cause) { if (cause instanceof MemoryFailure) throw cause; throw new MemoryFailure('connection-failed') }
  finally { cancel(); remove() }
}
const short = z.string().min(1).max(240).refine((text) => redactFixed(text) === text && [...text].every((char) => char.charCodeAt(0) > 31 && char.charCodeAt(0) !== 127))
const extraction = z.strictObject({ items: z.array(z.strictObject({ sourceId: z.string().max(128), quote: short, kind: z.enum(['fact', 'experience']), topic: z.string().min(1).max(20), replaceTopic: z.boolean() })).max(20) })
export const sourceRef = ({ id, sessionId, frameSeq, index, offset, atMs }: MemorySource): MemorySource => ({ id, sessionId, frameSeq, index, offset, atMs })
export function validateMemories(output: unknown, input: readonly SeenFragment[], owner: { userId: string; characterId: string }, existing: readonly (MemoryEntry & { supersededBy?: string })[]): MemoryEntry[] {
  try {
    const result: MemoryEntry[] = []
    const ordered = extraction.parse(output).items.sort((a, b) => input.findIndex((source) => source.id === a.sourceId) - input.findIndex((source) => source.id === b.sourceId) || (input.find((source) => source.id === a.sourceId)?.text.indexOf(a.quote) ?? 0) - (input.find((source) => source.id === b.sourceId)?.text.indexOf(b.quote) ?? 0))
    for (const item of ordered) {
      const fragment = input.find((source) => source.id === item.sourceId)
      if (!fragment || !fragment.text.includes(item.quote) || !item.quote.includes(item.topic)) throw new Error('MEMORY_UNGROUNDED')
      // A substring is not an entailment: reject quotes whose negation or scope was left outside the span.
      if (!groundedIn(fragment.source ?? fragment.text, item.quote).entailed) throw new Error('MEMORY_UNGROUNDED')
      const id = 'mem:' + memoryDigest(JSON.stringify([owner.userId, owner.characterId, item.kind, item.quote]))
      const supersedes = item.replaceTopic ? [...existing, ...result].filter((old) => old.id !== id && !('supersededBy' in old && old.supersededBy) && !result.some((entry) => entry.supersedes.includes(old.id)) && old.kind === 'fact' && old.topic === item.topic && old.text.includes(item.topic)
        && old.sources.every((source) => source.atMs < fragment.atMs || source.atMs === fragment.atMs && (source.sessionId !== fragment.sessionId || source.frameSeq < fragment.frameSeq || source.frameSeq === fragment.frameSeq && source.index <= fragment.index))).map((old) => old.id) : []
      if (item.replaceTopic && (fragment.role !== 'user' || !userOrigins(fragment.origin) || item.kind !== 'fact' || !/改为|改成|更正|不再/.test(item.quote))) throw new Error('MEMORY_CORRECTION_UNGROUNDED')
      const duplicate = result.find((entry) => entry.id === id)
      if (duplicate) duplicate.sources.push(sourceRef(fragment))
      else result.push({ id, text: item.quote, kind: item.kind, topic: item.topic, sources: [sourceRef(fragment)], supersedes })
    }
    return result
  } catch { throw new MemoryFailure('memory-invalid-output') }
}
export function validateSummary(output: unknown, input: readonly SeenFragment[]) {
  try {
    const parsed = z.strictObject({ lines: z.array(z.strictObject({ sourceId: z.string().max(128), quote: short })).min(1).max(16) }).parse(output)
    const sources: MemorySource[] = []; const text: string[] = []
    for (const line of parsed.lines) {
      const source = input.find((entry) => entry.id === line.sourceId)
      if (!source || !source.text.includes(line.quote)) throw new Error('SUMMARY_UNGROUNDED')
      sources.push(sourceRef(source)); text.push(line.quote)
    }
    return { text: [...new Set(text)].join('\n'), sources }
  } catch { throw new MemoryFailure('memory-invalid-output') }
}
export function createFakeMemoryModel() {
  let scenario: 'ready' | 'failure' | 'invalid' = 'ready'
  const check = (signal: AbortSignal) => { signal.throwIfAborted(); if (scenario === 'failure') throw new Error('SYNTHETIC_BACKGROUND_FAILED') }
  const model: MemoryModel = { source: 'fake', extract: async (input, signal) => {
    check(signal); if (scenario === 'invalid') return { items: [{ sourceId: 'invented', quote: 'invented', kind: 'fact', topic: 'invented', replaceTopic: false }] }
    return { items: input.filter((source) => source.role === 'user').flatMap((source) => fixtures.items.filter((item) => source.text.includes(item.quote)).map((item) => ({ ...item, sourceId: source.id }))).slice(0, 20) }
  }, summarize: async (input, signal) => {
    check(signal); if (scenario === 'invalid') return { lines: [{ sourceId: 'invented', quote: 'invented' }] }
    return { lines: input.filter((source) => source.role !== 'tool' && source.text.trim()).slice(-12).map((source) => ({ sourceId: source.id, quote: source.text.split(/\r?\n/).find((line) => line.trim())!.slice(0, 240) })) }
  } }
  return { model, scenario: () => scenario, select: (value: typeof scenario) => { scenario = value } }
}
