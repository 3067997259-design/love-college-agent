import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import type { AppEvent, PublicErrorCode } from '../../shared'
import type { Clock } from '../clock'
import { failureNarration } from '../harness/failure'
import type { HarnessTool } from '../harness/tools'
import type { JournalInput } from '../journal/schema'
import type { SessionStore } from '../store/session'
import { startDshHost, type DshApproval, type DshEvent, type DshHost, type DshRoute } from './host'

type Turn = { lcaTurnId: string; toolsExecuted: boolean; calls: Map<string, { atMs: number; command: string | null }>; asks: AbortController }
type Rule = { project: string; tool: string; prefix: string | null }
const LCA_PREFIX = 'lca_'
const TEMPLATES: Record<string, string> = { read: 'dsh.read', read_image: 'dsh.read', working_directory: 'dsh.read', write: 'dsh.write', edit: 'dsh.edit', glob: 'dsh.search', grep: 'dsh.search',
  pwsh: 'dsh.shell', bash: 'dsh.shell', job_output: 'dsh.shell', job_list: 'dsh.shell', job_kill: 'dsh.shell', web_search: 'dsh.web', web_fetch: 'dsh.web', todo_write: 'dsh.plan',
  get_goal: 'dsh.plan', create_goal: 'dsh.plan', update_goal: 'dsh.plan', exit_plan_mode: 'dsh.plan', skill: 'dsh.skill', subagent: 'dsh.agent', subagent_fork: 'dsh.agent',
  send_message: 'dsh.agent', list_agents: 'dsh.agent', interrupt_agent: 'dsh.agent', workflow: 'dsh.agent' }
const clip = (text: string, max: number) => (text.length > max ? text.slice(0, max) + '…' : text)
const safeName = (name: string) => name.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64) || 'tool'
const parsed = (raw: string): Record<string, unknown> => { try { const value: unknown = JSON.parse(raw); return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {} } catch { return {} } }
// The book keeps short, readable arguments; file bodies stay in DSH's own session log.
const compact = (args: Record<string, unknown>) => Object.fromEntries(['file_path', 'path', 'pattern', 'command', 'description', 'url', 'query']
  .flatMap((key) => typeof args[key] === 'string' ? [[key, clip(args[key] as string, key === 'command' ? 500 : 200)]] : []))
const failureCode = (reason: unknown): PublicErrorCode => {
  const code = String((reason as { error?: { code?: unknown } } | null)?.error?.code ?? '')
  if (code === 'QUOTA') return 'quota-exhausted'
  if (code === 'RATE_LIMIT') return 'upstream-busy'
  if (/CREDENTIAL|UNKNOWN_MODEL/.test(code)) return 'configuration-failed'
  return 'connection-failed'
}

/**
 * DSH execution port (spike, LCA_DSH=1). The user's messages go to her DSH session for the day and
 * DSH activity is written into the LCA journal with the record types the book already renders. A
 * message sent while a DSH turn runs steers it instead of queueing a separate turn. Approvals use the
 * book's question card; "以后都允许" is remembered per project (and per command prefix for risky ones).
 */
export function createDshExecution(options: {
  store: SessionStore; clock: Clock; dataDir: string; dshRoot: string; bridge: string; route: DshRoute; guardedRoots: readonly string[]
  project(): string; persona(): string; suffix(): string; tools(): readonly HarnessTool[]
  ask(question: string, choices: string[], context: { turnId: string; callId: string; signal: AbortSignal }): Promise<string | null>
  changed(reason: AppEvent['reason']): void
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
    if (rules.some((rule) => rule.project === project && rule.tool === request.toolName && rule.prefix === prefix)) return 'allowed-once'
    const current = turn
    if (!current) return 'rejected'
    // DSH escalations carry the model's own justification after the mode; it reads better than a raw path.
    const justification = request.reason?.match(/^escalate sandbox to [\w-]+:\s*([\s\S]+)$/)?.[1]
    const subject = justification ? `：${clip(justification.replace(/\s+/g, ' ').replace(/[。．.！!\s]+$/, ''), 120)}` : command ? `：${clip(command.replace(/\s+/g, ' '), 100)}` : ''
    const question = request.kind === 'risky' ? `这条命令可能有风险${subject}。要让她执行吗？` : `她想在「${basename(project)}」里直接运行命令${subject}。可以吗？`
    const always = request.kind === 'risky' ? `以后都允许「${clip(prefix ?? '', 24)}」` : '这个项目以后都允许'
    const choices = ['允许这一次', always, '拒绝']
    const answer = await options.ask(question, choices, { turnId: current.lcaTurnId, callId: request.callId ?? randomUUID(), signal: current.asks.signal }).catch(() => null)
    if (answer === always) {
      writeFileSync(rulesFile, JSON.stringify([...rules, { project, tool: request.toolName, prefix }], null, 2))
      // A project-wide grant is the user's choice of same-user trust: later commands skip the sandbox detour.
      if (prefix === null && session?.id && session.cwd === project) host?.trust(session.id)
    }
    return answer === choices[0] || answer === always ? 'allowed-once' : 'rejected'
  }

  const call = async (name: string, args: unknown, _sessionId: string, callId: string) => {
    const tool = lcaTools().get(name)
    if (!tool || !turn) throw new Error('LCA tool unavailable right now')
    const input = args && typeof args === 'object' && !Array.isArray(args) ? args as Record<string, unknown> : {}
    if (!tool.validate(input)) throw new Error('invalid-tool-arguments: one JSON object matching the tool schema')
    const result = await tool.run(input, { clock, store, turnId: turn.lcaTurnId, callId, signal: turn.asks.signal })
    if (!result.ok) throw new Error(clip(JSON.stringify(result.visible), 400))
    return result.visible
  }

  const onEvent = (event: DshEvent) => {
    if (!session || (event.sessionId && event.sessionId !== session.id)) return
    switch (event.t) {
      case 'turn-start': {
        turn = { lcaTurnId: randomUUID(), toolsExecuted: false, calls: new Map(), asks: new AbortController() }
        record({ type: 'turn/start', turnId: turn.lcaTurnId, trigger: 'user' }); drain(); options.changed('task'); break
      }
      case 'user-message': if (turn) drain(); break
      case 'message': {
        if (!turn) break
        const calls = Array.isArray(event.toolCalls) ? (event.toolCalls as { id: string; name: string; arguments: string }[]).slice(0, 16) : []
        const text = typeof event.text === 'string' ? event.text : ''
        if (!text.trim() && !calls.length) break
        record({ type: 'assistant/message', id: randomUUID(), turnId: turn.lcaTurnId, text, status: 'complete',
          ...(calls.length ? { toolCalls: calls.map((item) => ({ id: item.id, name: safeName(item.name), arguments: clip(item.arguments, 64_000) })) } : {}) })
        options.changed('message'); break
      }
      case 'tool-call': {
        if (!turn) break
        const name = String(event.name); const callId = String(event.callId); const args = parsed(String(event.args ?? ''))
        const lca = lcaTools().get(name)
        turn.calls.set(callId, { atMs: clock.nowMs(), command: typeof args.command === 'string' ? args.command : null }); turn.toolsExecuted = true
        record({ type: 'tool/call', turnId: turn.lcaTurnId, callId, name: safeName(name), arguments: lca ? JSON.parse(JSON.stringify(args)) : compact(args), templateId: lca?.templateId ?? TEMPLATES[name] ?? 'dsh.other' })
        options.changed('task'); break
      }
      case 'tool-result': {
        if (!turn) break
        const callId = String(event.callId); const ok = !event.isError; const text = String(event.text ?? '')
        record({ type: 'tool/result', turnId: turn.lcaTurnId, callId, ok, raw: { text: clip(text, 2_000) }, visible: ok ? { status: 'ok', text: clip(text, 600) } : { error: 'tool-failed', reason: clip(text, 400) },
          elapsedMs: Math.max(0, clock.nowMs() - (turn.calls.get(callId)?.atMs ?? clock.nowMs())) })
        options.changed('task'); break
      }
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
  const openSession = async (day: string, cwd: string) => {
    host ??= startDshHost({ clock, dshRoot: options.dshRoot, dataDir: options.dataDir, bridge: options.bridge, workspace: cwd, route: options.route, guardedRoots: options.guardedRoots,
      persona: options.persona(), suffix: options.suffix(), tools: [...lcaTools()].map(([name, tool]) => ({ name, description: tool.definition.description, parameters: tool.definition.parameters as Record<string, unknown> })),
      onEvent, onCall: call, onApproval: approve })
    const saved = read<Record<string, { id: string; cwd: string }>>(sessionsFile, {})
    const known = saved[day]?.cwd === cwd ? saved[day].id : undefined
    const current = { id: '', cwd, day }
    session = current
    const trusted = read<Rule[]>(rulesFile, []).some((rule) => rule.project === cwd && rule.prefix === null)
    current.id = await host.open(cwd, known, trusted)
    writeFileSync(sessionsFile, JSON.stringify({ ...saved, [day]: { id: current.id, cwd } }, null, 2))
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
