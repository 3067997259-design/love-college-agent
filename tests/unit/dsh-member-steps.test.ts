import { expect, it } from 'vitest'
import { resolve } from 'node:path'
// @ts-expect-error -- independent DSH ESM bridge.
import { memberStepsProjection, memberStepsReply, nextMemberStep, stepTarget } from '../../dsh/lca-bridge/member-steps.js'
import { memberStepsSchema, publicMemberSteps } from '../../src/main/dsh/member-steps'

it('summarizes only allowlisted targets, relative paths and URL hosts', () => {
  const cwd = resolve('test-work')
  expect(stepTarget('read', { file_path: resolve(cwd, 'src/main.ts'), content: 'PRIVATE' }, cwd)).toBe('src/main.ts')
  expect(stepTarget('edit', { file_path: '../outside.txt' }, cwd)).toBeUndefined()
  expect(stepTarget('write', { file_path: resolve(cwd, '../outside.txt') }, cwd)).toBeUndefined()
  expect(stepTarget('grep', { pattern: 'a'.repeat(90) }, cwd)).toHaveLength(60)
  expect(stepTarget('pwsh', JSON.stringify({ command: 'b'.repeat(100) }), cwd)).toHaveLength(80)
  expect(stepTarget('web_fetch', { url: 'https://user:pass@example.org/path?private=yes#fragment' }, cwd)).toBe('example.org')
  expect(stepTarget('unknown', { path: 'x' }, cwd)).toBeUndefined()
})
it('replays the last twelve tool steps, pairs real DSH call ids and ignores surface replacements', () => {
  const p = memberStepsProjection(); let state = p.init({ cwd: resolve('test-work') })
  for (let i = 0; i < 14; i++) {
    state = p.apply(state, { type: 'tool/call', time: i * 100, data: { callId: `c${i}`, name: 'read', arguments: { file_path: `file-${i}` } } })
    state = p.apply(state, { type: 'tool/result', time: i * 100 + 20, data: { message: { toolCallId: `c${i}`, isError: i === 13 } } })
  }
  expect(state.steps).toHaveLength(12); expect(state.steps[0].callId).toBe('c2')
  expect(state.steps.at(-1)).toMatchObject({ status: 'failed', startedAt: 1300, endedAt: 1320 })
  const restored = p.stateSchema.parse(JSON.parse(JSON.stringify(state)))
  expect(p.apply(restored, { type: 'tool/result', time: 2000, surfaceOp: { op: 'replace' }, data: { message: { toolCallId: 'c13', isError: false } } })).toEqual(state)
  const fact = { labelLease: { sources: [] }, sources: [] }
  expect(memberStepsReply(state, fact, { sources: [] }).steps[0].target).toBe('file-2')
  for (const [metadata, current] of [[null, { sources: [] }], [fact, null], [fact, { sources: ['web'] }], [{ ...fact, labelLease: { sources: ['mail'] } }, { sources: [] }]]) {
    const result = memberStepsReply(state, metadata, current)
    expect(result.withheld).toBe(true); expect(JSON.stringify(result)).not.toContain('target')
  }
  state = p.apply(state, { type: 'plugin:lca/tool-source', time: 2100, data: { callId: 'c13', sources: ['web'] } })
  // A later clean activation does not disclose old source-derived command/search text.
  expect(memberStepsReply(state, fact, { sources: [] }).withheld).toBe(true)
})
it('follows tool, thinking and peer-message events without leaking the message', () => {
  let step = nextMemberStep(null, { type: 'turn/start' }, 1)
  step = nextMemberStep(step, { type: 'tool/call', data: { name: 'edit' } }, 2); expect(step.phase).toBe('tool')
  step = nextMemberStep(step, { type: 'tool/result' }, 3); expect(step).toMatchObject({ tool: 'edit', phase: 'thinking' })
  step = nextMemberStep(step, { type: 'user/message', data: { source: { kind: 'agent-message' }, content: 'PRIVATE' } }, 4)
  expect(step).toEqual({ tool: 'edit', phase: 'note', seq: 4 })
  expect(nextMemberStep(step, { type: 'turn/end' }, 5)).toBeNull()
})
it('bounds the main reply, strips extra fields and withholds target even if child sent it', () => {
  const raw = { withheld: false, transcript: 'PRIVATE', steps: [{ tool: 'read', status: 'completed', startedAt: 100, endedAt: 140, target: 'src/a.ts', output: 'PRIVATE' }] }
  const parsed = memberStepsSchema.parse(raw)
  expect(JSON.stringify(parsed)).not.toContain('PRIVATE')
  expect(memberStepsSchema.safeParse({ ...raw, steps: Array(13).fill(raw.steps[0]) }).success).toBe(false)
  expect(memberStepsSchema.safeParse({ ...raw, steps: [{ ...raw.steps[0], endedAt: 99 }] }).success).toBe(false)
  expect(memberStepsSchema.parse({ ...raw, withheld: true }).steps[0]).not.toHaveProperty('target')
  expect(publicMemberSteps(parsed, () => 'dsh.read')).toEqual({ withheld: false, steps: [{ templateId: 'dsh.read', status: 'completed', durationMs: 40, target: 'src/a.ts' }] })
})
