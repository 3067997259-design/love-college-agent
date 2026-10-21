import { randomUUID } from 'node:crypto'
import type { AppCommand, PublicErrorCode, QuestionAnswer, UserQuestionView } from '../../shared'
import type { Clock } from '../clock'
import type { SessionStore } from '../store/session'
import type { ToolContext, ToolResult } from '../harness/tools'
import type { JournalInput } from '../journal/schema'
import { answerInput, answersInput, itemsInput, questionInput, type QuestionItem } from './schema'
import { sessionDayKey } from '../journal/file'

type Cause = Extract<JournalInput, { type: 'question/closed' }>['cause']
type Reply = { id: string; turnId: string; callId: string; answerId: string; unlisten(): void }
type Pending = { id: string; turnId: string; callId: string; question: string; choices: string[]; items?: QuestionItem[]; approval: boolean; createdAtMs: number;
  remainingMs: number; expiresAtMs?: number; shown: boolean; cancelTimer?: () => void; unlisten(): void; resolve(result: ToolResult): void }
const result = (value: Record<string, string | readonly QuestionAnswer[]>, ok = false): ToolResult => { const json = JSON.parse(JSON.stringify(value)) as ToolResult['raw']; return { ok, raw: json, visible: json } }

/**
 * Your answer to her questions as your words in the conversation: the picked options and what you wrote. One question
 * reads as the answer alone; several read one line each, headed by the question's name; a skipped one is left out.
 */
export function answerText(items: readonly QuestionItem[], answers: readonly QuestionAnswer[]) {
  const lines = items.map((item, index) => [answers[index].selected.join('、'), answers[index].custom ?? ''].filter(Boolean).join('；'))
  if (items.length === 1) return lines[0]
  return items.flatMap((item, index) => lines[index] ? [`${item.header ?? item.question}：${lines[index]}`] : []).join('\n')
}

export function createQuestions(options: { store: SessionStore; clock: Clock; changed(): void; safeText(text: string): string }) {
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
  const stateChanged = () => {
    const job = pending; if (!job) return
    const state = store.projection()
    if (closed || !enabled) { finish('disabled'); return }
    if (state.lightsOut || state.sleeping || state.task?.id !== job.turnId || !['running', 'waiting-user'].includes(state.task.status)) { finish('cancelled'); return }
    const quiet = state.mode === 'quiet' || state.pomodoro.phase === 'focus'
    if (quiet && job.expiresAtMs !== undefined) {
      job.remainingMs = Math.max(0, job.expiresAtMs - clock.nowMs()); job.cancelTimer?.(); delete job.cancelTimer; delete job.expiresAtMs; options.changed()
    } else if (!quiet && job.expiresAtMs === undefined) {
      if (job.remainingMs <= 0) { finish('timeout'); return }
      job.expiresAtMs = clock.nowMs() + job.remainingMs
      job.cancelTimer = clock.after(job.remainingMs, () => finish('timeout'))
      // Her questions stay in the conversation as her words once you can see them.
      if (!job.shown) { job.shown = true; append({ type: 'assistant/message', id: job.id, turnId: job.turnId, text: job.items?.map((item) => item.question).join('\n') ?? job.question, status: 'complete', displayOnly: true }) }
      options.changed()
    }
  }
  const view = (): UserQuestionView | undefined => {
    const job = pending; if (!job) return
    const base = { id: job.id, taskId: job.turnId, createdAtMs: job.createdAtMs, ...(job.approval ? { kind: 'approval' as const } : {}) }
    return job.expiresAtMs === undefined ? { ...base, status: 'queued' } : { ...base, status: 'waiting', question: job.question, choices: [...job.choices],
      ...(job.items ? { items: structuredClone(job.items) } : {}), expiresAtMs: job.expiresAtMs }
  }
  // An approval is LCA asking the user on her behalf (DSH permissions): answered by one of its choices, and not
  // counted against the questions she may ask, so a busy work day never turns approvals into silent refusals.
  const open = async (request: { question: string; choices: string[]; items?: QuestionItem[] }, context: ToolContext, approval: boolean): Promise<ToolResult> => {
    const state = store.projection(); const callId = context.callId
    if (!callId || context.signal.aborted || pending || closed || !enabled || state.lightsOut || state.sleeping || state.task?.id !== context.turnId) return result({ status: 'unavailable' })
    const values = [request.question, ...request.choices, ...(request.items ?? []).flatMap((item) => [item.header ?? '', item.question, ...item.options.flatMap((option) => [option.label, option.description ?? ''])])]
    if (values.some((text) => options.safeText(text) !== text)) return result({ status: 'invalid-question' })
    // A busy session may span 04:00 and rotate later. Count by event time across scoped pages.
    const day = (atMs: number) => sessionDayKey(clock, atMs)
    const requests = (store.history?.() ?? store.records()).filter((row) => row.type === 'question/requested' && !row.approval)
    if (!approval && (requests.filter((row) => day(row.atMs) === day(clock.nowMs())).length >= 12 || requests.filter((row) => row.type === 'question/requested' && row.turnId === context.turnId).length >= 3)) return result({ status: 'question-limit' })
    const id = randomUUID()
    append({ type: 'question/requested', id, turnId: context.turnId, callId, question: request.question, choices: request.choices, ...(request.items ? { items: request.items } : {}), ...(approval ? { approval: true as const } : {}) })
    return new Promise<ToolResult>((resolve) => {
      const aborted = () => { if (pending?.id === id) finish('cancelled'); const reply = ready.get(id); if (reply) dropReply(reply) }
      context.signal.addEventListener('abort', aborted, { once: true })
      pending = { id, turnId: context.turnId, callId, question: request.question, choices: request.choices, ...(request.items ? { items: request.items } : {}), approval, createdAtMs: clock.nowMs(), remainingMs: 600_000, shown: false,
        unlisten: () => context.signal.removeEventListener('abort', aborted), resolve }
      stateChanged(); options.changed()
    })
  }
  /** One answer per question in order, picks among its options (one unless it allows several), at least one not skipped. */
  const validAnswers = (items: readonly QuestionItem[], input: unknown) => {
    const parsed = answersInput.safeParse(input); if (!parsed.success || parsed.data.length !== items.length) return null
    const answers: QuestionAnswer[] = parsed.data.map((answer) => ({ id: answer.id, selected: answer.selected, ...(answer.custom !== undefined ? { custom: answer.custom } : {}) }))
    const fits = items.every((item, index) => {
      const answer = answers[index]; const labels = new Set(item.options.map((option) => option.label))
      return answer.id === item.id && new Set(answer.selected).size === answer.selected.length && answer.selected.every((label) => labels.has(label))
        && (item.multiSelect || answer.selected.length <= 1) && (answer.custom === undefined || options.safeText(answer.custom) === answer.custom)
    })
    return fits && answers.some((answer) => answer.selected.length || answer.custom) ? answers : null
  }
  return {
    view, stateChanged,
    /** An approval she asks for that still waits for you (shown or held back by focus and quiet). */
    approvalPending: () => pending?.approval ? pending.id : undefined,
    interrupt: () => finish('superseded'),
    settled: (turnId: string) => { if (pending?.turnId === turnId) finish('cancelled'); for (const reply of [...ready.values()]) if (reply.turnId === turnId) dropReply(reply) },
    setEnabled: (value: boolean) => { enabled = value; if (!value) finish('disabled') },
    /**
     * Her questions (DSH ask_user_question): one to four at once, each with optional choices. Up to three asks per
     * turn and twelve per day. Answered: `answers` (one per question) and `answerMessageId`, your words in the journal.
     */
    ask: (items: unknown, context: ToolContext) => {
      const parsed = itemsInput.safeParse(items)
      return parsed.success ? open({ question: parsed.data[0].question, choices: [], items: parsed.data }, context, false) : Promise.resolve(result({ status: 'invalid-question' }))
    },
    approve: (input: { question: string; choices: string[] }, context: ToolContext) => {
      const parsed = questionInput.safeParse(input)
      return parsed.success ? open({ question: parsed.data.question, choices: parsed.data.choices ?? [] }, context, true) : Promise.resolve(result({ status: 'unavailable' }))
    },
    dispatch: (command: AppCommand, signature: string): PublicErrorCode | undefined => {
      stateChanged(); const job = pending
      if (command.type !== 'question.answer' && command.type !== 'question.dismiss') return 'invalid-command'
      if (!job || job.id !== command.questionId || job.expiresAtMs === undefined) return 'invalid-command'
      if (command.type === 'question.dismiss') {
        append({ type: 'question/closed', id: job.id, turnId: job.turnId, cause: 'declined', requestId: command.requestId, commandHash: signature })
        pending = undefined; job.cancelTimer?.(); job.unlisten(); job.resolve(result({ status: 'declined', questionId: job.id })); options.changed(); return
      }
      let text: string; let answers: QuestionAnswer[] | undefined
      if (job.items) {
        answers = 'answers' in command ? validAnswers(job.items, command.answers) ?? undefined : undefined
        if (!answers) return 'invalid-command'
        text = answerText(job.items, answers)
      } else {
        const answer = 'answer' in command ? answerInput.safeParse(command.answer) : undefined
        if (!answer?.success || options.safeText(answer.data) !== answer.data || (job.approval && !job.choices.includes(answer.data))) return 'invalid-command'
        text = answer.data
      }
      const answerId = randomUUID()
      append({ type: 'user/message', id: answerId, text, requestId: command.requestId, commandHash: signature })
      append({ type: 'question/answered', id: job.id, turnId: job.turnId, answerMessageId: answerId })
      pending = undefined; job.cancelTimer?.()
      ready.set(job.id, { id: job.id, turnId: job.turnId, callId: job.callId, answerId, unlisten: job.unlisten })
      job.resolve(result({ status: 'answered', questionId: job.id, answerMessageId: answerId, ...(answers ? { answers } : {}) }, true)); options.changed()
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
export type QuestionService = ReturnType<typeof createQuestions>
