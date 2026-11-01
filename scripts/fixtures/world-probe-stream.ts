/** Compatible SDK streams may terminate a complete SSE data frame at EOF.
 * Parse that final frame; truncated JSON or a missing terminal marker still fails. */
export function createWorldProbeStream(usage: (input: number | null, output: number | null) => void) {
  let buffer = '', complete = false
  const consume = (frame: string) => {
    const data = frame.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n')
    if (data === '[DONE]') { complete = true; return }
    if (!data) return
    const value = JSON.parse(data)
    if (value.usage) usage(value.usage.prompt_tokens ?? null, value.usage.completion_tokens ?? null)
    if (value.choices?.some((choice: { finish_reason?: string }) => choice.finish_reason)) complete = true
  }
  return {
    push: (text: string) => {
      buffer += text
      let match: RegExpExecArray | null
      while ((match = /\r?\n\r?\n/.exec(buffer))) { const frame = buffer.slice(0, match.index); buffer = buffer.slice(match.index + match[0].length); consume(frame) }
    },
    complete: () => complete,
    end: () => { if (buffer.trim()) consume(buffer); buffer = ''; if (!complete) throw new Error('INCOMPLETE_RESPONSE') },
  }
}
