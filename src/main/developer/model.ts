import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { Clock } from '../clock'
import { ModelFailure, type ModelClient, type ModelReply } from '../model/types'
import fixture from './responses.json'

export const scriptSchema = z.array(z.strictObject({ text: z.string().max(20_000), delayMs: z.number().int().min(0).max(60_000).default(0),
  toolCalls: z.array(z.strictObject({ id: z.string().min(1).max(128), name: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/), arguments: z.string().max(64_000) })).max(16) })).max(32)
export type ModelScript = z.infer<typeof scriptSchema>

export function createScriptedModel(clock: Clock) {
  let script: ModelScript = []; let index = 0
  const model: ModelClient = { source: 'fake', complete: async (request, report): Promise<ModelReply> => {
    request.signal.throwIfAborted()
    report({ slot: 'chat', attempt: 1, status: 'started', waitMs: 0 })
    const step = script[index++] ?? fixture.default
    if (step.delayMs > 0) await new Promise<void>((resolve, reject) => {
      const aborted = () => { cancel(); reject(new ModelFailure('cancelled')) }
      const cancel = clock.after(step.delayMs, () => { request.signal.removeEventListener('abort', aborted); resolve() })
      request.signal.addEventListener('abort', aborted, { once: true })
      if (request.signal.aborted) aborted()
    })
    request.signal.throwIfAborted()
    report({ slot: 'chat', attempt: 1, status: 'success', waitMs: 0, inputTokens: 0, outputTokens: 0 })
    return { text: step.text, toolCalls: step.toolCalls.map((call) => ({ ...call, id: randomUUID() })), usage: { inputTokens: 0, outputTokens: 0 } }
  } }
  return { model, set: (input: unknown) => { script = scriptSchema.parse(input); index = 0 }, read: () => structuredClone(script), position: () => index }
}
