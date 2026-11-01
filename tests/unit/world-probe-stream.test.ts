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

it('records an EOF sentinel without retaining content or reasoning in diagnostics', () => {
  const stream = createWorldProbeStream(() => {})
  stream.push('data: {"choices":[{"delta":{"content":"PRIVATE_ANSWER","reasoning_content":"PRIVATE_REASONING"},"finish_reason":"stop"}]}\n\ndata: [DONE]')
  stream.end()
  expect(stream.diagnostics()).toEqual({ frames: 2, doneMarkers: 1, finishReasonSeen: true, endCalled: true, eofTailCharacters: 12, invalidJsonFrames: 0, lastBoundary: 'eof', lastKind: 'done', pendingCharacters: 0 })
  expect(JSON.stringify(stream.diagnostics())).not.toContain('PRIVATE')
})
it('distinguishes malformed EOF from missing terminal evidence without exposing the payload', () => {
  const stream = createWorldProbeStream(() => {})
  stream.push('data: {"private":"SECRET')
  expect(() => stream.end()).toThrow('INVALID_SSE_JSON')
  expect(stream.diagnostics()).toMatchObject({ invalidJsonFrames: 1, endCalled: true, lastBoundary: 'eof', lastKind: 'invalid-json', doneMarkers: 0, finishReasonSeen: false })
  expect(JSON.stringify(stream.diagnostics())).not.toContain('SECRET')
})

it('does not treat finish_reason alone as a sentinel before the later usage frame', () => {
  const usages: unknown[] = [], stream = createWorldProbeStream((input, output) => usages.push([input, output]))
  stream.push('data: {"choices":[{"finish_reason":"stop"}]}\n\n')
  expect(stream.complete()).toBe(true)
  expect(stream.terminalSentinelSeen()).toBe(false)
  stream.push('data: {"usage":{"prompt_tokens":8,"completion_tokens":3}}\n\ndata: [DONE]\n\n')
  expect(stream.terminalSentinelSeen()).toBe(true)
  stream.end(); expect(usages).toEqual([[8, 3]])
})
it('waits for a complete sentinel frame or EOF before confirming it', () => {
  const stream = createWorldProbeStream(() => {})
  stream.push('data: [DO'); expect(stream.terminalSentinelSeen()).toBe(false)
  stream.push('NE]'); expect(stream.terminalSentinelSeen()).toBe(false)
  stream.end(); expect(stream.terminalSentinelSeen()).toBe(true)
})
