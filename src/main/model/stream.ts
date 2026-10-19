import { z } from 'zod'
import { ModelFailure, type ModelReply, type ModelUsage } from './types'

// Cache fields are pure observations: a malformed value must not fail an otherwise valid reply, so it is treated as unreported.
const cacheCount = z.number().int().nonnegative().nullable().optional().catch(undefined)
const chunkSchema = z.object({
  choices: z.array(z.object({ index: z.number().int(), finish_reason: z.string().nullable().optional(), delta: z.object({
    content: z.string().nullable().optional(), refusal: z.string().nullable().optional(),
    tool_calls: z.array(z.object({ index: z.number().int().min(0).max(15), id: z.string().optional(), type: z.string().optional(),
      function: z.object({ name: z.string().optional(), arguments: z.string().optional() }).optional() })).optional(),
  }) })),
  // DeepSeek reports prompt_cache_hit_tokens/prompt_cache_miss_tokens; OpenAI-compatible usage reports cached_tokens only.
  usage: z.object({ prompt_tokens: z.number().int().nonnegative(), completion_tokens: z.number().int().nonnegative(),
    prompt_cache_hit_tokens: cacheCount,
    prompt_cache_miss_tokens: cacheCount,
    prompt_tokens_details: z.object({ cached_tokens: cacheCount }).nullable().optional().catch(undefined),
  }).nullable().optional(),
})

/** Only content/refusal and function deltas are consumed; reasoning/metadata are ignored. */
export async function readCompletionStream(response: Response, signal: AbortSignal, onBytes: () => void, redact: (text: string) => string): Promise<ModelReply> {
  if (!response.body) throw new ModelFailure('invalid-output')
  const reader = response.body.getReader()
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let buffer = ''; let text = ''; let totalBytes = 0; let finished = false
  let usage: ModelUsage = { inputTokens: 0, outputTokens: 0 }
  const calls = new Map<number, { id: string; name: string; arguments: string }>()
  const visible = () => /<\/?(?:think|thinking|analysis|reasoning)\b|^(?:analysis|reasoning|思考过程|推理过程)\s*[:：]/im.test(text) ? '' : redact(text)
  // The latest usage frame wins for totals; a cache observation survives a later frame that omits it.
  // Observations that contradict prompt_tokens are treated as unreported, and the missing side of a
  // reported hit/miss pair is derived so the recorded pair stays consistent with the prompt count.
  const applyUsage = (next: NonNullable<z.infer<typeof chunkSchema>['usage']>) => {
    const prompt = next.prompt_tokens
    const reportedHit = next.prompt_cache_hit_tokens ?? next.prompt_tokens_details?.cached_tokens ?? undefined
    const reportedMiss = next.prompt_cache_miss_tokens ?? undefined
    const earlierHit = usage.cachedInputTokens !== undefined && usage.cachedInputTokens <= prompt ? usage.cachedInputTokens : undefined
    const earlierMiss = usage.uncachedInputTokens !== undefined && usage.uncachedInputTokens <= prompt ? usage.uncachedInputTokens : undefined
    const cached = reportedHit !== undefined ? (reportedHit <= prompt ? reportedHit : earlierHit)
      : earlierHit ?? (reportedMiss !== undefined && reportedMiss <= prompt ? prompt - reportedMiss : undefined)
    const miss = reportedMiss !== undefined && reportedMiss <= prompt ? reportedMiss : (cached === undefined ? earlierMiss : prompt - cached)
    usage = { inputTokens: prompt, outputTokens: next.completion_tokens,
      ...(cached === undefined ? {} : { cachedInputTokens: cached }),
      ...(miss === undefined ? {} : { uncachedInputTokens: miss }) }
  }
  const frame = (value: string) => {
    const data = value.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n')
    if (!data || data === '[DONE]') return
    let chunk: z.infer<typeof chunkSchema>
    try { chunk = chunkSchema.parse(JSON.parse(data)) } catch { throw new ModelFailure('invalid-output') }
    if (chunk.usage) applyUsage(chunk.usage)
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
      else if (choice.finish_reason === 'content_filter') throw new ModelFailure('content-filtered', visible())
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
    // Arguments are JSON encoded inside SSE JSON. Decode individual string tokens before redacting
    // so Unicode/slash escapes cannot carry a private provider value into parsed tool arguments.
    const cleanArguments = (value: string) => redact(value.replace(/"(?:[^"\\]|\\.)*"/g, (token) => { try { return JSON.stringify(redact(JSON.parse(token))) } catch { return redact(token) } }))
    const toolCalls = [...calls.entries()].sort((a, b) => a[0] - b[0]).map(([, call]) => ({ id: redact(call.id), name: redact(call.name), arguments: cleanArguments(call.arguments) }))
    if (toolCalls.some((call) => !call.id || !/^[a-zA-Z0-9_-]{1,64}$/.test(call.name)) || new Set(toolCalls.map((call) => call.id)).size !== toolCalls.length) throw new ModelFailure('invalid-output')
    // Inline reasoning tags must never reach a user-facing message or tool loop.
    if (text && !visible()) throw new ModelFailure('invalid-output')
    return { text: redact(text), toolCalls, usage }
  } catch (error) {
    if (error instanceof ModelFailure) throw error
    throw new ModelFailure(text ? 'interrupted' : 'network', visible())
  } finally { signal.removeEventListener('abort', abortRead); await reader.cancel().catch(() => {}); reader.releaseLock() }
}
