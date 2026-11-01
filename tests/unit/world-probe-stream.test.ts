import { expect, it } from 'vitest'
import { createWorldProbeStream } from '../../scripts/fixtures/world-probe-stream'

it('accepts a complete terminal frame at EOF with or without a final blank line', () => {
  for (const tail of ['data: [DONE]', 'data: [DONE]\n', 'data: [DONE]\r\n\r\n', 'data: {"choices":[{"finish_reason":"stop"}]}']) {
    const stream = createWorldProbeStream(() => {})
    stream.push('data: {"choices":[{"delta":{"content":"answer"}}]}\n\n' + tail)
    expect(() => stream.end()).not.toThrow(); expect(stream.complete()).toBe(true)
  }
})
it('handles split CRLF frames and preserves usage in a final JSON frame', () => {
  const usages: unknown[] = [], stream = createWorldProbeStream((input, output) => usages.push([input, output]))
  for (const char of 'data: {"choices":[{"finish_reason":"stop"}]}\r\n\r\ndata: {"usage":{"prompt_tokens":9,"completion_tokens":2}}') stream.push(char)
  stream.end(); expect(usages).toEqual([[9, 2]])
})
it('rejects truncated JSON even after a valid terminal frame', () => {
  const stream = createWorldProbeStream(() => {})
  stream.push('data: {"choices":[{"finish_reason":"stop"}]}\n\ndata: {"usage":')
  expect(() => stream.end()).toThrow()
})
it('rejects a disconnected content stream with no terminal evidence', () => {
  const stream = createWorldProbeStream(() => {})
  stream.push('data: {"choices":[{"delta":{"content":"unfinished"}}]}\n\n')
  expect(() => stream.end()).toThrow('INCOMPLETE_RESPONSE')
})
