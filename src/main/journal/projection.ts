import type { ActivityView, InteractionMode, MessageView, PomodoroView, Scope, TaskView } from '../../shared'
import { idleTimer } from '../pomodoro/schema'
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
  contextEntries: { seq: number; message: ContextMessage }[]
  lastModelContext?: ContextMessage[]
  requests: { requestId: string; commandHash: string }[]
  pomodoro: PomodoroView
  pomodoroPause: 'manual' | 'lights' | null
  pomodoroEvents: { id: string; text: string }[]
}

/** Raw tool data is deliberately absent from both UI and model projections. */
export function projectJournal(records: readonly JournalRecord[]): SessionProjection {
  const header = records[0]
  if (!header || header.type !== 'session/header') throw new Error('JOURNAL_HEADER_REQUIRED')
  const result: SessionProjection = { scope: { userId: header.userId, characterId: header.characterId, sessionId: header.sessionId },
    lastSeq: 0, mode: 'rest', lightsOut: false, messages: [], activities: [], task: null, evidenceSeqs: [], context: [], contextEntries: [], requests: [], pomodoro: idleTimer(), pomodoroPause: null, pomodoroEvents: [] }
  const context: { seq: number; order?: number; message: ContextMessage }[] = []
  const compacted = records.filter((record) => record.type === 'context/compact')
  const inbox = new Map<string, ContextMessage>()
  const heldMessages: MessageView[] = []
  const quiet = () => result.mode === 'quiet' || result.pomodoro.phase === 'focus' || result.lightsOut
  const release = () => { if (!quiet()) { result.messages.push(...heldMessages.splice(0)); result.messages.sort((a, b) => a.createdAtMs - b.createdAtMs) } }
  for (const record of records) {
    result.lastSeq = record.seq
    if ('requestId' in record && 'commandHash' in record) result.requests.push({ requestId: record.requestId, commandHash: record.commandHash })
    switch (record.type) {
      case 'session/carry':
        result.mode = record.mode; result.lightsOut = record.lightsOut; result.pomodoro = record.pomodoro
        result.pomodoroPause = record.pomodoroPause; result.pomodoroEvents = record.pomodoroEvents
        break
      case 'companion/mode': result.mode = record.mode; release(); break
      case 'companion/lights': result.lightsOut = record.lightsOut; release(); break
      case 'pomodoro/state':
        result.pomodoro = record.view; result.pomodoroPause = record.pauseReason
        if (record.mode) result.mode = record.mode
        release()
        if (record.event) result.pomodoroEvents.push(record.event)
        break
      case 'user/message':
        result.messages.push({ id: record.id, role: 'user', text: record.text, createdAtMs: record.atMs, status: 'complete' })
        inbox.set(record.id, { role: 'user', content: record.text })
        break
      case 'inbox/event': inbox.set(record.id, { role: 'user', content: JSON.stringify({ source: record.source, facts: record.text }) }); break
      case 'inbox/drain':
        for (const id of record.ids) { const message = inbox.get(id); if (message) { context.push({ seq: record.seq, message }); inbox.delete(id) } }
        break
      case 'inbox/drop':
        for (const id of record.ids) { inbox.delete(id); const message = result.messages.find((item) => item.id === id); if (message) message.status = 'undelivered' }
        break
      case 'assistant/message':
        if (record.text) (record.delivery === 'rest' && quiet() ? heldMessages : result.messages).push({ id: record.id, role: 'assistant', text: record.text, createdAtMs: record.atMs, status: record.status })
        context.push({ seq: record.seq, message: { role: 'assistant', content: record.text, ...(record.toolCalls?.length ? { toolCalls: record.toolCalls } : {}) } }); break
      case 'turn/start': result.task = { id: record.turnId, status: 'running', steps: [] }; break
      case 'turn/cancelling': if (result.task?.id === record.turnId) result.task.status = 'cancelling'; break
      case 'turn/paused': if (result.task?.id === record.turnId) result.task.status = 'waiting-user'; break
      case 'turn/resumed': if (result.task?.id === record.turnId) result.task.status = 'running'; break
      case 'turn/end':
        if (result.task?.id === record.turnId) result.task = { ...result.task,
          status: record.reason === 'completed' ? 'completed' : record.reason === 'aborted' ? 'aborted' : 'failed', ...(record.error ? { error: record.error } : {}) }
        for (const activity of result.activities) if (activity.taskId === record.turnId && activity.status === 'running') activity.status = record.reason === 'aborted' ? 'cancelled' : 'unknown'
        break
      case 'plan/update': if (result.task?.id === record.turnId) result.task.steps = record.steps; break
      case 'tool/call': result.activities.push({ id: record.callId, taskId: record.turnId, toolCallId: record.callId, templateId: record.templateId, status: 'running', fields: {} }); break
      case 'tool/result': {
        const activity = result.activities.find((item) => item.toolCallId === record.callId && item.taskId === record.turnId)
        if (activity) {
          const detail = record.visible && typeof record.visible === 'object' && !Array.isArray(record.visible) ? record.visible : {}
          activity.status = record.ok ? 'completed' : detail.error === 'cancelled' ? 'cancelled' : detail.execution === 'unknown' ? 'unknown' : 'failed'
          activity.fields = record.fields ?? {}
        }
        result.evidenceSeqs.push(record.seq)
        context.push({ seq: record.seq, message: { role: 'tool', content: JSON.stringify(record.visible), toolCallId: record.callId } }); break
      }
      case 'context/inject': context.push({ seq: record.seq, message: { role: 'system', content: record.text } }); break
      case 'context/compact': context.push({ seq: record.seq, order: record.fromSeq - 0.5, message: { role: 'system', content: record.summary } }); break
      case 'model/seen': result.lastModelContext = record.messages; break
    }
  }
  // Compact changes only model context. Chat history and all source events remain intact.
  result.contextEntries = context.filter((entry) => !compacted.some((range) => entry.seq >= range.fromSeq && entry.seq <= range.toSeq)).sort((a, b) => (a.order ?? a.seq) - (b.order ?? b.seq)).map(({ seq, message }) => ({ seq, message }))
  result.context = result.contextEntries.map((entry) => entry.message)
  return result
}
