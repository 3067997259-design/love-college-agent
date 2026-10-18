import { expect, it } from 'vitest'
import type { ContextMessage, JournalRecord } from '../../src/main/journal/schema'
import { retireSourceContext } from '../../src/main/campus/context'
import { seenFragments } from '../../src/main/memory/seen'

it('retires previous external evidence and its ignored-task reply while preserving user history and current tool protocol', () => {
  const rows = [
    { type: 'tool/call', turnId: 'old', callId: 'old-call', templateId: 'mcp.call', atMs: 10 },
    { type: 'assistant/message', turnId: 'old', text: 'STALE_EXTERNAL_REPLY', atMs: 11 },
    { type: 'campus/ignored', candidateId: 'ignored', atMs: 12 },
    { type: 'tool/call', turnId: 'current', callId: 'new-call', templateId: 'student-hub.assistant', atMs: 13 },
  ] as unknown as JournalRecord[]
  const messages: ContextMessage[] = [
    { role: 'user', content: '过去我问过那封邮件' }, { role: 'assistant', content: 'STALE_EXTERNAL_REPLY' },
    { role: 'tool', toolCallId: 'old-call', content: 'OLD_PRIVATE_BODY' }, { role: 'tool', toolCallId: 'new-call', content: 'CURRENT_RESULT' },
  ]
  const projected = retireSourceContext(messages, rows, 'current', [])
  expect(projected[0]).toEqual(messages[0]); expect(projected[1].content).toBe('')
  expect(projected[2].toolCallId).toBe('old-call'); expect(projected[2].content).not.toContain('OLD_PRIVATE_BODY')
  expect(projected[3]).toEqual(messages[3]); expect(messages[2].content).toBe('OLD_PRIVATE_BODY')
})

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
