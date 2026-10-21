import { expect, it } from 'vitest'
import type { JournalRecord } from '../../src/main/journal/schema'
import { seenFragments } from '../../src/main/memory/seen'

it('keeps witnessed delivery evidence for gifts but does not extract external source contents as automatic memory', () => {
  const records = [
    { type: 'session/header', sessionId: 's' },
    { type: 'tool/call', turnId: 'source-turn', callId: 'source-call', templateId: 'mcp.call' },
    { type: 'assistant/message', turnId: 'source-turn', text: 'EXTERNAL_RECAP' },
    { type: 'model/seen', seq: 8, atMs: 80, messages: [
      { role: 'user', content: '我喜欢安静学习' },
      { role: 'user', content: JSON.stringify({ source: 'document', facts: 'delivery-ready' }) },
      { role: 'tool', toolCallId: 'source-call', content: 'EXTERNAL_SOURCE' },
      { role: 'assistant', content: 'EXTERNAL_RECAP' },
    ], eligibleIndexes: [0, 1, 2, 3] },
  ] as unknown as JournalRecord[]
  expect(seenFragments(records)).toHaveLength(4)
  expect(seenFragments(records, true).map((fragment) => fragment.text)).toEqual(['我喜欢安静学习'])
})
