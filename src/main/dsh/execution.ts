import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import type { AppEvent, PublicErrorCode } from '../../shared'
import { readClock, type Clock } from '../clock'
import { failureNarration } from '../harness/failure'
import type { HarnessTool } from '../harness/tools'
import type { JournalInput } from '../journal/schema'
import type { SessionStore } from '../store/session'
import type { ExtensionRuntime } from './extensions'
import { dshSources, startDshHost, type DshApproval, type DshEvent, type DshHost, type DshHostOptions, type DshSource } from './host'
import { itemsInput, type QuestionItem } from '../questions/schema'
import type { DshRoutes } from './routes'
import { createCollaborationState } from './collaboration'
import { createMemberFocus } from './member-focus'
import { publicMemberSteps } from './member-steps'
import { toolKind } from './tool-kinds'
import type { CollaborationView } from '../../shared/collaboration'
import type { DshConversationState, DshRootPolicy } from '../../shared/dsh-protocol'
import type { RootCompactionOutcome, WorkEvidence } from '../../shared/continuity'
import { workEvidenceSchema, workDigest } from '../work/journal'
import { composeContext, ContextBudgetFailure } from '../context/composer'
import type { ResolvedModelCapabilities } from '../../shared/model-capabilities'

/**
 * `seen`: the conversation of this turn, in order, as she saw it: your lines and her replies, never tool traffic.
 * `impressions`: she read an old page's impression (optical memory, unreviewed); what she says in this turn may draw
 * on it, so memory does not learn from her replies.
 */
type Turn = { impressions?: boolean; memoryDerived?: boolean; lcaTurnId: string; trigger: Trigger; attempts: number; role: 'chat' | 'work'; denied?: PublicErrorCode; partial: string; toolsExecuted: boolean; calls: Map<string, { command: string | null; templateId: string }>; asks: AbortController; seen: { role: 'user' | 'assistant'; content: string; originalEventId?: string }[]; inputEvents: Set<string> }
/** Things that happened that she may speak about (pomodoro, mail, documents, her own life): inbox events in the journal. */
export type DshEventSource = 'pomodoro' | 'mail' | 'document' | 'autonomous' | 'work'
type Trigger = 'user' | DshEventSource
type Rule = { project: string; tool: string; prefix: string | null }
/** One DSH session per LCA day; `degraded` survives a restart that came before the bridge retired third-party results. */
/**
 * Her DSH sessions per LCA day, one per project folder: a project keeps its own sandbox root and trust, so
 * switching never widens permissions. `seenSeq`: journal position up to which that session has the conversation.
 * Older files hold a single session per day.
 */
type SavedSession = { id: string; cwd: string; degraded?: DshSource[]; seenSeq?: number }
type Saved = Record<string, SavedSession | SavedSession[]>
type Live = { id: string; cwd: string; day: string; fresh?: boolean; seenSeq: number }
const daySessions = (saved: Saved, day: string): SavedSession[] => { const value = saved[day]; return Array.isArray(value) ? value : value ? [value] : [] }
/** Conversation she missed in this session, newest kept: at most 40 lines and about 12k characters. */
const EARLIER_LINES = 40
const EARLIER_CHARS = 12_000
const LCA_PREFIX = 'lca_'
const clip = (text: string, max: number) => (text.length > max ? text.slice(0, max) + '…' : text)
const parsed = (raw: string): Record<string, unknown> => { try { const value: unknown = JSON.parse(raw); return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {} } catch { return {} } }
// LCA tools that hand her third-party originals, as in D2 (index.ts thirdPartySources).
const sourceOf = (templateId: string): DshSource | null => templateId.startsWith('mail.') ? 'mail' : templateId.startsWith('document.') ? 'document'
  : templateId.startsWith('student-hub.') ? 'plugin' : templateId.startsWith('mcp.') ? 'mcp' : null
const line = (value: unknown) => typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : ''
/** DSH's ask_user_question as the book shows it: one line per text, a short header, options as given. Null when it cannot be shown. */
const itemsOf = (questions: unknown): QuestionItem[] | null => {
  if (!Array.isArray(questions)) return null
  const items = questions.map((entry: Record<string, unknown> | null) => {
    const header = clip(line(entry?.header), 23)
    return { id: line(entry?.id), ...(header ? { header } : {}), question: line(entry?.question), multiSelect: entry?.multiSelect === true,
      options: (Array.isArray(entry?.options) ? entry.options : []).map((option: Record<string, unknown> | null) => {
        const description = clip(line(option?.description), 159)
        return { label: line(option?.label), ...(description ? { description } : {}) }
      }) }
  })
  const parsed = itemsInput.safeParse(items)
  return parsed.success ? parsed.data : null
}
// Why she gets no answer, in words she reads (questions/service.ts statuses).
const UNANSWERED: Record<string, string> = {
  timeout: 'The user did not answer within ten minutes of visible time. Go on without it, or ask again later.',
  'question-limit': 'Question limit reached: at most three asks per turn and twelve per day. Go on with what you know.',
  'invalid-question': 'The question could not be shown. Ask in plain text, without secrets or credentials.',
  superseded: 'The user wrote to you instead of answering. Read their new message.',
}
const SOURCE_TEXT: Record<DshSource, string> = { web: '网页', mcp: '外部工具给的内容', mail: '邮件原文', document: '附件原文', plugin: '插件资料', member: '协作者的消息' }
const ACTION_TEXT: Record<string, string> = { write: '写文件', edit: '改文件', pwsh: '运行命令', bash: '运行命令', web_fetch: '再上网', web_search: '再上网' }
/**
 * A DSH turn error as LCA's closed failure vocabulary (narrator/failure). Only DSH's error code and the HTTP status
 * number are read; the message text itself (it can quote the vendor's response) never reaches the book.
 */
export const failureOf = (reason: unknown): { code: PublicErrorCode; httpStatus?: number } => {
  const error = (reason as { error?: { code?: unknown; message?: unknown } } | null)?.error
  const code = String(error?.code ?? ''); const message = String(error?.message ?? '')
  const status = Number(message.match(/\b([45]\d\d)\b/)?.[1]); const httpStatus = Number.isInteger(status) ? status : undefined
  const result = (value: PublicErrorCode) => ({ code: value, ...(httpStatus !== undefined ? { httpStatus } : {}) })
  if (/QUOTA/.test(code)) return result('quota-exhausted')
  if (/AUTH|CREDENTIAL|UNKNOWN_MODEL|INVALID_CONFIG|NO_ADAPTER|UNSUPPORTED_CONTENT|UNSUPPORTED_REASONING_EFFORT|INVALID_MODEL_/.test(code)) return result('configuration-failed')
  // Only an explicit filter verdict counts (a vendor code or finish reason); a word in an error body is no evidence.
  if (/CONTENT_FILTER/.test(code) || /\bcontent_policy_violation\b|\bcontent_filter\b|"finish_reason"\s*:\s*"content_filter"/.test(message)) return result('content-filtered')
  if (/INVALID_REQUEST/.test(code)) return result('configuration-failed')
  if (code === 'RATE_LIMIT' || code === 'SERVER') return result('upstream-busy')
  if (/CONTEXT_WINDOW/.test(code)) return result('context-too-large')
  if (code === 'EMPTY_RESPONSE') return result('invalid-model-output')
  if (code === 'STREAM_CLOSED' || code === 'TRANSPORT' && /stream ended|premature|terminated|closed/i.test(message)) return result('stream-interrupted')
  return result('connection-failed')
}

/**
 * DSH execution port (on whenever the runtime ships and a chat model is configured). The user's messages go
 * to her DSH session for the day, in the project folder the book picked. DSH's own session log is the record of what she saw and did; the journal keeps what LCA owns: the
 * conversation, a reference to the DSH turn, the book's activity rows, approvals and trust grants.
 * Tool calls and results never enter LCA's model context or memory. A message sent while a DSH turn
 * runs steers it. Approvals use the book's question card; "以后都允许" is remembered per project (and
 * per command prefix for risky ones), except while third-party content is in her context (D2).
 */
export function createDshExecution(options: {
  store: SessionStore; clock: Clock; dataDir: string; dshRoot: string; bridge: string; routes: DshRoutes; guardedRoots: readonly string[]
  /** 'fake' when the routes lead to developer scenes' scripted model (developer/endpoint.ts). */
  source?: 'real' | 'fake'
  project(): string; persona(): string; suffix(): string; tools(): readonly HarnessTool[]
  ask(question: string, choices: string[], context: { turnId: string; callId: string; signal: AbortSignal; member?: boolean }): Promise<string | null>
  /**
   * Her questions to you (DSH ask_user_question) in the book's question card (questions/service.ts ask). Answered:
   * `answers` one per question and `answerMessageId`, your words in the journal; otherwise why not.
   */
  question?(items: QuestionItem[], context: { turnId: string; callId: string; signal: AbortSignal }): Promise<{ status?: unknown; answers?: unknown; answerMessageId?: unknown }>
  /**
   * References that go with your message (memory/service.ts reference): earlier days' summaries with the first message
   * of a new session, memories matching your latest lines. Sent beside your text, never recorded as your words.
   */
  reference?(input: { requestId: string; firstOfSession: boolean }): Record<string, unknown> | null | Promise<Record<string, unknown> | null>
  referencesPrepared?(requestId: string, reference: Record<string, unknown>): void
  /** A turn your message opened has its LCA id now (an old-page quote sent with that message belongs to it). */
  started?(input: { turnId: string; requestId: string }): void
  /** You answered a question she asked in this turn: the answer has reached her (questions/service.ts commit). */
  answered?(input: { turnId: string; callId: string }): void
  /** A turn of hers starts or you send her a message: background model work (memory, diary, her own works) gives way. */
  foreground?(): void
  /** You sent her a message: she wakes up and comes back from an outing. */
  userWork?(): void
  /** A turn ended: what she said may be read aloud. */
  settled?(): void
  /** Extra reasons to hold events back, besides focus, quiet mode and sleep (a game round). */
  backgroundQuiet?(): boolean
  /** Apply a validated model request through the same main-owned state change as the menu. */
  setMode?(mode: DshConversationState['mode'], requestId: string): boolean
  /**
   * A third-party original you asked to see (mail "看原文"), once: it rides with the next turn's references. That turn
   * is degraded, and the next one retires it with the other references (D2).
   */
  revealed?(): { reference: Record<string, unknown>; text: string; source: DshSource } | null
  /** Resource ledger for one model step: null lets it run; a code stops the turn and says why (allowance used up, ledger unreadable). */
  admit?(input: { bucket: 'work' | 'autonomous'; units: number }): PublicErrorCode | null
  disconnected?(): void
  changed(reason: AppEvent['reason']): void
  /**
   * Real time for watching the DSH process (killing it when a shutdown stalls). The business clock may be frozen in
   * developer scenes, and a quit must not wait on it.
   */
  processClock?: Clock
  /** Test seam; production launches the DSH child process. */
  launch?: typeof startDshHost
  rootPolicy?: DshRootPolicy
  /** Shared project trust, while private sessions and turns remain per root. */
  rulesFile?: string
  consumed?(eventId: string): void
  evidence?(evidence: WorkEvidence): void
  successfulInputs?(eventIds: readonly string[]): void
}) {
  const { store, clock } = options
  const sessionsFile = join(options.dataDir, 'dsh-sessions.json')
  const rulesFile = options.rulesFile ?? join(options.dataDir, 'dsh-approvals.json')
  let workRevision = options.rootPolicy?.work?.objectiveRevision ?? 0
  const observations = new Map<string, WorkEvidence>()
  const read = <T>(file: string, fallback: T): T => { try { return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) as T : fallback } catch { return fallback } }
  // Once closed (the app quitting, a model change) nothing more is recorded: the journal may already be closed, and
  // a turn DSH ends after this point is closed at the next start.
  let maintaining = false
  let closed = false
  let closing: Promise<void> | undefined
  let pendingWorkSettlement = false
  const settleWorkerIfIdle = () => {
    if (!pendingWorkSettlement || closed || turn || opening || preparing || starts.length || maintaining || collaboration.busy()) return
    pendingWorkSettlement = false; options.settled?.()
  }
  const focus = createMemberFocus(clock, (name) => toolKind(name, lcaTools()), (view) => { if (!closed) collaboration.accept(view) })
  const collaboration = createCollaborationState({
    allowed: () => !closed && !maintaining && !store.projection().lightsOut && !store.projection().sleeping,
    changed: () => { if (!closed) { options.changed('task'); if (pendingWorkSettlement) queueMicrotask(settleWorkerIfIdle) } },
    run: async (command) => {
      if (closed || maintaining) throw new Error('DSH_BUSY')
      const recovering = command.type === 'agent.refresh' && host?.available?.() === false
      if (recovering) maintaining = true
      try {
        // Only an explicit read reconnects. Never resend the action whose receipt was lost.
        if (recovering) { const previous = host; host = undefined; session = undefined; await previous?.close() }
        if (closed) throw new Error('DSH_EXECUTION_CLOSED')
        const current = await ensureSession()
        const result = await host!.collaboration({ rootSessionId: current.id, command, requestId: 'requestId' in command ? String(command.requestId) : undefined })
        if (closed || session !== current || current.cwd !== resolve(options.project())) throw new Error('DSH_ORIGIN_UNAVAILABLE')
        return focus.accept(result.view)
      } finally { if (recovering) maintaining = false }
    },
    readMemberSteps: async (address) => {
      const current = session, running = host
      const member = collaboration.view().members.find((entry) => JSON.stringify(entry.address) === JSON.stringify(address))
      if (closed || maintaining || !current || !running || !currentScope() || current.id !== address.rootSessionId || !member) throw new Error('LCA_MEMBER_STEPS_UNAVAILABLE')
      const answer = await running.memberSteps({ address, expectedRevision: member.revision })
      if (closed || session !== current || host !== running || !currentScope()) throw new Error('LCA_MEMBER_STEPS_UNAVAILABLE')
      return publicMemberSteps(answer, (name) => toolKind(name, lcaTools()))
    },
  })
  const resetCollaboration = (failed = false) => { focus.reset(); collaboration.reset(failed) }
  const record = (input: JournalInput) => { if (!closed) store.append(input) }
  const lcaTools = () => new Map(options.tools().map((tool) => [LCA_PREFIX + tool.definition.name, tool]))
  let host: DshHost | undefined
  let session: Live | undefined
  const currentScope = () => !!session && session.day === store.scope.sessionId && session.cwd === resolve(options.project())
  let turn: Turn | undefined
  let modeState: DshConversationState | undefined
  let modeSignature = ''
  let stateChanges = 0
  const syncState = (fresh = false) => {
    const view = store.projection()
    const last = store.records().findLast((row) => row.type === 'companion/mode' || row.type === 'companion/lights' || row.type === 'companion/sleep' || row.type === 'pomodoro/state' && row.mode !== undefined)
    const signature = JSON.stringify([store.scope.sessionId, options.project(), last?.seq, view.mode, view.lightsOut, view.sleeping])
    if (fresh || !modeState || signature !== modeSignature) {
      modeSignature = signature; modeState = { mode: view.mode, token: randomUUID() }
      if (session && currentScope()) host?.state?.(session.id, modeState)
    }
    return modeState
  }
  const requestState: NonNullable<DshHostOptions['onState']> = ({ sessionId, state }) => {
    const input = state as Partial<DshConversationState> | null
    const current = turn, view = store.projection()
    const issued = modeState?.token
    syncState()
    if (closed || !current || current.trigger !== 'user' || current.asks.signal.aborted || !currentScope() || sessionId !== session?.id
      || !input || input.token !== issued || input.token !== modeState?.token || !['work', 'quiet', 'rest'].includes(String(input.mode))
      || Object.keys(input).sort().join() !== 'mode,token' || view.lightsOut || view.sleeping || stateChanges >= 2
      || input.mode === 'rest' && view.pomodoro.phase === 'focus' && view.pomodoro.status !== 'idle') return false
    if (input.mode === view.mode) return false
    if (!options.setMode?.(input.mode!, `model-state-${current.lcaTurnId}-${stateChanges + 1}`)) return false
    stateChanges++; syncState(); return true
  }
  let pending: string[] = []
  const pendingText = new Map<string, string>()
  // Events wait here while she must stay quiet; `starts` says who opened each turn DSH has yet to begin (and with
  // which of your messages).
  const held: { id: string; source: DshEventSource; text: string }[] = []
  const starts: { trigger: Trigger; requestId: string | null; memoryDerived?: boolean }[] = []
  const begin = (lcaTurnId: string, start: { trigger: Trigger; requestId: string | null } | undefined) => {
    record({ type: 'turn/start', turnId: lcaTurnId, trigger: start?.trigger ?? 'user' })
    if (start?.requestId) options.started?.({ turnId: lcaTurnId, requestId: start.requestId })
    drain()
  }
  const eventIds = new Set<string>()
  // Focus, quiet mode and sleep hold events back; your own message never waits.
  const quiet = () => { const view = store.projection(); return !!options.backgroundQuiet?.() || view.sleeping || view.mode === 'quiet' || view.pomodoro.phase === 'focus' }
  // A turn a quit or crash left open ended there: DSH does not carry it on, so neither does the book. Your messages
  // that never reached her are marked undelivered (send again); answers to her questions are her tool results, not these.
  const opened = store.projection().task
  if (opened && ['running', 'cancelling', 'queued', 'waiting-user'].includes(opened.status)) record({ type: 'turn/end', turnId: opened.id, reason: 'aborted' })
  const consumed = new Set(store.records().flatMap((row) => row.type === 'inbox/drain' || row.type === 'inbox/drop' ? row.ids : row.type === 'question/answered' ? [row.answerMessageId] : []))
  const undelivered = store.records().flatMap((row) => row.type === 'user/message' && !consumed.has(row.id) ? [row.id] : [])
  for (let index = 0; index < undelivered.length; index += 32) record({ type: 'inbox/drop', ids: undelivered.slice(index, index + 32) })
  // Events recorded before a restart (or a model change) and not yet given to her wait here again.
  for (const event of store.projection().pendingEvents) held.push({ id: event.id, source: event.source, text: event.text })
  const factsOf = (event: { source: DshEventSource; text: string }) => JSON.stringify({ source: event.source, facts: event.text })
  // The book shows one question at a time; concurrent approvals wait their turn instead of failing.
  let asking: Promise<unknown> = Promise.resolve()
  const ask: typeof options.ask = (question, choices, context) => {
    const next = asking.then(() => context.signal.aborted ? null : options.ask(question, choices, context))
    asking = next.catch(() => null)
    return next
  }

  const drain = () => {
    if (!pending.length) return
    record({ type: 'inbox/drain', ids: pending })
    for (const id of pending) { const text = pendingText.get(id); if (turn && text) turn.seen.push({ role: 'user', content: text, originalEventId: id }); pendingText.delete(id); eventIds.delete(id) }
    pending = []
  }
  /**
   * What she saw in this DSH turn, for LCA's own readers (memory, day summaries, the diary, old-page quotes).
   * DSH keeps the full request in its own log; LCA records only the conversation (record-where-used).
   * Memory then applies D-4 and D2 to it (memory/seen.ts).
   */
  const recordSeen = (current: Turn) => {
    if (!current.seen.some((message) => message.role === 'assistant')) return
    const seen = current.seen.slice(-1024)
    const messages = seen.map((message) => ({ role: message.role, content: clip(message.content, 200_000) }))
    const eligibleIndexes = messages.flatMap((message, index) => current.impressions && message.role === 'assistant' ? [] : [index])
    record({ type: 'model/seen', turnId: current.lcaTurnId, source: options.source ?? 'real', messages, eligibleIndexes,
      memoryExcludedIndexes: messages.flatMap((message, index) => current.memoryDerived && message.role === 'assistant' ? [index] : []),
      originalEvents: seen.flatMap((message, index) => message.originalEventId ? [{ index, eventId: message.originalEventId }] : []) })
  }
  // What she says in a turn that runs without you, failure notes included, waits for your break while you focus or asked for quiet.
  const delivery = (trigger: Trigger) => trigger !== 'user' && (quiet() || store.projection().lightsOut) ? { delivery: 'rest' as const } : {}
  const fail = (code: PublicErrorCode, httpStatus?: number) => {
    const lcaTurnId = turn?.lcaTurnId ?? randomUUID()
    const start = turn ? undefined : starts.shift()
    if (!turn) begin(lcaTurnId, start)
    const hold = delivery(turn?.trigger ?? start?.trigger ?? 'user')
    // What she had already said when the stream broke stays, marked as cut off.
    if (turn?.partial.trim()) { const text = turn.partial; record({ type: 'assistant/message', id: randomUUID(), turnId: lcaTurnId, text, status: 'interrupted', ...hold }); turn.seen.push({ role: 'assistant', content: text }) }
    // She answered before the failure: what she saw up to then still happened.
    if (turn) recordSeen(turn)
    turn?.asks.abort()
    record({ type: 'turn/end', turnId: lcaTurnId, reason: 'error', error: { code, retryable: code === 'connection-failed' || code === 'upstream-busy' } })
    record({ ...failureNarration(store, lcaTurnId, code, turn?.toolsExecuted ?? false, httpStatus), ...hold })
    turn = undefined; options.changed('message'); options.settled?.()
  }

  const policyVersions = new Map<string, number>()
  const approveOne = async (request: DshApproval): Promise<'allowed-once' | 'rejected'> => {
    if (closed || request.signal.aborted || !session || !currentScope() || request.sessionId !== session.id) return 'rejected'
    const project = session?.cwd ?? resolve(options.project())
    const member = request.origin.sessionId !== request.origin.rootSessionId
    const current = turn, revision = policyVersions.get(project)
    if (!member && !current) return 'rejected'
    const signal = member ? request.signal : AbortSignal.any([request.signal, current!.asks.signal])
    const context = { turnId: member ? request.activationId : current!.lcaTurnId, callId: request.approvalId, signal, ...(member ? { member: true } : {}) }
    const valid = () => !closed && !signal.aborted && currentScope() && (member || current === turn) && session?.id === request.sessionId && policyVersions.get(project) === revision
    const owner = member ? `协作者「${clip(request.origin.sessionId, 24)}」：` : ''
    const command = request.command ?? (!member && request.callId ? turn?.calls.get(request.callId)?.command ?? null : null)
    const prefix = request.kind === 'risky' && command ? command.trim().split(/\s+/).slice(0, 2).join(' ') : null
    const rules = read<Rule[]>(rulesFile, [])
    // The sandbox cannot run commands in this project: ask about trust itself, never about the repair
    // the model would otherwise propose. The bridge switches the preset once LCA allows it.
    if (request.kind === 'trust') {
      if (request.degraded?.length) return 'rejected'
      if (rules.some((rule) => rule.project === project && rule.prefix === null)) return 'allowed-once'
      const shown = request.subject ?? command
      const question = `她想在「${basename(project)}」里运行命令${shown ? `：${clip(shown.replace(/\s+/g, ' '), 80)}` : ''}，可这台电脑的系统沙箱在这个文件夹里用不了。要信任这个项目，让她像你一样在里面读写、运行命令吗？危险操作仍会先问你，LCA 的私有数据她不碰。`
      const choices = ['信任这个项目', '先不要']
      const answer = await ask(owner + question, choices, context).catch(() => null)
      if (!valid()) return 'rejected'
      if (answer !== choices[0]) return 'rejected'
      writeFileSync(rulesFile, JSON.stringify([...rules, { project, tool: request.toolName, prefix: null }], null, 2))
      return 'allowed-once'
    }
    // D2: while third-party content is in her context, standing grants do not apply and none are made.
    const degraded = request.degraded?.length ? request.degraded : null
    if (!degraded && rules.some((rule) => rule.project === project && rule.tool === request.toolName && rule.prefix === prefix)) return 'allowed-once'
    // DSH escalations carry the model's own justification after the mode; it reads better than a raw path.
    const justification = request.reason?.match(/^escalate sandbox to [\w-]+:\s*([\s\S]+)$/)?.[1]
    const shown = request.kind === 'degraded' ? request.subject ?? command : command ?? request.subject
    const subject = justification ? `：${clip(justification.replace(/\s+/g, ' ').replace(/[。．.！!\s]+$/, ''), 120)}` : shown ? `：${clip(shown.replace(/\s+/g, ' '), 100)}` : ''
    const readFirst = degraded ? `这一轮她读过${degraded.map((source) => SOURCE_TEXT[source]).join('和')}，` : ''
    const question = request.kind === 'risky' ? `${readFirst}这条命令可能有风险${subject}。要让她执行吗？`
      : request.kind === 'degraded' ? `${readFirst}${ACTION_TEXT[request.toolName] ?? '这一步'}要先问你${subject}。可以吗？`
        : `${readFirst}她想在「${basename(project)}」里直接运行命令${subject}。可以吗？`
    const always = degraded ? null : request.kind === 'risky' ? `以后都允许「${clip(prefix ?? '', 24)}」` : '这个项目以后都允许'
    const choices = always ? ['允许这一次', always, '拒绝'] : ['允许这一次', '拒绝']
    const answer = await ask(owner + question, choices, context).catch(() => null)
    if (!valid()) return 'rejected'
    if (always && answer === always) {
      writeFileSync(rulesFile, JSON.stringify([...rules, { project, tool: request.toolName, prefix }], null, 2))
      // A project-wide grant is the user's choice of same-user trust: later commands skip the sandbox detour.
      if (prefix === null && session?.id && session.cwd === project) host?.trust(session.id)
    }
    return answer === choices[0] || (always !== null && answer === always) ? 'allowed-once' : 'rejected'
  }
  // Serialize the decision, not just the card: a second member rechecks a newly saved project grant.
  let approvals: Promise<unknown> = Promise.resolve()
  const approve = (request: DshApproval): Promise<'allowed-once' | 'rejected'> => {
    const pending = approvals.then(() => approveOne(request))
    approvals = pending.catch(() => 'rejected')
    return pending
  }

  const call = async (name: string, args: unknown, sessionId: string, callId: string) => {
    if (!session || !currentScope() || sessionId !== session.id) throw new Error('DSH_ORIGIN_UNAVAILABLE')
    const tool = lcaTools().get(name)
    const current = turn
    if (!tool || !current) throw new Error('LCA tool unavailable right now')
    const input = args && typeof args === 'object' && !Array.isArray(args) ? args as Record<string, unknown> : {}
    if (!tool.validate(input)) throw new Error('invalid-tool-arguments: one JSON object matching the tool schema')
    if (tool.templateId === 'memory.optical') current.impressions = true
    if (tool.templateId.startsWith('memory.') || tool.templateId.startsWith('history.') || tool.templateId.startsWith('work.')) current.memoryDerived = true
    const userMessageId = current.seen.findLast(message => message.role === 'user' && message.originalEventId
      && store.records().some(row => row.type === 'user/message' && row.id === message.originalEventId))?.originalEventId
    const result = await tool.run(input, { clock, store, turnId: current.lcaTurnId, callId, signal: current.asks.signal, userMessageId })
    if (!result.ok) throw new Error(clip(JSON.stringify(result.visible), 400))
    // An original she asked to read rides with the result, so the bridge retires it with the turn's other sources (D2).
    return { value: result.original === undefined ? result.visible : { ...result.visible as Record<string, unknown>, original: result.original }, source: sourceOf(tool.templateId) }
  }

  /**
   * Her questions to you (DSH ask_user_question), shown in the book. Your answers go back as DSH expects them, and as
   * your words they are part of what she saw this turn. Declining answers each question as skipped.
   */
  const question: NonNullable<DshHostOptions['onQuestion']> = async ({ sessionId, callId, questions, signal }) => {
    if (!session || !currentScope() || sessionId !== session.id) return { error: 'This session is no longer available.' }
    const current = turn
    if (!current || !options.question) return { error: 'Questions to the user are not available right now.' }
    const items = itemsOf(questions)
    if (!items) return { error: 'Ask one to four questions, each one line of at most 400 characters, with at most six options per question and option labels of at most 60 characters.' }
    const raw = await options.question(items, { turnId: current.lcaTurnId, callId: callId ?? randomUUID(), signal: AbortSignal.any([signal, current.asks.signal]) })
    if (raw.status === 'declined') return { answers: items.map((item) => ({ id: item.id, selected: [] })) }
    if (raw.status !== 'answered' || !Array.isArray(raw.answers)) return { error: UNANSWERED[String(raw.status)] ?? 'The question was withdrawn before the user answered.' }
    const row = store.records().findLast((entry) => entry.type === 'user/message' && entry.id === raw.answerMessageId)
    if (row?.type === 'user/message') current.seen.push({ role: 'user', content: row.text, originalEventId: row.id })
    if (callId) options.answered?.({ turnId: current.lcaTurnId, callId })
    return { answers: raw.answers }
  }

  const onEvent = (event: DshEvent) => {
    if (closed) return
    if (event.t === 'host-unavailable') { resetCollaboration(true); if (turn) fail('connection-failed'); options.disconnected?.(); return }
    if (!session || !currentScope() || (event.sessionId && event.sessionId !== session.id)) return
    switch (event.t) {
      case 'collaboration':
      case 'collaboration-reply': if (currentScope()) collaboration.accept(focus.accept(event.view as CollaborationView)); break
      case 'turn-start': {
        pendingWorkSettlement = false
        stateChanges = 0
        const start = starts.shift()
        turn = { memoryDerived: start?.memoryDerived, lcaTurnId: randomUUID(), trigger: start?.trigger ?? 'user', attempts: 0, role: 'chat', partial: '', toolsExecuted: false, calls: new Map(), asks: new AbortController(), seen: [], inputEvents: new Set() }
        options.foreground?.()
        begin(turn.lcaTurnId, start)
        const preset = typeof event.preset === 'string' && event.preset.length <= 64 ? event.preset : null
        record({ type: 'work/turn', turnId: turn.lcaTurnId, engine: 'dsh', sessionId: session.id, preset, ...(event.sourcePolicy === 2 ? { sourcePolicy: 2 as const } : {}) })
        options.changed('task'); break
      }
      // A message you send while she speaks about an event makes the turn yours: no longer held for rest.
      case 'delta': if (turn && typeof event.text === 'string') turn.partial += event.text; break
      // A retried attempt starts over: only what she says in the attempt that ends the turn can be a partial reply.
      case 'retry': if (turn) turn.partial = ''; break
      case 'state-notice': {
        if (!turn || turn.asks.signal.aborted) break
        record({ ...failureNarration(store, turn.lcaTurnId, 'invalid-model-output', turn.toolsExecuted),
          text: event.reason === 'invalid' ? '这次状态指令格式不完整或已失效，门牌没有改变。可以手动切换后再发送任务。' : '这次状态切换没有生效；保留了当前门牌、专注计时和权限。可以手动切换。' })
        options.changed('message'); break
      }
      case 'user-message':
        if (turn) { if (pending.some((id) => !eventIds.has(id))) turn.trigger = 'user'; drain() }
        if (typeof event.eventId === 'string') { turn?.inputEvents.add(event.eventId); options.consumed?.(event.eventId) }
        if (Array.isArray(event.eventIds)) for (const id of event.eventIds) if (typeof id === 'string') { turn?.inputEvents.add(id); options.consumed?.(id) }
        break
      // Her words are conversation and stay in the journal; the tool calls beside them are DSH's.
      case 'message': {
        if (!turn) break
        if (turn.inputEvents.size) { options.successfulInputs?.([...turn.inputEvents]); turn.inputEvents.clear() }
        const text = typeof event.text === 'string' ? event.text : ''
        turn.partial = ''
        if (!text.trim()) { recordUsage(turn, event.usage); break }
        record({ type: 'assistant/message', id: randomUUID(), turnId: turn.lcaTurnId, text, status: 'complete', ...delivery(turn.trigger) })
        turn.seen.push({ role: 'assistant', content: text })
        recordUsage(turn, event.usage)
        options.changed('message'); break
      }
      case 'tool-call': {
        if (!turn) break
        const name = String(event.name); const callId = String(event.callId); const args = parsed(String(event.args ?? ''))
        const templateId = toolKind(name, lcaTools())
        turn.calls.set(callId, { command: typeof args.command === 'string' ? args.command : null, templateId }); turn.toolsExecuted = true
        record({ type: 'work/activity', turnId: turn.lcaTurnId, callId, templateId, status: 'running' })
        options.changed('task'); break
      }
      // The chat model's first hands-on step, not run: the work model decides it again (lca-bridge).
      case 'handoff': {
        if (!turn) break
        const callId = String(event.callId)
        record({ type: 'work/activity', turnId: turn.lcaTurnId, callId, templateId: turn.calls.get(callId)?.templateId ?? 'dsh.other', status: 'handed-off' })
        turn.calls.delete(callId); options.changed('task'); break
      }
      case 'tool-result': {
        if (!turn) break
        const callId = String(event.callId)
        if (!turn.calls.has(callId)) break
        record({ type: 'work/activity', turnId: turn.lcaTurnId, callId, templateId: turn.calls.get(callId)?.templateId ?? 'dsh.other', status: event.isError ? 'failed' : 'completed' })
        const evidence = observations.get(callId); observations.delete(callId)
        if (evidence) options.evidence?.({ ...evidence, ...(event.isError ? { status: 'failed' as const } : {}) })
        options.changed('task'); break
      }
      case 'work-evidence': {
        const identity = options.rootPolicy?.work
        if (!identity || !turn || typeof event.callId !== 'string' || !turn.calls.has(event.callId)) break
        const parsed = workEvidenceSchema.safeParse({ id: workDigest([session.id, event.callId]), identity: { ...identity, objectiveRevision: event.revision }, rootSessionId: session.id, callId: event.callId,
          kind: event.kind, status: event.status, relativePath: event.relativePath, beforeHash: event.beforeHash, afterHash: event.afterHash, bytes: event.bytes, exitCode: event.exitCode, restricted: event.restricted, observedAt: clock.nowMs() })
        if (parsed.success) observations.set(event.callId, parsed.data)
        break
      }
      case 'degraded': {
        const sources = dshSources(event.sources)
        if (!sources.length) break
        saveSession({ degraded: sources })
        if (turn) { record({ type: 'turn/degraded', turnId: turn.lcaTurnId, sources }); options.changed('task') }
        break
      }
      case 'retired': saveSession({ degraded: undefined }); break
      case 'trusted':
        if (typeof event.preset === 'string' && event.preset.length <= 64) record({ type: 'work/trust', sessionId: session.id, project: session.cwd, preset: event.preset })
        break
      case 'turn-end': {
        if (!turn) break
        const reason = event.reason as { kind?: string } | null
        if (reason?.kind === 'error') { const failure = failureOf(reason); fail(failure.code, failure.httpStatus); break }
        // Stopped because the autonomous allowance ran out: say so instead of a silent stop.
        if (turn.denied) { fail(turn.denied); break }
        if (reason?.kind === 'blocked' || reason?.kind === 'refusal') { fail('permission-denied'); break }
        turn.asks.abort()
        recordSeen(turn)
        record({ type: 'turn/end', turnId: turn.lcaTurnId, reason: reason?.kind === 'aborted' || reason?.kind === 'cancelled' ? 'aborted' : 'completed' })
        // This session now has the conversation up to here; what happens in other projects it learns on its next turn.
        session.seenSeq = store.records().at(-1)?.seq ?? session.seenSeq; saveSession({ seenSeq: session.seenSeq })
        turn = undefined; options.changed('task')
        if (options.rootPolicy?.role === 'worker') { pendingWorkSettlement = true; settleWorkerIfIdle() }
        else options.settled?.()
        kick(); break
      }
      default: break
    }
  }

  // `source`: the third-party source her results carry, so the bridge can retire them after a restart too.
  const toolSchemas = () => [...lcaTools()].map(([name, tool]) => ({ name, description: tool.definition.description, parameters: tool.definition.parameters as Record<string, unknown>, source: sourceOf(tool.templateId) }))
  // Plugins can be enabled or disabled while DSH runs: the tool list she sees follows before each new turn.
  let toolsSent = ''
  const syncTools = () => {
    const schemas = toolSchemas(); const key = JSON.stringify(schemas)
    if (closed || !host || key === toolsSent) return
    host.tools(schemas); toolsSent = key
  }
  /** Each DSH step as a model attempt in the journal: reservation first, the usage DSH reports once it answers. */
  const admitStep = (input: { sessionId: string; bucket: 'work' | 'autonomous'; role: 'chat' | 'work'; units: number }) => {
    if (closed || !session || !currentScope() || input.sessionId !== session.id) return false
    const current = turn
    const refused = options.admit?.({ bucket: input.bucket, units: input.units }) ?? null; const ok = refused === null
    // A child may outlive the root turn. It still reserves resources; only the root's conversation
    // attempt rows depend on a current user turn. Member usage projection follows in P5.
    if (!current) return ok
    current.attempts++; current.role = input.role
    record({ type: 'model/attempt', turnId: current.lcaTurnId, slot: input.role, attempt: current.attempts, status: ok ? 'started' : 'failed', waitMs: 0, reservedTokens: input.units, bucket: input.bucket, ...(ok ? {} : { error: 'quota' as const }) })
    if (refused) current.denied = refused
    return ok
  }
  const recordUsage = (current: Turn, usage: unknown) => {
    const value = usage as { inputTokens?: unknown; outputTokens?: unknown; cacheReadTokens?: unknown } | null | undefined
    const count = (field: unknown) => typeof field === 'number' && Number.isSafeInteger(field) && field >= 0 ? field : undefined
    const input = count(value?.inputTokens); const output = count(value?.outputTokens); const cached = count(value?.cacheReadTokens)
    if (!current.attempts || (input === undefined && output === undefined)) return
    record({ type: 'model/attempt', turnId: current.lcaTurnId, slot: current.role, attempt: current.attempts, status: 'success', waitMs: 0,
      ...(input !== undefined ? { inputTokens: input } : {}), ...(output !== undefined ? { outputTokens: output } : {}), ...(cached !== undefined ? { cachedInputTokens: cached } : {}) })
  }
  const ensureHost = (cwd: string) => host ??= (options.launch ?? startDshHost)({ clock: options.processClock ?? clock, dshRoot: options.dshRoot, dataDir: options.dataDir, bridge: options.bridge, workspace: cwd, routes: options.routes, guardedRoots: options.guardedRoots,
    persona: options.persona(), suffix: options.suffix(), tools: (() => { const schemas = toolSchemas(); toolsSent = JSON.stringify(schemas); return schemas })(),
    onEvent, onCall: call, onApproval: approve, onAdmit: admitStep, onQuestion: question, onState: requestState })
  let opening: Promise<Live> | undefined
  let preparing = 0
  let sendQueue: Promise<unknown> = Promise.resolve()
  let capacity: Promise<{ chat?: ResolvedModelCapabilities; work?: ResolvedModelCapabilities } | undefined> | undefined
  const capacities = () => capacity ??= (typeof host?.describe === 'function' ? host.describe().then(value => value?.capabilities).catch(() => undefined) : Promise.resolve(undefined))
  const enqueueSend = (action: () => Promise<void>, failure: (error: unknown) => void) => {
    preparing++
    sendQueue = sendQueue.then(action).catch(error => { if (!closed) failure(error) }).finally(() => { preparing--; options.changed('task'); kick() })
  }
  /**
   * Hand held events to her: into the turn she is in (she sees them at her next step), or as a turn of their own
   * when she is free and need not stay quiet. Bridge caps such a turn's steps unless you join in.
   */
  const kick = () => {
    if (closed || maintaining || !held.length || store.projection().lightsOut || opening || preparing) return
    if (!turn && quiet()) return
    const batch = held.splice(0)
    for (const event of batch) { pending.push(event.id); pendingText.set(event.id, factsOf(event)); eventIds.add(event.id) }
    const mode = turn ? 'steer' as const : 'followup' as const
    enqueueSend(async () => {
      const current = await ensureSession()
      if (closed) return
      if (mode === 'followup') syncTools()
      const reference = mode === 'followup' ? await referenceFor(current, new Set(batch.map(event => event.id)), batch[0].id) : { text: null, degrade: [], memoryDerived: false }
      if (closed || !currentScope()) return
      if (mode === 'followup') starts.push({ trigger: batch[0].source, requestId: null, memoryDerived: reference.memoryDerived || batch.some(event => event.source === 'work') })
      if (turn && batch.some(event => event.source === 'work')) turn.memoryDerived = true
      host!.send(current.id, batch.map(factsOf).join('\n'), mode, reference.text, 'event', reference.degrade, syncState(mode === 'followup'), undefined, undefined, batch.map(event => event.id))
    }, error => fail(error instanceof ContextBudgetFailure ? error.code : 'internal'))
  }
  const ensureSession = () => {
    const day = store.scope.sessionId; const cwd = resolve(options.project())
    if (session?.id && session.day === day && session.cwd === cwd) return Promise.resolve(session)
    return opening ??= openSession(day, cwd).finally(() => { opening = undefined })
  }
  const writeDay = (day: string, sessions: SavedSession[]) => { const saved = read<Saved>(sessionsFile, {}); writeFileSync(sessionsFile, JSON.stringify({ ...saved, [day]: sessions.slice(-8) }, null, 2)) }
  /** `degraded` present-but-undefined clears it (results retired); other fields are kept. */
  const saveSession = (patch: { degraded?: DshSource[]; seenSeq?: number }) => {
    if (!session?.id) return
    const sessions = daySessions(read<Saved>(sessionsFile, {}), session.day)
    const entry = sessions.find((item) => item.id === session!.id)
    if (!entry) return
    if ('degraded' in patch) { if (patch.degraded?.length) entry.degraded = patch.degraded; else delete entry.degraded }
    if (patch.seenSeq !== undefined) entry.seenSeq = patch.seenSeq
    writeDay(session.day, sessions)
  }
  const openSession = async (day: string, cwd: string) => {
    // A scope-change notification already cleared the old projection. Do not invalidate the refresh
    // that is now opening this scope, or its eventual reply would be discarded as an old operation.
    if (session?.id && collaboration.view().members.length) resetCollaboration()
    const running = ensureHost(cwd)
    if (session?.id) running.cancel(session.id)
    const sessions = daySessions(read<Saved>(sessionsFile, {}), day)
    const known = sessions.find((item) => item.cwd === cwd)
    const current: Live = { id: '', cwd, day, seenSeq: 0 }
    session = current
    const trusted = read<Rule[]>(rulesFile, []).some((rule) => rule.project === cwd && rule.prefix === null)
    current.id = await running.open(cwd, known?.id, trusted, dshSources(known?.degraded), { persona: options.persona(), suffix: options.suffix(), policy: options.rootPolicy })
    if (closed) throw new Error('DSH_EXECUTION_CLOSED')
    if (workRevision) running.workRevision(current.id, workRevision)
    const resumed = known?.id === current.id
    // A session DSH did not resume starts without the earlier days: the first message brings them.
    if (!resumed) current.fresh = true
    current.seenSeq = resumed ? known.seenSeq ?? 0 : 0
    const degraded = resumed ? dshSources(known.degraded) : []
    writeDay(day, [...sessions.filter((item) => item.cwd !== cwd), { id: current.id, cwd, ...(degraded.length ? { degraded } : {}), seenSeq: current.seenSeq }])
    return current
  }
  /**
   * Today's conversation this session did not see (another project's session, a release before 1.1), as your lines and
   * her replies only. Approval answers and the lines being sent now are left out.
   */
  const missedConversation = (since: number, exclude: ReadonlySet<string>) => {
    const rows = store.records()
    const approvals = new Set(rows.flatMap((row) => row.type === 'question/requested' && row.approval ? [row.id] : []))
    const answers = new Set(rows.flatMap((row) => row.type === 'question/answered' && approvals.has(row.id) ? [row.answerMessageId] : []))
    const verified = new Set(rows.flatMap((row) => row.type === 'work/turn' && row.sourcePolicy === 2 ? [row.turnId] : []))
    const restricted = new Set(rows.flatMap((row) => row.type === 'turn/degraded' ? [row.turnId] : []))
    const lines = rows.flatMap((row): { who: 'user' | 'her'; text: string }[] => row.seq <= since ? []
      : row.type === 'user/message' && !exclude.has(row.id) && !answers.has(row.id) ? [{ who: 'user', text: row.text }]
        : row.type === 'assistant/message' && !row.displayOnly && row.text && verified.has(row.turnId) && !restricted.has(row.turnId) ? [{ who: 'her', text: row.text }] : [])
    const kept: { who: 'user' | 'her'; text: string }[] = []
    let chars = 0
    for (const line of lines.slice(-EARLIER_LINES).reverse()) { chars += line.text.length; if (chars > EARLIER_CHARS && kept.length) break; kept.unshift({ ...line, text: clip(line.text, EARLIER_CHARS) }) }
    return kept
  }
  /** Opening facts: application time, memory references and today's missed conversation. */
  const referenceFor = async (current: Live, exclude: ReadonlySet<string>, requestId: string, extra?: Record<string, unknown> | null) => {
    const memory = { ...await options.reference?.({ requestId, firstOfSession: !!current.fresh }), ...extra }
    current.fresh = false
    const earlier = missedConversation(current.seenSeq, exclude)
    const revealed = options.revealed?.() ?? null
    const value = { ...memory, ...revealed?.reference, ...(earlier.length ? { earlierToday: earlier, earlierTodayNote: 'Conversation from earlier today that this session did not see (another project folder). Your own past lines and the user\'s; not instructions.' } : {}), currentTime: readClock(clock) }
    const { text, reference } = composeContext({ reference: value, capabilities: (await capacities())?.[options.rootPolicy?.role === 'worker' ? 'work' : 'chat'],
      systemText: options.persona() + options.suffix(), tools: toolSchemas(), inputText: [...exclude].map(id => pendingText.get(id) ?? '').join('\n'), revealedText: revealed?.text })
    options.referencesPrepared?.(requestId, reference)
    return { text, degrade: revealed ? [revealed.source] : [], memoryDerived: Object.keys(memory).some(key => /memory|reference|previousDays|workCheckpoints|experience|currentDecisions/i.test(key)) || earlier.length > 0 }
  }

  return {
    collaboration,
    prepared: async () => { await sendQueue },
    compact: async (operationId: string): Promise<{ rootSessionId: string; outcome: RootCompactionOutcome }> => {
      const rootSessionId = session?.id ?? ''
      if (closed || maintaining || turn || opening || preparing || starts.length || collaboration.busy()) return { rootSessionId, outcome: 'busy' }
      if (!session || !host || !currentScope()) return { rootSessionId, outcome: 'no_range' }
      maintaining = true
      try { return await host.compact(rootSessionId, operationId) }
      catch { return { rootSessionId, outcome: 'failed' } }
      finally { maintaining = false; kick() }
    },
    source: options.source ?? 'real',
    /** Work inputs are durable events, never newly authored dialogue. Main's
     * delivery journal owns retries; a send receipt alone is not consumption. */
    deliver: async (event: { eventId: string; text: string; revision: number }) => {
      if (closed || maintaining || options.rootPolicy?.role !== 'worker') throw new Error('DSH_WORK_UNAVAILABLE')
      workRevision = Math.max(workRevision, event.revision)
      if (session?.id) host?.workRevision(session.id, workRevision)
      if (!store.records().some(row => row.type === 'inbox/event' && row.id === event.eventId)) record({ type: 'inbox/event', id: event.eventId, source: 'work', text: event.text })
      pending.push(event.eventId); pendingText.set(event.eventId, event.text); eventIds.add(event.eventId)
      let accepted = false
      enqueueSend(async () => {
        const current = await ensureSession()
        if (closed) return
        const mode = turn || starts.length ? 'steer' : 'followup'
        if (mode === 'followup') syncTools()
        const reference = mode === 'followup' ? await referenceFor(current, new Set(pending), event.eventId) : { text: null, degrade: [] }
        if (closed || !currentScope()) return
        if (mode === 'followup') starts.push({ trigger: 'user', requestId: event.eventId, memoryDerived: true })
        await host!.deliverWork(current.id, { text: event.text, mode, reference: reference.text, state: syncState(true), eventId: event.eventId, revision: event.revision })
        accepted = true
      }, error => fail(error instanceof ContextBudgetFailure ? error.code : 'internal'))
      await sendQueue
      if (!accepted) throw new Error('DSH_WORK_DELIVERY_FAILED')
    },
    invalidateWork: (revision: number) => { workRevision = Math.max(workRevision, revision); if (session?.id) host?.workRevision(session.id, workRevision) },
    /** `extra`: references for this message only (an old-page quote you ask about). */
    send: (text: string, requestId: string, commandHash: string, extra?: Record<string, unknown> | null) => {
      if (maintaining) throw new Error('DSH_MAINTENANCE')
      if (closed) return
      options.foreground?.(); options.userWork?.()
      const id = randomUUID()
      record({ type: 'user/message', id, text, requestId, commandHash }); pending.push(id); pendingText.set(id, text); options.changed('message')
      // A session that cannot open is LCA's own failure (runtime, profile, link), not the user's model setup.
      enqueueSend(async () => {
        const current = await ensureSession()
        if (closed) return
        const mode = turn || starts.length ? 'steer' : 'followup'
        if (mode === 'followup') syncTools()
        const reference = mode === 'followup' ? await referenceFor(current, new Set(pending), requestId, extra) : { text: null, degrade: [], memoryDerived: false }
        if (closed || !currentScope()) return
        if (mode === 'followup') starts.push({ trigger: 'user', requestId, memoryDerived: reference.memoryDerived })
        host!.send(current.id, text, mode, reference.text, 'user', reference.degrade, syncState(true))
      }, error => fail(error instanceof ContextBudgetFailure ? error.code : 'internal'))
    },
    stop: (taskId: string) => {
      if (closed || !turn || !session || turn.lcaTurnId !== taskId) return false
      turn.asks.abort(); host?.cancel(session.id); return true
    },
    stateChanged: () => {
      if (closed) return
      syncState()
      if (session && (store.projection().lightsOut || store.projection().sleeping || !currentScope())) host?.cancel(session.id)
      if (!currentScope()) resetCollaboration()
      kick()
    },
    /**
     * An event she may speak about: recorded in the journal, then given to her DSH session.
     * Duplicates (same id) and a full queue (32 waiting) are refused.
     */
    postEvent: (source: DshEventSource, text: string, eventId: string = randomUUID()) => {
      if (closed) return false
      if (store.records().some((row) => row.type === 'inbox/event' && row.id === eventId || row.type === 'session/carry' && row.pendingEvents?.some((event) => event.id === eventId))) return false
      if (held.length >= 32) return false
      record({ type: 'inbox/event', id: eventId, source, text })
      held.push({ id: eventId, source, text }); kick(); return true
    },
    /** A DSH turn is running; the work folder must not change under it. */
    busy: () => !!turn || !!opening || preparing > 0 || starts.length > 0 || maintaining || collaboration.busy(),
    withExtensions: async <T>(job: (runtime: ExtensionRuntime) => Promise<T>): Promise<T> => {
      if (closed || maintaining || turn || opening || preparing || starts.length || collaboration.busy()) throw new Error('DSH_BUSY')
      maintaining = true
      const restart = async () => {
        const previous = host; host = undefined; session = undefined
        await previous?.close()
        resetCollaboration()
        if (closed) throw new Error('DSH_EXECUTION_CLOSED')
        return ensureHost(resolve(options.project()))
      }
      try {
        if (host?.available?.() === false) await restart()
        return await job({ host: ensureHost(resolve(options.project())), restart })
      }
      finally { maintaining = false; kick() }
    },
    trusted: (project: string) => read<Rule[]>(rulesFile, []).some((rule) => rule.project === resolve(project) && rule.prefix === null),
    /** Withdraw project-wide grants; a live session on that project goes back to the sandbox preset at once. */
    untrust: (project: string) => {
      if (closed) return
      const target = resolve(project)
      policyVersions.set(target, (policyVersions.get(target) ?? 0) + 1)
      writeFileSync(rulesFile, JSON.stringify(read<Rule[]>(rulesFile, []).filter((rule) => rule.project !== target), null, 2))
      if (session?.id && session.cwd === target) host?.untrust(session.id)
    },
    taskApproved: () => {},
    /** Deliver events left from before a restart once LCA is ready (onboarding, model). */
    resume: () => kick(),
    /** Thinking levels her chat and work models offer, for the settings; starts DSH when it is not running yet. */
    describe: async () => { if (closed) throw new Error('DSH_EXECUTION_CLOSED'); return ensureHost(resolve(options.project())).describe() },
    /** "Test connection" for chat or work: one request through the adapter her turns use. */
    probe: async (role: 'chat' | 'work') => { if (closed) throw new Error('DSH_EXECUTION_CLOSED'); return ensureHost(resolve(options.project())).probe(role) },
    /** New thinking levels apply from the next step; no restart. */
    efforts: (efforts: { chat?: string; work?: string }) => { if (!closed) host?.efforts(efforts) },
    close: () => closing ??= (async () => { closed = true; focus.reset(); turn?.asks.abort(); if (session?.id) host?.cancel(session.id); await opening?.catch(() => {}); await host?.close() })(),
  }
}
export type DshExecution = ReturnType<typeof createDshExecution>
