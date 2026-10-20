import { randomUUID } from 'node:crypto'
import type { AppCommand, PublicErrorCode, UserQuestionView } from '../../shared'
import type { Clock } from '../clock'
import type { SessionStore } from '../store/session'
import type { ToolContext, ToolResult, HarnessTool } from '../harness/tools'
import type { JournalInput } from '../journal/schema'
import { answerInput, questionInput } from './schema'
import manifest from './tool.json'
import { sessionDayKey } from '../journal/file'

type Cause = Extract<JournalInput, { type: 'question/closed' }>['cause']
type Reply = { id: string; turnId: string; callId: string; answerId: string; unlisten(): void }
type Pending = { id: string; turnId: string; callId: string; flowId: string | null; question: string; choices: string[]; approval: boolean; createdAtMs: number;
  remainingMs: number; expiresAtMs?: number; shown: boolean; cancelTimer?: () => void; unlisten(): void; resolve(result: ToolResult): void }
const result = (value: Record<string, string>, ok = false): ToolResult => ({ ok, raw: value, visible: value })

export function createQuestions(options: { store: SessionStore; clock: Clock; flowId(): string | null; changed(): void; safeText(text: string): string }) {
  const { store, clock } = options
  let pending: Pending | undefined; let enabled = true; let closed = false
  const ready = new Map<string, Reply>()
  const append = (row: JournalInput) => store.append(row)
  // A restart must never resurrect a waiting action or deliver an answer to an incomplete tool batch.
  const rows = store.records()
  const consumed = new Set(rows.flatMap((row) => row.type === 'inbox/drain' || row.type === 'inbox/drop' ? row.ids : []))
  for (const request of rows) if (request.type === 'question/requested' && !rows.some((row) => (row.type === 'question/closed' || row.type === 'question/committed') && row.id === request.id)) {
    const answer = rows.find((row) => row.type === 'question/answered' && row.id === request.id)
    if (answer?.type === 'question/answered' && !consumed.has(answer.answerMessageId)) append({ type: 'inbox/drop', ids: [answer.answerMessageId] })
    append({ type: 'question/closed', id: request.id, turnId: request.turnId, cause: 'interrupted' })
  }
  const finish = (cause: Cause) => {
    const job = pending; if (!job) return
    pending = undefined; job.cancelTimer?.(); job.unlisten()
    append({ type: 'question/closed', id: job.id, turnId: job.turnId, cause })
    job.resolve(result({ status: cause, questionId: job.id })); options.changed()
  }
  const dropReply = (reply: Reply) => {
    if (!ready.delete(reply.id)) return
    reply.unlisten(); append({ type: 'inbox/drop', ids: [reply.answerId] })
    append({ type: 'question/closed', id: reply.id, turnId: reply.turnId, cause: 'cancelled' }); options.changed()
  }
  const stateChanged = (command?: AppCommand) => {
    const job = pending; if (!job) return
    const state = store.projection()
    if (closed || !enabled) { finish('disabled'); return }
    if (state.lightsOut || state.sleeping || state.task?.id !== job.turnId || !['running', 'waiting-user'].includes(state.task.status)) { finish('cancelled'); return }
    if (options.flowId() !== job.flowId || command?.type.startsWith('flow.goal.')) { finish('superseded'); return }
    const quiet = state.mode === 'quiet' || state.pomodoro.phase === 'focus'
    if (quiet && job.expiresAtMs !== undefined) {
      job.remainingMs = Math.max(0, job.expiresAtMs - clock.nowMs()); job.cancelTimer?.(); delete job.cancelTimer; delete job.expiresAtMs; options.changed()
    } else if (!quiet && job.expiresAtMs === undefined) {
      if (job.remainingMs <= 0) { finish('timeout'); return }
      job.expiresAtMs = clock.nowMs() + job.remainingMs
      job.cancelTimer = clock.after(job.remainingMs, () => finish('timeout'))
      if (!job.shown) { job.shown = true; append({ type: 'assistant/message', id: job.id, turnId: job.turnId, text: job.question, status: 'complete', displayOnly: true }) }
      options.changed()
    }
  }
  const view = (): UserQuestionView | undefined => {
    const job = pending; if (!job) return
    const base = { id: job.id, taskId: job.turnId, createdAtMs: job.createdAtMs, context: job.flowId ? 'work' as const : 'conversation' as const }
    return job.expiresAtMs === undefined ? { ...base, status: 'queued' } : { ...base, status: 'waiting', question: job.question, choices: [...job.choices], expiresAtMs: job.expiresAtMs, ...(job.approval ? { kind: 'approval' as const } : {}) }
  }
  // An approval is LCA asking the user on her behalf (DSH permissions): answered by one of its choices, and not
  // counted against the questions she may ask, so a busy work day never turns approvals into silent refusals.
  const open = async (input: Record<string, unknown>, context: ToolContext, approval: boolean): Promise<ToolResult> => {
    const parsed = questionInput.safeParse(input); const state = store.projection(); const callId = context.callId
    if (!parsed.success || !callId || context.signal.aborted || pending || closed || !enabled || state.lightsOut || state.sleeping || state.task?.id !== context.turnId) return result({ status: 'unavailable' })
    const values = [parsed.data.question, ...(parsed.data.choices ?? [])]
    if (values.some((text) => options.safeText(text) !== text)) return result({ status: 'invalid-question' })
    // A busy session may span 04:00 and rotate later. Count by event time across scoped pages.
    const day = (atMs: number) => sessionDayKey(clock, atMs)
    const requests = (store.history?.() ?? store.records()).filter((row) => row.type === 'question/requested' && !row.approval)
    if (!approval && (requests.filter((row) => day(row.atMs) === day(clock.nowMs())).length >= 12 || requests.filter((row) => row.type === 'question/requested' && row.turnId === context.turnId).length >= 3)) return result({ status: 'question-limit' })
    const id = randomUUID(); const flowId = options.flowId()
    append({ type: 'question/requested', id, turnId: context.turnId, callId, question: parsed.data.question, choices: parsed.data.choices ?? [], ...(flowId ? { flowId } : {}), ...(approval ? { approval: true as const } : {}) })
    return new Promise<ToolResult>((resolve) => {
      const aborted = () => { if (pending?.id === id) finish('cancelled'); const reply = ready.get(id); if (reply) dropReply(reply) }
      context.signal.addEventListener('abort', aborted, { once: true })
      pending = { id, turnId: context.turnId, callId, flowId, question: parsed.data.question, choices: parsed.data.choices ?? [], approval, createdAtMs: clock.nowMs(), remainingMs: 600_000, shown: false,
        unlisten: () => context.signal.removeEventListener('abort', aborted), resolve }
      stateChanged(); options.changed()
    })
  }
  return {
    view, stateChanged,
    interrupt: () => finish('superseded'),
    settled: (turnId: string) => { if (pending?.turnId === turnId) finish('cancelled'); for (const reply of [...ready.values()]) if (reply.turnId === turnId) dropReply(reply) },
    setEnabled: (value: boolean) => { enabled = value; if (!value) finish('disabled') },
    tool: (): HarnessTool => ({ definition: { ...manifest, parameters: zodParameters() }, templateId: 'user.ask', validate: (input) => questionInput.safeParse(input).success, run: (input, context) => open(input, context, false) }),
    approve: (input: { question: string; choices: string[] }, context: ToolContext) => open(input, context, true),
    dispatch: (command: AppCommand, signature: string): PublicErrorCode | undefined => {
      stateChanged(); const job = pending
      if (command.type !== 'question.answer' && command.type !== 'question.dismiss') return 'invalid-command'
      if (!job || job.id !== command.questionId || job.expiresAtMs === undefined) return 'invalid-command'
      if (command.type === 'question.dismiss') {
        append({ type: 'question/closed', id: job.id, turnId: job.turnId, cause: 'declined', requestId: command.requestId, commandHash: signature })
        pending = undefined; job.cancelTimer?.(); job.unlisten(); job.resolve(result({ status: 'declined', questionId: job.id })); options.changed(); return
      }
      const answer = answerInput.safeParse(command.answer)
      if (!answer.success || options.safeText(answer.data) !== answer.data || (job.approval && !job.choices.includes(answer.data))) return 'invalid-command'
      const answerId = randomUUID()
      append({ type: 'user/message', id: answerId, text: answer.data, requestId: command.requestId, commandHash: signature })
      append({ type: 'question/answered', id: job.id, turnId: job.turnId, answerMessageId: answerId })
      pending = undefined; job.cancelTimer?.()
      ready.set(job.id, { id: job.id, turnId: job.turnId, callId: job.callId, answerId, unlisten: job.unlisten })
      job.resolve(result({ status: 'answered', questionId: job.id, answerMessageId: answerId }, true)); options.changed()
    },
    commit: (turnId: string, callIds: readonly string[]) => {
      const replies = [...ready.values()].filter((reply) => reply.turnId === turnId && callIds.includes(reply.callId))
      if (!replies.length) return
      append({ type: 'inbox/drain', ids: replies.map((reply) => reply.answerId) })
      for (const reply of replies) { append({ type: 'question/committed', id: reply.id, turnId, answerMessageId: reply.answerId }); reply.unlisten(); ready.delete(reply.id) }
      options.changed()
    },
    close: () => { closed = true; finish('cancelled'); for (const reply of [...ready.values()]) dropReply(reply) },
  }
}
function zodParameters() {
  return { type: 'object', properties: { question: { type: 'string', maxLength: 240 }, choices: { type: 'array', maxItems: 3, items: { type: 'string', maxLength: 60 } } }, required: ['question'], additionalProperties: false }
}
export type QuestionService = ReturnType<typeof createQuestions>
