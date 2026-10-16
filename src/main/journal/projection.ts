import type { ActivityView, InteractionMode, MessageView, Scope, TaskView } from '../../shared'
import type { ContextMessage, JournalRecord } from './schema'

export interface SessionProjection {
  scope: Scope
  lastSeq: number
  mode: InteractionMode
  lightsOut: boolean
  messages: MessageView[]
  activities: ActivityView[]
  task: TaskView | null
  evidenceSeqs: number[]
  context: ContextMessage[]
  requests: { requestId: string; commandHash: string }[]
}

/** Raw tool data is deliberately absent from both UI and model projections. */
export function projectJournal(records: readonly JournalRecord[]): SessionProjection {
  const header = records[0]
  if (!header || header.type !== 'session/header') throw new Error('JOURNAL_HEADER_REQUIRED')
  const result: SessionProjection = { scope: { userId: header.userId, characterId: header.characterId, sessionId: header.sessionId },
    lastSeq: 0, mode: 'rest', lightsOut: false, messages: [], activities: [], task: null, evidenceSeqs: [], context: [], requests: [] }
  const context: { seq: number; message: ContextMessage }[] = []
  const compacted = records.filter((record) => record.type === 'context/compact')
  for (const record of records) {
    result.lastSeq = record.seq
    if ('requestId' in record) result.requests.push({ requestId: record.requestId, commandHash: record.commandHash })
    switch (record.type) {
      case 'companion/mode': result.mode = record.mode; break
      case 'companion/lights': result.lightsOut = record.lightsOut; break
      case 'user/message':
        result.messages.push({ id: record.id, role: 'user', text: record.text, createdAtMs: record.atMs, status: 'complete' })
        context.push({ seq: record.seq, message: { role: 'user', content: record.text } }); break
      case 'assistant/message':
        if (record.text) result.messages.push({ id: record.id, role: 'assistant', text: record.text, createdAtMs: record.atMs, status: record.status })
        context.push({ seq: record.seq, message: { role: 'assistant', content: record.text, ...(record.toolCalls?.length ? { toolCalls: record.toolCalls } : {}) } }); break
      case 'turn/start': result.task = { id: record.turnId, status: 'running', steps: [] }; break
      case 'turn/end':
        if (result.task?.id === record.turnId) result.task = { ...result.task,
          status: record.reason === 'completed' ? 'completed' : record.reason === 'aborted' ? 'aborted' : 'failed', ...(record.error ? { error: record.error } : {}) }
        for (const activity of result.activities) if (activity.taskId === record.turnId && activity.status === 'running') activity.status = record.reason === 'aborted' ? 'cancelled' : 'unknown'
        break
      case 'plan/update': if (result.task?.id === record.turnId) result.task.steps = record.steps; break
      case 'tool/call': result.activities.push({ id: record.callId, taskId: record.turnId, toolCallId: record.callId, templateId: record.templateId, status: 'running', fields: {} }); break
      case 'tool/result': {
        const activity = result.activities.find((item) => item.toolCallId === record.callId && item.taskId === record.turnId)
        if (activity) { activity.status = record.ok ? 'completed' : 'failed'; activity.fields = record.fields ?? {} }
        result.evidenceSeqs.push(record.seq)
        context.push({ seq: record.seq, message: { role: 'tool', content: JSON.stringify(record.visible), toolCallId: record.callId } }); break
      }
      case 'context/inject': context.push({ seq: record.seq, message: { role: 'system', content: record.text } }); break
      case 'context/compact': context.push({ seq: record.seq, message: { role: 'system', content: record.summary } }); break
    }
  }
  // Compact changes only model context. Chat history and all source events remain intact.
  result.context = context.filter((entry) => !compacted.some((range) => entry.seq >= range.fromSeq && entry.seq <= range.toSeq)).map((entry) => entry.message)
  return result
}
