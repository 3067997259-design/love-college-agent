import { describe, expect, it } from 'vitest'
// @ts-expect-error -- plain ESM plugin, also exercised with the real DSH runtime.
import { stateReply, statePrompt } from '../../dsh/lca-bridge/state.js'

const envelope = (mode = 'work', token = 'turn-token') => JSON.stringify({ lca_state: { mode, token }, reply: '我来处理。' })
describe('text-only state requests', () => {
  it('accepts only a complete dedicated envelope', () => {
    expect(stateReply(envelope())).toEqual({ kind: 'state', text: '我来处理。', state: { mode: 'work', token: 'turn-token' } })
    for (const mode of ['quiet', 'rest']) expect(stateReply(envelope(mode)).kind).toBe('state')
    for (const value of [envelope('lights-out'), envelope('work', ''), envelope().slice(0, -1), envelope().replace('"reply":', '"command":"pwsh", "reply":')]) expect(stateReply(value)).toEqual({ kind: 'invalid', text: '' })
  })
  it('leaves discussion, quoted examples and ordinary JSON as conversation', () => {
    for (const text of ['我开始工作了', '示例：' + envelope(), '```json\n' + envelope() + '\n```', '{"answer":42}']) expect(stateReply(text)).toEqual({ kind: 'text', text })
  })
  it('provides current mode, route and a fresh credential without widening permissions', () => {
    const prompt = statePrompt({ mode: 'quiet', token: 'this-turn' }, 'chat')
    for (const text of ['门牌=quiet', '当前执行模型=chat', 'this-turn']) expect(prompt).toContain(text)
    expect(statePrompt(undefined, 'chat')).toBe('')
  })
})
