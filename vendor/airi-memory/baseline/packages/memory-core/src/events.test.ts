import { describe, expect, it } from 'vitest'

import { memoryEventToExtraction } from './events'

describe('memory event subscription filter', () => {
  it('accepts task conclusions and reactions', () => {
    expect(memoryEventToExtraction({ type: 'task:done', data: { conclusion: 'The task is complete', taskId: 'task-1' }, sessionId: 's1' })).toMatchObject({
      content: 'The task is complete',
      sessionId: 's1',
      sourceContext: {
        sessionId: 's1',
        sourceEventId: 'task-1',
        sourceType: 'task:done',
        neighbors: [],
      },
    })
    expect(memoryEventToExtraction({ type: 'event:reaction', data: { reaction: 'That surprised me' } })?.content).toBe('That surprised me')
  })

  it('rejects unstable and unsafe event sources', () => {
    expect(memoryEventToExtraction({ type: 'task:progress', data: { summary: 'halfway' } })).toBeUndefined()
    expect(memoryEventToExtraction({ type: 'task:log', data: { summary: 'trace' } })).toBeUndefined()
    expect(memoryEventToExtraction({ type: 'context:update', data: { text: 'volatile state' } })).toBeUndefined()
    expect(memoryEventToExtraction({ type: 'tool:return', data: { result: 'raw tool output' } })).toBeUndefined()
    expect(memoryEventToExtraction({ type: 'task:done', data: { result: 'raw tool output' } })).toBeUndefined()
  })
})
