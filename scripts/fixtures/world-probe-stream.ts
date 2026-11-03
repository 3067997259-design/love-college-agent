/** Compatible SDK streams may terminate a complete SSE data frame at EOF.
 * Parse that final frame; truncated JSON or a missing terminal marker still fails. */
export function createWorldProbeStream(usage: (input: number | null, output: number | null) => void) {
  let buffer = '', complete = false
  let frames = 0, doneMarkers = 0, finishReasonSeen = false, endCalled = false, eofTailCharacters = 0, invalidJsonFrames = 0
  let contentSeen = false, toolCallSeen = false, refusalSeen = false, reasoningSeen = false, providerErrorFrames = 0
  let lastBoundary: 'separator' | 'eof' | null = null, lastKind: 'empty' | 'done' | 'json' | 'invalid-json' | null = null
  const consume = (frame: string, boundary: 'separator' | 'eof') => {
    frames++; lastBoundary = boundary
    const data = frame.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n')
    if (data === '[DONE]') { lastKind = 'done'; doneMarkers++; complete = true; return }
    if (!data) { lastKind = 'empty'; return }
    let value
    try { value = JSON.parse(data); lastKind = 'json' }
    catch { lastKind = 'invalid-json'; invalidJsonFrames++; throw new Error('INVALID_SSE_JSON') }
    if (value?.error != null) { providerErrorFrames++; throw new Error('PROVIDER_STREAM_ERROR') }
    const nonempty = (text: unknown) => typeof text === 'string' && !!text.trim()
    for (const choice of value?.choices ?? []) {
      const delta = choice.delta ?? choice.message ?? {}
      contentSeen ||= nonempty(delta.content) || Array.isArray(delta.content) && delta.content.some((part: { text?: unknown }) => nonempty(part?.text))
      refusalSeen ||= nonempty(delta.refusal)
      reasoningSeen ||= nonempty(delta.reasoning_content) || nonempty(delta.reasoning)
      toolCallSeen ||= Array.isArray(delta.tool_calls) && delta.tool_calls.some((call: { id?: unknown; function?: { name?: unknown; arguments?: unknown } }) => nonempty(call?.id) || nonempty(call?.function?.name) || nonempty(call?.function?.arguments))
      toolCallSeen ||= nonempty(delta.function_call?.name) || nonempty(delta.function_call?.arguments)
    }
    if (value.usage) usage(value.usage.prompt_tokens ?? null, value.usage.completion_tokens ?? null)
    if (value.choices?.some((choice: { finish_reason?: string }) => choice.finish_reason)) { finishReasonSeen = true; complete = true }
  }
  return {
    push: (text: string) => {
      buffer += text
      let match: RegExpExecArray | null
      while ((match = /\r?\n\r?\n/.exec(buffer))) { const frame = buffer.slice(0, match.index); buffer = buffer.slice(match.index + match[0].length); consume(frame, 'separator') }
    },
    complete: () => complete,
    terminalSentinelSeen: () => doneMarkers > 0,
    end: () => { endCalled = true; eofTailCharacters = buffer.length; if (buffer.trim()) consume(buffer, 'eof'); buffer = ''; if (!complete) throw new Error('INCOMPLETE_RESPONSE') },
    assertModelOutput: () => { if (providerErrorFrames) throw new Error('PROVIDER_STREAM_ERROR'); if (!contentSeen && !toolCallSeen && !refusalSeen) throw new Error('EMPTY_MODEL_RESPONSE') },
    // Structural diagnostics only: no answer, reasoning, headers, or raw payload.
    diagnostics: () => ({ frames, doneMarkers, finishReasonSeen, endCalled, eofTailCharacters, invalidJsonFrames, lastBoundary, lastKind, pendingCharacters: buffer.length,
      contentSeen, toolCallSeen, refusalSeen, reasoningSeen, providerErrorFrames }),
  }
}
