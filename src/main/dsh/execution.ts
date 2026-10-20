import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import type { AppEvent, PublicErrorCode } from '../../shared'
import type { Clock } from '../clock'
import { failureNarration } from '../harness/failure'
import type { HarnessTool } from '../harness/tools'
import type { JournalInput } from '../journal/schema'
import type { SessionStore } from '../store/session'
import { dshSources, startDshHost, type DshApproval, type DshEvent, type DshHost, type DshRoute, type DshSource } from './host'

type Turn = { lcaTurnId: string; toolsExecuted: boolean; calls: Map<string, { command: string | null; templateId: string }>; asks: AbortController }
type Rule = { project: string; tool: string; prefix: string | null }
/** One DSH session per LCA day; `degraded` survives a restart that came before the bridge retired third-party results. */
type Saved = Record<string, { id: string; cwd: string; degraded?: DshSource[] }>
const LCA_PREFIX = 'lca_'
const TEMPLATES: Record<string, string> = { read: 'dsh.read', read_image: 'dsh.read', working_directory: 'dsh.read', write: 'dsh.write', edit: 'dsh.edit', glob: 'dsh.search', grep: 'dsh.search',
  pwsh: 'dsh.shell', bash: 'dsh.shell', job_output: 'dsh.shell', job_list: 'dsh.shell', job_kill: 'dsh.shell', web_search: 'dsh.web', web_fetch: 'dsh.web', todo_write: 'dsh.plan',
  get_goal: 'dsh.plan', create_goal: 'dsh.plan', update_goal: 'dsh.plan', exit_plan_mode: 'dsh.plan', skill: 'dsh.skill', subagent: 'dsh.agent', subagent_fork: 'dsh.agent',
  send_message: 'dsh.agent', list_agents: 'dsh.agent', interrupt_agent: 'dsh.agent', workflow: 'dsh.agent' }
const clip = (text: string, max: number) => (text.length > max ? text.slice(0, max) + '…' : text)
const parsed = (raw: string): Record<string, unknown> => { try { const value: unknown = JSON.parse(raw); return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {} } catch { return {} } }
// LCA tools that hand her third-party originals, as in D2 (index.ts thirdPartySources).
const sourceOf = (templateId: string): DshSource | null => templateId.startsWith('mail.') ? 'mail' : templateId.startsWith('document.') ? 'document'
  : templateId.startsWith('student-hub.') ? 'plugin' : templateId.startsWith('mcp.') ? 'mcp' : null
const SOURCE_TEXT: Record<DshSource, string> = { web: '网页', mcp: '外部工具给的内容', mail: '邮件原文', document: '附件原文', plugin: '插件资料' }
const ACTION_TEXT: Record<string, string> = { write: '写文件', edit: '改文件', pwsh: '运行命令', bash: '运行命令', web_fetch: '再上网', web_search: '再上网' }
const failureCode = (reason: unknown): PublicErrorCode => {
  const code = String((reason as { error?: { code?: unknown } } | null)?.error?.code ?? '')
  if (code === 'QUOTA') return 'quota-exhausted'
  if (code === 'RATE_LIMIT') return 'upstream-busy'
  if (/CREDENTIAL|UNKNOWN_MODEL/.test(code)) return 'configuration-failed'
  return 'connection-failed'
}

/**
 * DSH execution port (spike, LCA_DSH=1). The user's messages go to her DSH session for the day. DSH's
 * own session log is the record of what she saw and did; the journal keeps what LCA owns: the
 * conversation, a reference to the DSH turn, the book's activity rows, approvals and trust grants.
 * Tool calls and results never enter LCA's model context or memory. A message sent while a DSH turn
 * runs steers it. Approvals use the book's question card; "以后都允许" is remembered per project (and
 * per command prefix for risky ones), except while third-party content is in her context (D2).
 */
export function createDshExecution(options: {
  store: SessionStore; clock: Clock; dataDir: string; dshRoot: string; bridge: string; route: DshRoute; guardedRoots: readonly string[]
  project(): string; persona(): string; suffix(): string; tools(): readonly HarnessTool[]
  ask(question: string, choices: string[], context: { turnId: string; callId: string; signal: AbortSignal }): Promise<string | null>
  changed(reason: AppEvent['reason']): void
  /** Test seam; production launches the DSH child process. */
  launch?: typeof startDshHost
}) {
  const { store, clock } = options
  const sessionsFile = join(options.dataDir, 'dsh-sessions.json')
  const rulesFile = join(options.dataDir, 'dsh-approvals.json')
  const read = <T>(file: string, fallback: T): T => { try { return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) as T : fallback } catch { return fallback } }
  const record = (input: JournalInput) => store.append(input)
  const lcaTools = () => new Map(options.tools().map((tool) => [LCA_PREFIX + tool.definition.name, tool]))
  let host: DshHost | undefined
  let session: { id: string; cwd: string; day: string } | undefined
  let turn: Turn | undefined
  let pending: string[] = []
  // The book shows one question at a time; concurrent approvals wait their turn instead of failing.
  let asking: Promise<unknown> = Promise.resolve()
  const ask: typeof options.ask = (question, choices, context) => {
    const next = asking.then(() => context.signal.aborted ? null : options.ask(question, choices, context))
    asking = next.catch(() => null)
    return next
  }

  const drain = () => { if (pending.length) { record({ type: 'inbox/drain', ids: pending }); pending = [] } }
  const fail = (code: PublicErrorCode) => {
    const lcaTurnId = turn?.lcaTurnId ?? randomUUID()
    if (!turn) { record({ type: 'turn/start', turnId: lcaTurnId, trigger: 'user' }); drain() }
    turn?.asks.abort()
    record({ type: 'turn/end', turnId: lcaTurnId, reason: 'error', error: { code, retryable: code === 'connection-failed' || code === 'upstream-busy' } })
    record(failureNarration(store, lcaTurnId, code, turn?.toolsExecuted ?? false))
    turn = undefined; options.changed('message')
  }

  const approve = async (request: DshApproval): Promise<'allowed-once' | 'rejected'> => {
    const project = session?.cwd ?? resolve(options.project())
    const command = request.command ?? (request.callId ? turn?.calls.get(request.callId)?.command ?? null : null)
    const prefix = request.kind === 'risky' && command ? command.trim().split(/\s+/).slice(0, 2).join(' ') : null
    const rules = read<Rule[]>(rulesFile, [])
    // The sandbox cannot run commands in this project: ask about trust itself, never about the repair
    // the model would otherwise propose. The bridge switches the preset once LCA allows it.
    if (request.kind === 'trust') {
      if (request.degraded?.length) return 'rejected'
      if (rules.some((rule) => rule.project === project && rule.prefix === null)) return 'allowed-once'
      const current = turn
      if (!current) return 'rejected'
      const shown = request.subject ?? command
      const question = `她想在「${basename(project)}」里运行命令${shown ? `：${clip(shown.replace(/\s+/g, ' '), 80)}` : ''}，可这台电脑的系统沙箱在这个文件夹里用不了。要信任这个项目，让她像你一样在里面读写、运行命令吗？危险操作仍会先问你，LCA 的私有数据她不碰。`
      const choices = ['信任这个项目', '先不要']
      const answer = await ask(question, choices, { turnId: current.lcaTurnId, callId: request.callId ?? randomUUID(), signal: current.asks.signal }).catch(() => null)
      if (answer !== choices[0]) return 'rejected'
      writeFileSync(rulesFile, JSON.stringify([...rules, { project, tool: request.toolName, prefix: null }], null, 2))
      return 'allowed-once'
    }
    // D2: while third-party content is in her context, standing grants do not apply and none are made.
    const degraded = request.degraded?.length ? request.degraded : null
    if (!degraded && rules.some((rule) => rule.project === project && rule.tool === request.toolName && rule.prefix === prefix)) return 'allowed-once'
    const current = turn
    if (!current) return 'rejected'
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
    const answer = await ask(question, choices, { turnId: current.lcaTurnId, callId: request.callId ?? randomUUID(), signal: current.asks.signal }).catch(() => null)
    if (always && answer === always) {
      writeFileSync(rulesFile, JSON.stringify([...rules, { project, tool: request.toolName, prefix }], null, 2))
      // A project-wide grant is the user's choice of same-user trust: later commands skip the sandbox detour.
      if (prefix === null && session?.id && session.cwd === project) host?.trust(session.id)
    }
    return answer === choices[0] || (always !== null && answer === always) ? 'allowed-once' : 'rejected'
  }

  const call = async (name: string, args: unknown, _sessionId: string, callId: string) => {
    const tool = lcaTools().get(name)
    if (!tool || !turn) throw new Error('LCA tool unavailable right now')
    const input = args && typeof args === 'object' && !Array.isArray(args) ? args as Record<string, unknown> : {}
    if (!tool.validate(input)) throw new Error('invalid-tool-arguments: one JSON object matching the tool schema')
    const result = await tool.run(input, { clock, store, turnId: turn.lcaTurnId, callId, signal: turn.asks.signal })
    if (!result.ok) throw new Error(clip(JSON.stringify(result.visible), 400))
    return { value: result.visible, source: sourceOf(tool.templateId) }
  }

  const onEvent = (event: DshEvent) => {
    if (!session || (event.sessionId && event.sessionId !== session.id)) return
    switch (event.t) {
      case 'turn-start': {
        turn = { lcaTurnId: randomUUID(), toolsExecuted: false, calls: new Map(), asks: new AbortController() }
        record({ type: 'turn/start', turnId: turn.lcaTurnId, trigger: 'user' }); drain()
        const preset = typeof event.preset === 'string' && event.preset.length <= 64 ? event.preset : null
        record({ type: 'work/turn', turnId: turn.lcaTurnId, engine: 'dsh', sessionId: session.id, preset })
        options.changed('task'); break
      }
      case 'user-message': if (turn) drain(); break
      // Her words are conversation and stay in the journal; the tool calls beside them are DSH's.
      case 'message': {
        if (!turn) break
        const text = typeof event.text === 'string' ? event.text : ''
        if (!text.trim()) break
        record({ type: 'assistant/message', id: randomUUID(), turnId: turn.lcaTurnId, text, status: 'complete' })
        options.changed('message'); break
      }
      case 'tool-call': {
        if (!turn) break
        const name = String(event.name); const callId = String(event.callId); const args = parsed(String(event.args ?? ''))
        const templateId = lcaTools().get(name)?.templateId ?? TEMPLATES[name] ?? 'dsh.other'
        turn.calls.set(callId, { command: typeof args.command === 'string' ? args.command : null, templateId }); turn.toolsExecuted = true
        record({ type: 'work/activity', turnId: turn.lcaTurnId, callId, templateId, status: 'running' })
        options.changed('task'); break
      }
      case 'tool-result': {
        if (!turn) break
        const callId = String(event.callId)
        record({ type: 'work/activity', turnId: turn.lcaTurnId, callId, templateId: turn.calls.get(callId)?.templateId ?? 'dsh.other', status: event.isError ? 'failed' : 'completed' })
        options.changed('task'); break
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
        if (reason?.kind === 'error') { fail(failureCode(reason)); break }
        turn.asks.abort()
        record({ type: 'turn/end', turnId: turn.lcaTurnId, reason: reason?.kind === 'cancelled' ? 'aborted' : 'completed' })
        turn = undefined; options.changed('task'); break
      }
      default: break
    }
  }

  let opening: Promise<{ id: string; cwd: string; day: string }> | undefined
  const ensureSession = () => {
    const day = store.scope.sessionId; const cwd = resolve(options.project())
    if (session?.id && session.day === day && session.cwd === cwd) return Promise.resolve(session)
    return opening ??= openSession(day, cwd).finally(() => { opening = undefined })
  }
  const saveSession = (patch: { degraded?: DshSource[] }) => {
    if (!session?.id) return
    const saved = read<Saved>(sessionsFile, {})
    if (saved[session.day]?.id !== session.id) return
    writeFileSync(sessionsFile, JSON.stringify({ ...saved, [session.day]: { id: session.id, cwd: session.cwd, ...(patch.degraded?.length ? { degraded: patch.degraded } : {}) } }, null, 2))
  }
  const openSession = async (day: string, cwd: string) => {
    host ??= (options.launch ?? startDshHost)({ clock, dshRoot: options.dshRoot, dataDir: options.dataDir, bridge: options.bridge, workspace: cwd, route: options.route, guardedRoots: options.guardedRoots,
      persona: options.persona(), suffix: options.suffix(), tools: [...lcaTools()].map(([name, tool]) => ({ name, description: tool.definition.description, parameters: tool.definition.parameters as Record<string, unknown> })),
      onEvent, onCall: call, onApproval: approve })
    const saved = read<Saved>(sessionsFile, {})
    const known = saved[day]?.cwd === cwd ? saved[day] : undefined
    const current = { id: '', cwd, day }
    session = current
    const trusted = read<Rule[]>(rulesFile, []).some((rule) => rule.project === cwd && rule.prefix === null)
    current.id = await host.open(cwd, known?.id, trusted, dshSources(known?.degraded))
    const degraded = known?.id === current.id ? dshSources(known.degraded) : []
    writeFileSync(sessionsFile, JSON.stringify({ ...saved, [day]: { id: current.id, cwd, ...(degraded.length ? { degraded } : {}) } }, null, 2))
    return current
  }

  return {
    source: 'real' as const,
    send: (text: string, requestId: string, commandHash: string) => {
      const id = randomUUID()
      record({ type: 'user/message', id, text, requestId, commandHash }); pending.push(id); options.changed('message')
      void ensureSession().then((current) => host!.send(current.id, text, turn ? 'steer' : 'followup'), () => fail('configuration-failed'))
    },
    stop: (taskId: string) => {
      if (!turn || !session || turn.lcaTurnId !== taskId) return false
      turn.asks.abort(); host?.cancel(session.id); return true
    },
    stateChanged: () => { if (store.projection().lightsOut && turn && session) host?.cancel(session.id) },
    taskApproved: () => {},
    close: async () => { await host?.close() },
  }
}
export type DshExecution = ReturnType<typeof createDshExecution>
