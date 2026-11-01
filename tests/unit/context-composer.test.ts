import { describe, expect, it } from 'vitest'
import { composeContext } from '../../src/main/context/composer'

const input = { capabilities: { contextWindow: 32_768, maxOutputTokens: 4096 }, systemText: 'System', tools: [], inputText: 'Question' }
describe('one context reference budget', () => {
  it('keeps current constraints and whole revised facts before older history', () => {
    const facts = [{ id: 'new-fact', revision: 2, text: 'The due date is NOT Friday; it is Saturday.' }]
    const result = composeContext({ ...input, reference: { currentTime: 'now', ignoredCandidateIds: ['retired-source'], memoryReference: facts,
      previousDaysReference: Array.from({ length: 10 }, (_, index) => ({ id: String(index), text: 'old '.repeat(1600) })) } })
    expect(JSON.parse(result.text).memoryReference).toEqual(facts)
    expect(JSON.parse(result.text).ignoredCandidateIds).toEqual(['retired-source'])
    expect(result.omitted).toBeGreaterThan(0); expect(result.bytes).toBeLessThanOrEqual(result.budget)
  })
  it('charges multibyte text, current input, tools, outputs and revealed originals against the same allowance', () => {
    const references = { currentTime: 'now', memoryReference: [{ id: 'fact', revision: 1, text: '不'.repeat(1000) }] }
    const baseline = composeContext({ ...input, reference: references })
    const larger = composeContext({ ...input, inputText: '新'.repeat(1000), tools: [{ description: 'tool '.repeat(100) }], revealedText: 'original', reference: references })
    expect(larger.budget).toBeLessThan(baseline.budget); expect(larger.bytes).toBe(Buffer.byteLength(larger.text))
    expect(larger.capacitySource).toBe('adapter')
  })
  it('never drops a source restriction silently to make an undersized model fit', () => {
    expect(() => composeContext({ ...input, capabilities: { contextWindow: 2048, maxOutputTokens: 1024 }, reference: { ignoredCandidateIds: ['restricted'] } })).toThrow('CONTEXT_REFERENCE_BUDGET_EXCEEDED')
  })
})
