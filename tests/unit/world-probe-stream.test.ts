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
  expect(stream.diagnostics()).toEqual({ frames: 2, doneMarkers: 1, finishReasonSeen: true, endCalled: true, eofTailCharacters: 12, invalidJsonFrames: 0, lastBoundary: 'eof', lastKind: 'done', pendingCharacters: 0,
    contentSeen: true, toolCallSeen: false, refusalSeen: false, reasoningSeen: true, providerErrorFrames: 0 })
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

it('distinguishes terminal protocol frames from a usable model response', () => {
  for (const frame of [{ choices: [] }, { choices: [{ delta: { role: 'assistant' } }] }, { usage: { prompt_tokens: 1 } }, { choices: [{ delta: { reasoning_content: 'PRIVATE_THOUGHT' }, finish_reason: 'stop' }] }]) {
    const stream = createWorldProbeStream(() => {})
    stream.push('data: ' + JSON.stringify(frame) + '\n\ndata: [DONE]\n\n'); stream.end()
    expect(stream.complete()).toBe(true)
    expect(() => stream.assertModelOutput()).toThrow('EMPTY_MODEL_RESPONSE')
    expect(JSON.stringify(stream.diagnostics())).not.toContain('PRIVATE')
  }
})

it('accepts completed text, structured tools and refusals', () => {
  for (const delta of [{ content: 'answer' }, { content: [{ text: 'answer' }] }, { tool_calls: [{ function: { name: 'search_memory', arguments: '{}' } }] }, { function_call: { name: 'legacy_tool' } }, { refusal: 'cannot answer' }]) {
    const stream = createWorldProbeStream(() => {})
    stream.push('data: ' + JSON.stringify({ choices: [{ delta, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n')
    stream.end(); expect(() => stream.assertModelOutput()).not.toThrow()
  }
})

it('rejects content plus DONE without the finish_reason required by DSH', () => {
  for (const delta of [{ content: 'answer' }, { tool_calls: [{ function: { name: 'search_memory', arguments: '{}' } }] }, { refusal: 'cannot answer' }]) {
    const stream = createWorldProbeStream(() => {})
    stream.push('data: ' + JSON.stringify({ choices: [{ delta }] }) + '\n\ndata: [DONE]\n\n')
    stream.end()
    expect(stream.diagnostics().finishReasonSeen).toBe(false)
    expect(() => stream.assertModelOutput()).toThrow('MISSING_FINISH_REASON')
  }
})

it('rejects in-stream provider errors without retaining upstream text in diagnostics', () => {
  const stream = createWorldProbeStream(() => {})
  expect(() => stream.push('data: {"error":{"message":"PRIVATE_SERVICE_ERROR"}}\n\n')).toThrow('PROVIDER_STREAM_ERROR')
  expect(stream.diagnostics().providerErrorFrames).toBe(1)
  expect(() => stream.assertModelOutput()).toThrow('PROVIDER_STREAM_ERROR')
  expect(JSON.stringify(stream.diagnostics())).not.toContain('PRIVATE')
})
