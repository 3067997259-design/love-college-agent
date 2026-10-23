import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { prepareDshProfile } from '../../../dsh/lca-bridge/profile.js'
export { prepareDshProfile, dshCli } from '../../../dsh/lca-bridge/profile.js'
import type { DshExtensionRequest, DshExtensionReply } from '../../shared/dsh-extensions'
import type { Clock } from '../clock'
import type { DshRoutes } from './routes'
import { createDshIdentities } from './identity'
import type { DshApprovalScope, DshOrigin } from '../../shared/dsh-protocol'

/**
 * DSH host launcher (spike). Runs the forked DSH runtime as an Electron-Node child with LCA's `lca`
 * profile and talks to its lca-bridge plugin over the IPC channel. Main supplies credentials through
 * the child environment only; the child gets an explicit environment, never main's whole one.
 */
export type DshEvent = { t: string; sessionId?: string; [key: string]: unknown }
export type DshTool = { name: string; description: string; parameters: Record<string, unknown>; source?: DshSource | null }
/** Third-party content kinds, as in D2's `turn/degraded`. */
export type DshSource = 'mail' | 'document' | 'web' | 'mcp' | 'plugin' | 'member'
const SOURCES: readonly DshSource[] = ['mail', 'document', 'web', 'mcp', 'plugin', 'member']
export const dshSources = (value: unknown): DshSource[] => Array.isArray(value) ? SOURCES.filter((source) => value.includes(source)) : []
/**
 * `degraded`: third-party content is in her context, so this approval may not create or apply standing grants.
 * `trust`: the OS sandbox cannot run commands in her project; asks whether to trust the project instead.
 */
export type DshApproval = DshApprovalScope & { signal: AbortSignal; sessionId: string; origin: DshOrigin; toolName: string; callId: string | null; reason: string | null; kind: 'risky' | 'escalation' | 'degraded' | 'trust'; command: string | null; subject: string | null; degraded: DshSource[] | null }
export interface DshHostOptions {
  /** Real time: it only times out a stalled shutdown. */
  clock: Clock; dshRoot: string; dataDir: string; bridge: string; workspace: string
  /** Her chat and work models (routes.ts); null keeps DSH's own default model. */
  routes: DshRoutes | null; guardedRoots: readonly string[]
  persona: string; suffix?: string; tools: readonly DshTool[]
  onEvent(event: DshEvent): void
  /** Before each model step of her family: may it run (resource ledger)? */
  onAdmit?(input: { sessionId: string; bucket: 'work' | 'autonomous'; role: 'chat' | 'work'; units: number }): boolean
  /** `source` marks a result carrying third-party content; the bridge then degrades the turn. */
  onCall(name: string, args: unknown, sessionId: string, callId: string): Promise<{ value: unknown; source: DshSource | null }>
  onApproval(request: DshApproval): Promise<'allowed-once' | 'rejected'>
  /**
   * Her questions to you (DSH ask_user_question) as DSH sent them. Answers, one per question, or why there are none
   * (a short English reason she reads). The signal aborts when DSH withdraws the question (her turn stopped).
   */
  onQuestion?(request: { sessionId: string; callId: string | null; questions: unknown; signal: AbortSignal }): Promise<{ answers: unknown[] } | { error: string }>
}

const INHERITED = ['SystemRoot', 'SYSTEMDRIVE', 'WINDIR', 'ComSpec', 'PATHEXT', 'Path', 'PATH', 'TEMP', 'TMP', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH',
  'APPDATA', 'LOCALAPPDATA', 'ProgramData', 'ProgramFiles', 'ProgramFiles(x86)', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'OS',
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'no_proxy', 'all_proxy']

export function startDshHost(options: DshHostOptions) {
  const { home, cli } = prepareDshProfile(options)
  mkdirSync(options.workspace, { recursive: true })
  const env: Record<string, string> = {}
  for (const key of INHERITED) if (process.env[key]) env[key] = process.env[key]!
  // DSH's native runtime hooks accept exact Electron builds only; LCA pins 44.7.0 to match. A system
  // Node can still host DSH for diagnosis (LCA_DSH_NODE).
  const runtime = process.env.LCA_DSH_NODE || process.execPath
  Object.assign(env, { DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1', LCA_GUARDED_ROOTS: options.guardedRoots.join(';'), LCA_PNPM_CLI: join(options.dshRoot, 'node_modules', 'pnpm', 'bin', 'pnpm.cjs'), ...options.routes?.env,
    ELECTRON_RUN_AS_NODE: '1' })
  const child = spawn(runtime, [cli, '--profile', 'lca'], { cwd: options.workspace, env, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] })
  // Never echo the child's stderr: provider errors can quote request details.
  child.stderr?.resume()
  const waiting = new Map<string, { done(value: Record<string, unknown>): void; fail(error: Error): void }>()
  const identities = createDshIdentities()
  const revisions = new Map<string, number>(), inactive = new Set<string>()
  const invalidate = (root: string) => { revisions.set(root, (revisions.get(root) ?? 0) + 1); inactive.add(root); cancelApprovals(root) }
  // Her questions waiting on your answer: DSH may withdraw one (her turn stopped) before you answer.
  const asking = new Map<string, AbortController>()
  const approving = new Map<string, { root: string; abort: AbortController }>()
  const cancelApprovals = (root?: string) => {
    for (const [id, entry] of approving) if (!root || entry.root === root) { entry.abort.abort(); approving.delete(id) }
  }
  let ready!: () => void
  let failed!: (error: Error) => void
  const started = new Promise<void>((resolve, reject) => { ready = resolve; failed = reject })
  const stopStartup = options.clock.after(30_000, () => { failed(new Error('DSH_STARTUP_TIMEOUT')); child.kill() })
  // A caller may close the host before awaiting its startup.
  void started.catch(() => {})
  let closed = false; let disconnected = false; let hasExited = false
  const unavailable = () => {
    const first = !disconnected
    disconnected = true
    identities.clear()
    const error = new Error('DSH_HOST_EXITED')
    stopStartup()
    failed(error)
    for (const entry of waiting.values()) entry.fail(error)
    waiting.clear()
    for (const abort of asking.values()) abort.abort()
    asking.clear()
    cancelApprovals()
    if (first) { try { options.onEvent({ t: 'host-unavailable' }) } catch { /* main may already be closing */ } }
  }
  const exited = new Promise<number | null>((resolve) => {
    const finish = (code: number | null) => { hasExited = true; unavailable(); resolve(code) }
    child.once('exit', finish)
    // A spawn failure emits close without exit; an IPC error alone does not prove the child stopped.
    child.once('close', finish)
  })
  child.on('error', unavailable)
  child.once('disconnect', unavailable)
  // connected can change between the check and send. The callback consumes asynchronous IPC errors too;
  // without it Node emits an unhandled 'error', which becomes a modal dialog in Electron's main process.
  const send = (command: Record<string, unknown>) => {
    if (closed || disconnected || !child.connected) { unavailable(); return false }
    try { child.send(command, (error) => { if (error) unavailable() }); return true }
    catch { unavailable(); return false }
  }
  // A handler that throws (the journal already closed while the app quits, a full disk) is logged, never an uncaught
  // exception: in Electron's main process that is a modal error dialog that also keeps the app from exiting.
  child.on('message', (raw) => { try { handle(raw as DshEvent) } catch { console.error('DSH_EVENT_NOT_HANDLED') } })
  const handle = (message: DshEvent) => {
    if (closed || disconnected) return
    if (message.t === 'member') {
      const origin = identities.register(message.origin)
      if (origin) options.onEvent({ ...message, origin })
      return
    }
    // Requests from an old process, an unregistered member or a different project never reach
    // the ledger/tools/approval UI. Validate again when asynchronous answers are returned.
    const scoped = ['admit', 'lca-call', 'approval', 'question'].includes(message.t)
    const origin = scoped ? identities.validate(message.origin) : null
    const revision = origin ? revisions.get(origin.rootSessionId) : undefined
    const current = () => !!origin && !!identities.validate(origin) && !inactive.has(origin.rootSessionId) && revisions.get(origin.rootSessionId) === revision && !closed && !disconnected
    if (scoped && (!origin || origin.rootSessionId !== message.sessionId || inactive.has(origin.rootSessionId))) {
      if (message.t === 'admit') send({ t: 'admit-answer', id: message.id, ok: false })
      if (message.t === 'approval') send({ t: 'approval-answer', id: message.id, outcome: 'rejected' })
      if (message.t === 'lca-call') send({ t: 'lca-result', id: message.id, ok: false, error: 'DSH_ORIGIN_UNAVAILABLE' })
      if (message.t === 'question') send({ t: 'question-answer', id: message.id, error: 'This session is no longer available.' })
      return
    }
    if (message.t === 'hello') send({ t: 'init', persona: options.persona, suffix: options.suffix ?? '', tools: options.tools })
    else if (message.t === 'init-ok') { stopStartup(); ready() }
    else if (message.t === 'admit') {
      let ok: boolean
      try { ok = options.onAdmit?.({ sessionId: String(message.sessionId), bucket: message.bucket === 'autonomous' ? 'autonomous' : 'work', role: message.role === 'work' ? 'work' : 'chat', units: Math.max(1, Math.min(20_000_000, Math.round(Number(message.units) || 16_000))) }) ?? true } catch { ok = false }
      send({ t: 'admit-answer', id: message.id, ok })
    }
    else if (message.t === 'lca-call') void options.onCall(String(message.name), message.args, String(message.sessionId), String(message.callId))
      .then((result) => { if (current()) send({ t: 'lca-result', id: message.id, ok: true, value: result.value, source: result.source }) }, (error: unknown) => { if (current()) send({ t: 'lca-result', id: message.id, ok: false, error: error instanceof Error ? error.message : 'LCA_TOOL_FAILED' }) })
    else if (message.t === 'approval') {
      const id = String(message.id)
      if (message.approvalId !== id || typeof message.activationId !== 'string' || !message.activationId || message.policyRevision !== revisions.get(origin!.rootSessionId) || approving.has(id)) {
        send({ t: 'approval-answer', id, outcome: 'rejected' }); return
      }
      const abort = new AbortController(); approving.set(id, { root: String(message.sessionId), abort })
      void options.onApproval({ approvalId: id, activationId: message.activationId, policyRevision: Number(message.policyRevision), signal: abort.signal,
      sessionId: String(message.sessionId), origin: origin!, toolName: String(message.toolName), callId: (message.callId as string | null) ?? null, reason: (message.reason as string | null) ?? null,
      kind: message.kind === 'risky' || message.kind === 'degraded' || message.kind === 'trust' ? message.kind : 'escalation', command: (message.command as string | null) ?? null, subject: typeof message.subject === 'string' ? message.subject : null,
      degraded: Array.isArray(message.degraded) ? dshSources(message.degraded) : null })
      .catch(() => 'rejected' as const).then((outcome) => { if (approving.delete(id) && !abort.signal.aborted && current()) send({ t: 'approval-answer', id, outcome }) })
    }
    else if (message.t === 'approval-cancel') { approving.get(String(message.id))?.abort.abort(); approving.delete(String(message.id)) }
    else if (message.t === 'question') {
      const abort = new AbortController(); asking.set(String(message.id), abort)
      const answered = options.onQuestion?.({ sessionId: String(message.sessionId), callId: typeof message.callId === 'string' ? message.callId : null, questions: message.questions, signal: abort.signal })
        ?? Promise.resolve({ error: 'questions are not available here' })
      void answered.catch(() => ({ error: 'the question could not be shown' })).then((result) => { if (asking.delete(String(message.id)) && current()) send({ t: 'question-answer', id: message.id, ...result }) })
    }
    else if (message.t === 'question-cancel') { asking.get(String(message.id))?.abort(); asking.delete(String(message.id)) }
    else if ((message.t === 'session' || message.t === 'described' || message.t === 'extensions' || message.t === 'error') && typeof message.ref === 'string' && waiting.has(message.ref)) {
      const entry = waiting.get(message.ref)!; waiting.delete(message.ref)
      if (message.t === 'error') entry.fail(new Error(String(message.message))); else entry.done(message)
    }
    options.onEvent(message)
  }
  const request = (command: Record<string, unknown>, timeoutMs?: number) => new Promise<Record<string, unknown>>((done, fail) => {
    const ref = randomUUID()
    const stop = timeoutMs === undefined ? () => {} : options.clock.after(timeoutMs, () => { waiting.delete(ref); fail(new Error('DSH_REQUEST_TIMEOUT')) })
    waiting.set(ref, { done: (value) => { stop(); done(value) }, fail: (error) => { stop(); fail(error) } }); send({ ...command, ref })
  })
  let closing: Promise<number | null> | undefined
  return {
    started,
    available: () => !closed && !disconnected,
    extensions: async (input: DshExtensionRequest): Promise<DshExtensionReply> => {
      await started
      const answer = await request({ t: 'extensions', input }, ['list', 'skills', 'skill-inspect', 'cancel', 'reconcile'].includes(input.action) ? 30_000 : 660_000)
      return answer.value as unknown as DshExtensionReply
    },
    /** `degraded`: the resumed session still holds third-party content LCA could not retire before a restart. */
    /** `persona` / `suffix`: her current card and profile (names change in onboarding after DSH starts). */
    open: async (cwd: string, sessionId?: string, trusted = false, degraded: readonly DshSource[] = [], persona?: { persona: string; suffix: string }) => {
      await started
      const id = sessionId ?? `session-${randomUUID()}`
      cancelApprovals(id)
      const binding = identities.reserveRoot(id, cwd)
      revisions.set(id, 0); inactive.delete(id)
      try {
        const answer = await request({ t: 'open', cwd, trusted, degraded, sessionId: id, resume: !!sessionId, binding, ...(persona ?? {}) })
        if (answer.sessionId !== id) throw new Error('DSH_IDENTITY_CONFLICT')
        return id
      } catch (error) { identities.forgetRoot(id); throw error }
    },
    /** Switch a live session to the `lca-trusted` preset after the user granted its project. */
    trust: (sessionId: string) => send({ t: 'trust', sessionId }),
    /** Back to the default sandbox preset after the user withdrew trust. */
    untrust: (sessionId: string) => { invalidate(sessionId); return send({ t: 'untrust', sessionId }) },
    /** `reference`: LCA's memory references, sent as their own block before your text. */
    /** `degrade`: the reference carries third-party originals that cannot be retired; the session stays degraded. */
    send: (sessionId: string, text: string, mode: 'followup' | 'steer' | 'inject' = 'followup', reference: string | null = null, origin: 'user' | 'event' = 'user', degrade: readonly DshSource[] = []) => {
      if (mode === 'followup' || inactive.has(sessionId)) invalidate(sessionId)
      inactive.delete(sessionId)
      return send({ t: 'send', sessionId, text, mode, origin, ...(reference ? { reference } : {}), ...(degrade.length ? { degrade } : {}) })
    },
    cancel: (sessionId: string) => { invalidate(sessionId); return send({ t: 'cancel', sessionId }) },
    /** Replace her LCA tools (a plugin was enabled or disabled); the next step sees the new list. */
    tools: (tools: readonly DshTool[]) => send({ t: 'tools', tools }),
    /** Thinking levels DSH can send for each role's model; null where it cannot tell. */
    describe: async () => {
      await started
      const answer = await request({ t: 'describe' })
      const levels = (value: unknown) => Array.isArray(value) ? value.filter((level): level is string => typeof level === 'string') : null
      return { chat: levels(answer.chat), work: levels(answer.work) }
    },
    /** New thinking levels from the settings; they apply from each session's next step. */
    efforts: (efforts: { chat?: string; work?: string }) => send({ t: 'efforts', efforts }),
    close: () => closing ??= (async () => {
      send({ t: 'shutdown' }); closed = true; unavailable()
      const stop = hasExited ? () => {} : options.clock.after(10_000, () => child.kill())
      try { return await exited } finally { stop() }
    })(),
  }
}
export type DshHost = ReturnType<typeof startDshHost>
