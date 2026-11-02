export function summarizeProbeResponse(text: string, key = '', endpoint = '') {
  const safe = (value: unknown) => typeof value === 'string' ? (key ? value.replaceAll(key, '[redacted]') : value).replaceAll(endpoint || '\0', '[endpoint]').slice(0, 240) : null
  const numeric = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? value : null
  let parsed: Record<string, unknown> | undefined
  try { parsed = JSON.parse(text) } catch { /* SSE and non-JSON responses are distinguished below. */ }
  let content = '', choices = 0, toolCalls = 0, finish: unknown, usage: Record<string, unknown> = {}, done = false, validEvents = 0
  const read = (value: Record<string, unknown>, streaming: boolean) => {
    if (value.usage && typeof value.usage === 'object') usage = value.usage as Record<string, unknown>
    if (!Array.isArray(value.choices)) return
    choices = Math.max(choices, value.choices.length)
    for (const choice of value.choices) {
      const message = streaming ? choice.delta : choice.message
      if (typeof message?.content === 'string') content += message.content
      if (Array.isArray(message?.tool_calls)) toolCalls += message.tool_calls.filter((call: { function?: { name?: string } }) => call.function?.name).length
      if (choice.finish_reason != null) finish = choice.finish_reason
    }
  }
  if (parsed) read(parsed, false)
  else for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith('data:')) continue
    const data = line.slice(5).trim()
    if (data === '[DONE]') { done = true; continue }
    try { read(JSON.parse(data), true); validEvents++ } catch { /* Invalid events cannot prove a completion. */ }
  }
  const error = parsed?.error && typeof parsed.error === 'object' ? parsed.error as Record<string, unknown> : undefined
  return { bytes: Buffer.byteLength(text), json: !!parsed, sseEvents: validEvents, sentinel: done, choices, contentCharacters: content.length, toolCalls, replyExactlyOK: content.trim() === 'OK', finishReason: safe(finish), complete: !error && choices > 0 && (parsed ? !!content || toolCalls > 0 : (done || finish != null) && (!!content || toolCalls > 0)), error: error ? { type: safe(error.type), code: safe(error.code), message: safe(error.message) } : null, usage: { inputTokens: numeric(usage.prompt_tokens), outputTokens: numeric(usage.completion_tokens), totalTokens: numeric(usage.total_tokens) } }
}
