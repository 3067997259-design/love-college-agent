import type { ContextMessage } from '../journal/schema'

/** Refresh generated mail records in the model projection; never rewrite user chat or the journal. */
export function omitIgnoredMail(messages: readonly ContextMessage[], ignored: ReadonlySet<string>): ContextMessage[] {
  return messages.map((message) => {
    if (!ignored.size || !['user', 'tool'].includes(message.role)) return message
    try {
      const value = JSON.parse(message.content)
      if (message.role === 'user' && value?.source === 'mail' && typeof value.facts === 'string') {
        const facts = JSON.parse(value.facts)
        if (ignored.has(facts?.candidateId)) return { ...message, content: JSON.stringify({ source: 'mail', facts: JSON.stringify({ candidateId: facts.candidateId, status: 'ignored' }) }) }
      }
      if (message.role === 'tool' && Array.isArray(value?.items)) return { ...message, content: JSON.stringify({ ...value, items: value.items.filter((item: { candidateId?: string } | null) => !item?.candidateId || !ignored.has(item.candidateId)) }) }
    } catch { /* Ordinary conversation is not a generated mail record. */ }
    return message
  })
}
