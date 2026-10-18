import type { ContextMessage } from '../journal/schema'
import type { JournalRecord } from '../journal/schema'

export const isSourceTool = (templateId: string) => /^(mail\.|document\.|student-hub\.|mcp\.)/.test(templateId)

/** Domain data is refreshed from its owner, not re-used as a permanently valid tool answer. */
export function retireSourceContext(messages: readonly ContextMessage[], records: readonly JournalRecord[], turnId: string, ignoredTitles: readonly string[]) {
  const calls = records.flatMap((row) => row.type === 'tool/call' && (isSourceTool(row.templateId) || row.templateId === 'clock.read' || row.templateId === 'pomodoro.get_timer' || row.templateId.startsWith('memory.')) ? [row] : [])
  const oldCalls = new Set(calls.filter((row) => row.turnId !== turnId).map((row) => row.callId))
  const lastIgnore = records.filter((row) => row.type === 'campus/ignored').at(-1)?.atMs ?? -1
  const retiredTurns = new Set(calls.filter((row) => isSourceTool(row.templateId) && row.turnId !== turnId && row.atMs <= lastIgnore).map((row) => row.turnId))
  const retiredReplies = new Set(records.flatMap((row) => row.type === 'assistant/message' && (retiredTurns.has(row.turnId) || row.atMs <= lastIgnore && ignoredTitles.some((title) => title.length >= 4 && row.text.includes(title))) ? [row.text] : []))
  return messages.map((message) => {
    if (message.role === 'tool' && oldCalls.has(message.toolCallId ?? '')) {
      let jobId: string | undefined
      try { const value = JSON.parse(message.content); if (typeof value?.jobId === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value.jobId)) jobId = value.jobId } catch { /* No task locator in an unstructured result. */ }
      return { ...message, content: JSON.stringify({ status: 'historical-result-retired', ...(jobId ? { jobId } : {}), instruction: 'Read current source state if needed; this is not current evidence. A jobId is only a locator for status or cancellation.' }), imageRefs: undefined }
    }
    if (message.role === 'assistant' && retiredReplies.has(message.content)) return { ...message, content: '' }
    return message
  })
}

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
