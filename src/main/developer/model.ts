import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { Clock } from '../clock'
import { ModelFailure, type ModelClient, type ModelReply } from '../model/types'
import fixture from './responses.json'

/** One model call each. `httpStatus`: the call fails with that status instead of replying (failure notes in a scene). */
export const scriptSchema = z.array(z.strictObject({ text: z.string().max(20_000), delayMs: z.number().int().min(0).max(60_000).default(0),
  toolCalls: z.array(z.strictObject({ id: z.string().min(1).max(128), name: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/), arguments: z.string().max(64_000) })).max(16),
  httpStatus: z.number().int().min(400).max(599).optional() })).max(32)
export type ModelScript = z.infer<typeof scriptSchema>
export type ScriptStep = ModelScript[number]

/** Waits `delayMs` on the (developer) clock; an abort rejects as a cancelled model call. */
export function scriptDelay(clock: Clock, delayMs: number, signal: AbortSignal) {
  if (delayMs <= 0) return Promise.resolve()
  return new Promise<void>((resolve, reject) => {
    const aborted = () => { cancel(); reject(new ModelFailure('cancelled')) }
    const cancel = clock.after(delayMs, () => { signal.removeEventListener('abort', aborted); resolve() })
    signal.addEventListener('abort', aborted, { once: true })
    if (signal.aborted) aborted()
  })
}

/**
 * Zero-token replies for developer scenes, one step per model call: her DSH turns read them through the local endpoint
 * (endpoint.ts), a game round through `model`. Past the end of the script every call gets the fixture reply.
 */
export function createScriptedModel(clock: Clock) {
  let script: ModelScript = []; let index = 0
  const next = (): ScriptStep => script[index++] ?? fixture.default
  const model: ModelClient = { source: 'fake', complete: async (request, report): Promise<ModelReply> => {
    request.signal.throwIfAborted()
    report({ slot: 'chat', attempt: 1, status: 'started', waitMs: 0 })
    const step = next()
    await scriptDelay(clock, step.delayMs, request.signal)
    request.signal.throwIfAborted()
    if (step.httpStatus) throw new ModelFailure(step.httpStatus >= 500 || step.httpStatus === 429 ? 'upstream' : 'configuration', '', step.httpStatus)
    report({ slot: 'chat', attempt: 1, status: 'success', waitMs: 0, inputTokens: 0, outputTokens: 0 })
    return { text: step.text, toolCalls: step.toolCalls.map((call) => ({ ...call, id: randomUUID() })), usage: { inputTokens: 0, outputTokens: 0 } }
  } }
  return { model, next, set: (input: unknown) => { script = scriptSchema.parse(input); index = 0 }, read: () => structuredClone(script), position: () => index }
}
export type ScriptedModel = ReturnType<typeof createScriptedModel>
