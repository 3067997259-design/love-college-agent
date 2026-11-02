import { expect, it } from 'vitest'
import { summarizeProbeResponse } from '../../scripts/fixtures/probe-response'
it('summarizes a streamed tool call without exposing its arguments or reasoning', () => {
  const text = 'data: '+JSON.stringify({ choices: [{ delta: { reasoning_content: 'private reasoning', tool_calls: [{ function: { name: 'fixture', arguments: 'private args' } }] }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 } })+'\n\ndata: [DONE]\n\n'
  const result = summarizeProbeResponse(text)
  expect(result.complete).toBe(true); expect(result.toolCalls).toBe(1); expect(result.usage.totalTokens).toBe(7)
  expect(JSON.stringify(result)).not.toContain('private')
})
it('does not classify an empty or unfinished response as success', () => {
  expect(summarizeProbeResponse('').complete).toBe(false)
  expect(summarizeProbeResponse('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n').complete).toBe(false)
  expect(summarizeProbeResponse('{"choices":[]}').complete).toBe(false)
})
it('redacts credentials from a provider error summary', () => {
  const result = summarizeProbeResponse(JSON.stringify({ error: { message: 'bad fixture-secret at https://fixture.invalid/v1' } }), 'fixture-secret', 'https://fixture.invalid/v1')
  expect(result.error?.message).toBe('bad [redacted] at [endpoint]'); expect(result.complete).toBe(false)
})
