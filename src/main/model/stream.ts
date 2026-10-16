import { z } from 'zod'
import { ModelFailure, type ModelReply } from './types'

const chunkSchema = z.object({
  choices: z.array(z.object({ index: z.number().int(), finish_reason: z.string().nullable().optional(), delta: z.object({
    content: z.string().nullable().optional(), refusal: z.string().nullable().optional(),
    tool_calls: z.array(z.object({ index: z.number().int().min(0).max(15), id: z.string().optional(), type: z.string().optional(),
      function: z.object({ name: z.string().optional(), arguments: z.string().optional() }).optional() })).optional(),
  }) })),
  usage: z.object({ prompt_tokens: z.number().int().nonnegative(), completion_tokens: z.number().int().nonnegative() }).nullable().optional(),
})

/** Only content/refusal and function deltas are consumed; reasoning/metadata are ignored. */
export async function readCompletionStream(response: Response, signal: AbortSignal, onBytes: () => void, redact: (text: string) => string): Promise<ModelReply> {
  if (!response.body) throw new ModelFailure('invalid-output')
  const reader = response.body.getReader()
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let buffer = ''; let text = ''; let totalBytes = 0; let finished = false
  let usage = { inputTokens: 0, outputTokens: 0 }
  const calls = new Map<number, { id: string; name: string; arguments: string }>()
  const visible = () => /<\/?(?:think|thinking|analysis|reasoning)\b|^(?:analysis|reasoning|思考过程|推理过程)\s*[:：]/im.test(text) ? '' : redact(text)
  const frame = (value: string) => {
    const data = value.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n')
    if (!data || data === '[DONE]') return
    let chunk: z.infer<typeof chunkSchema>
    try { chunk = chunkSchema.parse(JSON.parse(data)) } catch { throw new ModelFailure('invalid-output') }
    if (chunk.usage) usage = { inputTokens: chunk.usage.prompt_tokens, outputTokens: chunk.usage.completion_tokens }
    for (const choice of chunk.choices) {
      if (choice.index !== 0) continue
      text += choice.delta.content ?? choice.delta.refusal ?? ''
      if (text.length > 200_000) throw new ModelFailure('invalid-output')
      for (const delta of choice.delta.tool_calls ?? []) {
        const call = calls.get(delta.index) ?? { id: '', name: '', arguments: '' }
        if (delta.id) call.id = delta.id
        if (delta.function?.name) call.name += delta.function.name
        call.arguments += delta.function?.arguments ?? ''
        if (call.arguments.length > 64_000 || call.name.length > 64 || call.id.length > 128) throw new ModelFailure('invalid-output')
        calls.set(delta.index, call)
      }
      if (choice.finish_reason === 'stop' || choice.finish_reason === 'tool_calls') finished = true
      else if (choice.finish_reason) throw new ModelFailure('interrupted', visible())
    }
  }
  const abortRead = () => { void reader.cancel().catch(() => {}) }
  signal.addEventListener('abort', abortRead, { once: true })
  try {
    while (true) {
      if (signal.aborted) throw new ModelFailure('cancelled', visible())
      const { value, done } = await reader.read()
      if (done) break
      onBytes()
      totalBytes += value.byteLength
      if (totalBytes > 2 * 1024 * 1024) throw new ModelFailure('invalid-output')
      buffer += decoder.decode(value, { stream: true })
      let match: RegExpExecArray | null
      while ((match = /\r?\n\r?\n/.exec(buffer))) {
        frame(buffer.slice(0, match.index))
        buffer = buffer.slice(match.index + match[0].length)
      }
    }
    if (signal.aborted) throw new ModelFailure('cancelled', visible())
    buffer += decoder.decode()
    if (buffer.trim()) frame(buffer)
    if (!finished) throw new ModelFailure(text ? 'interrupted' : 'network', visible())
    const toolCalls = [...calls.entries()].sort((a, b) => a[0] - b[0]).map(([, call]) => ({ id: redact(call.id), name: redact(call.name), arguments: redact(call.arguments) }))
    if (toolCalls.some((call) => !call.id || !/^[a-zA-Z0-9_-]{1,64}$/.test(call.name)) || new Set(toolCalls.map((call) => call.id)).size !== toolCalls.length) throw new ModelFailure('invalid-output')
    // Inline reasoning tags must never reach a user-facing message or tool loop.
    if (text && !visible()) throw new ModelFailure('invalid-output')
    return { text: redact(text), toolCalls, usage }
  } catch (error) {
    if (error instanceof ModelFailure) throw error
    throw new ModelFailure(text ? 'interrupted' : 'network', visible())
  } finally { signal.removeEventListener('abort', abortRead); await reader.cancel().catch(() => {}); reader.releaseLock() }
}
