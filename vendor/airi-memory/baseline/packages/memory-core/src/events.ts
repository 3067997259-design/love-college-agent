import type { MemoryExtraction, MemorySubscriptionEvent } from './types'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function textField(data: Record<string, unknown>, fields: string[]): string | undefined {
  for (const field of fields) {
    const value = data[field]
    if (typeof value === 'string' && value.trim())
      return value.trim()
  }

  return undefined
}

/** Converts one allowed stable event into a memory extraction. */
export function memoryEventToExtraction(event: MemorySubscriptionEvent): MemoryExtraction | undefined {
  if (event.type !== 'task:done' && event.type !== 'event:reaction' && event.type !== 'reaction')
    return undefined

  const data = isRecord(event.data) ? event.data : {}
  const content = event.type === 'task:done'
    ? textField(data, ['conclusion', 'summary', 'note'])
    : textField(data, ['reaction', 'text', 'message'])
  if (!content)
    return undefined

  const sourceEventId = textField(data, ['eventId', 'id', 'taskId', 'logRef'])

  return {
    content,
    category: event.type === 'task:done' ? 'life' : 'chat',
    memoryType: 'short_term',
    importance: event.type === 'task:done' ? 7 : 5,
    valence: 0,
    arousal: event.type === 'task:done' ? 0.5 : 0.4,
    tags: [event.type],
    sessionId: event.sessionId,
    ...(event.sessionId
      ? {
          sourceContext: {
            sessionId: event.sessionId,
            ...(sourceEventId ? { sourceEventId } : {}),
            sourceType: event.type,
            neighbors: [],
          },
        }
      : {}),
  }
}
