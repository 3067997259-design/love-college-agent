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
import type { DshApprovalScope, DshOrigin, DshConversationState, DshProbeResult, DshRootPolicy } from '../../shared/dsh-protocol'
import type { DshCollaborationRequest, DshCollaborationReply } from '../../shared/dsh-protocol'
import { collaborationViewSchema } from './collaboration'
import { memberStepsSchema } from './member-steps'
import type { AgentTarget } from '../../shared/collaboration'
import { z } from 'zod'
import type { RootCompactionOutcome } from '../../shared/continuity'
import { CAPABILITY_LEVELS } from '../config/model-capabilities'
import type { ResolvedModelCapabilities } from '../../shared/model-capabilities'

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
const clip = (max: number) => z.string().transform((value) => value.slice(0, max))
/** A connection test answer from the bridge; provider text is kept but bounded. */
const probedSchema = z.object({
  ok: z.boolean(), durationMs: z.number().int().min(0).max(600_000),
  route: z.object({ provider: clip(256), model: clip(256) }).nullable().optional(),
  failure: z.object({ code: clip(80), message: clip(4000), status: z.number().int().min(100).max(599).optional(), requestId: clip(200).optional() }).optional(),
})
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
  onState?(input: { sessionId: string; state: unknown }): boolean
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
    if (message.t === 'family-policy') {
      const origin = identities.validate(message.origin)
      if (!origin || origin.parentSessionId !== null || !Number.isSafeInteger(message.revision) || Number(message.revision) < (revisions.get(origin.rootSessionId) ?? 0)) return
      if (Number(message.revision) !== revisions.get(origin.rootSessionId)) cancelApprovals(origin.rootSessionId)
      revisions.set(origin.rootSessionId, Number(message.revision))
      if (message.stopped === true) { inactive.add(origin.rootSessionId); cancelApprovals(origin.rootSessionId) } else if (message.stopped === false) inactive.delete(origin.rootSessionId)
      return
    }
    if (message.t === 'collaboration' || message.t === 'collaboration-reply') {
      if (!Array.isArray(message.origins) || message.origins.length > 512) return
      for (const input of message.origins) if (!identities.register(input)) return
      const parsed = collaborationViewSchema.safeParse(message.view)
      if (!parsed.success || parsed.data.runtimeId !== identities.runtimeId) return
      const view = parsed.data
      for (const member of view.members) {
        const known = identities.address(member.address.sessionId)
        if (!known || JSON.stringify(known) !== JSON.stringify(member.address) || known.projectId !== view.projectId) return
        identities.setRevision(known.sessionId, member.revision)
      }
      message = { t: message.t, sessionId: view.members.find((member) => member.mode === 'root')?.address.sessionId, ref: message.ref, view }
    }
    if (message.t === 'member') {
      const origin = identities.register(message.origin)
      if (origin) options.onEvent({ ...message, origin })
      return
    }
    // Requests from an old process, an unregistered member or a different project never reach
    // the ledger/tools/approval UI. Validate again when asynchronous answers are returned.
    const scoped = ['admit', 'lca-call', 'approval', 'question', 'state-request'].includes(message.t)
    const origin = scoped ? identities.validate(message.origin) : null
    const revision = origin ? revisions.get(origin.rootSessionId) : undefined
    const current = () => !!origin && !!identities.validate(origin) && !inactive.has(origin.rootSessionId) && revisions.get(origin.rootSessionId) === revision && !closed && !disconnected
    if (scoped && (!origin || origin.rootSessionId !== message.sessionId || inactive.has(origin.rootSessionId))) {
      if (message.t === 'admit') send({ t: 'admit-answer', id: message.id, ok: false })
      if (message.t === 'approval') send({ t: 'approval-answer', id: message.id, outcome: 'rejected' })
      if (message.t === 'lca-call') send({ t: 'lca-result', id: message.id, ok: false, error: 'DSH_ORIGIN_UNAVAILABLE' })
      if (message.t === 'question') send({ t: 'question-answer', id: message.id, error: 'This session is no longer available.' })
      if (message.t === 'state-request') send({ t: 'state-answer', id: message.id, ok: false })
      return
    }
    if (message.t === 'hello') send({ t: 'init', persona: options.persona, suffix: options.suffix ?? '', tools: options.tools })
    else if (message.t === 'init-ok') { stopStartup(); ready() }
    else if (message.t === 'state-request') {
      let ok = false
      try { ok = current() && origin?.parentSessionId === null && (options.onState?.({ sessionId: String(message.sessionId), state: message.state }) ?? false) } catch { /* rejected */ }
      send({ t: 'state-answer', id: message.id, ok: ok && current() })
    }
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
    else if ((message.t === 'session' || message.t === 'released' || message.t === 'delivered' || message.t === 'described' || message.t === 'probed' || message.t === 'compacted' || message.t === 'extensions' || message.t === 'collaboration-reply' || message.t === 'member-steps-reply' || message.t === 'error') && typeof message.ref === 'string' && waiting.has(message.ref)) {
      const entry = waiting.get(message.ref)!; waiting.delete(message.ref)
      if (message.t === 'error') entry.fail(new Error(String(message.message))); else entry.done(message)
    }
    // On-demand details have no event/journal/snapshot consumer.
    if (message.t !== 'member-steps-reply') options.onEvent(message)
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
    compact: async (rootSessionId: string, operationId: string): Promise<{ rootSessionId: string; outcome: RootCompactionOutcome }> => {
      await started
      const root = identities.address(rootSessionId)
      if (!root || root.parentSessionId !== null) throw new Error('DSH_ORIGIN_UNAVAILABLE')
      try {
        const answer = await request({ t: 'compact', sessionId: rootSessionId, operationId }, 60_000)
        if (answer.rootSessionId !== rootSessionId) throw new Error('DSH_IDENTITY_CONFLICT')
        return { rootSessionId, outcome: z.enum(['compacted', 'no_range', 'busy', 'failed']).parse(answer.outcome) }
      } catch (error) { send({ t: 'compact-cancel', sessionId: rootSessionId }); throw error }
    },
    memberSteps: async (target: AgentTarget) => {
      await started
      const root = identities.address(target.address.rootSessionId)
      if (!root || root.parentSessionId !== null || target.address.sessionId === root.sessionId || !identities.acceptsTarget(target, root.projectId)) throw new Error('LCA_STALE_MEMBER')
      const answer = await request({ t: 'member-steps', input: { rootSessionId: root.sessionId, sessionId: target.address.sessionId } }, 10_000)
      if (!identities.acceptsTarget(target, root.projectId)) throw new Error('LCA_STALE_MEMBER')
      return memberStepsSchema.parse(answer.value)
    },
    collaboration: async (input: DshCollaborationRequest): Promise<DshCollaborationReply> => {
      await started
      const root = identities.address(input.rootSessionId)
      if (!root || root.parentSessionId !== null) throw new Error('DSH_ORIGIN_UNAVAILABLE')
      if (input.command.type !== 'agent.refresh' && (input.command.target.address.rootSessionId !== input.rootSessionId || (['agent.stop-family', 'team.task.update'].includes(input.command.type)
        ? JSON.stringify(input.command.target.address) !== JSON.stringify(root)
        : !identities.acceptsTarget(input.command.target, root.projectId)))) throw new Error('LCA_STALE_MEMBER')
      const answer = await request({ t: 'collaboration', input }, 30_000)
      return { view: collaborationViewSchema.parse(answer.view) }
    },
    extensions: async (input: DshExtensionRequest): Promise<DshExtensionReply> => {
      await started
      const answer = await request({ t: 'extensions', input }, ['list', 'skills', 'skill-inspect', 'cancel', 'reconcile'].includes(input.action) ? 30_000 : 660_000)
      return answer.value as unknown as DshExtensionReply
    },
    /** `degraded`: the resumed session still holds third-party content LCA could not retire before a restart. */
    /** `persona` / `suffix`: her current card and profile (names change in onboarding after DSH starts). */
    open: async (cwd: string, sessionId?: string, trusted = false, degraded: readonly DshSource[] = [], persona?: { persona: string; suffix: string; policy?: DshRootPolicy; allowedTools?: readonly string[] }) => {
      await started
      const id = sessionId ?? `session-${randomUUID()}`
      cancelApprovals(id)
      const binding = identities.reserveRoot(id, cwd)
      revisions.set(id, 0); inactive.delete(id)
      try {
        const answer = await request({ t: 'open', cwd, trusted, degraded, sessionId: id, resume: !!sessionId, binding, ...(persona ?? {}) }, 30_000)
        if (answer.sessionId !== id) throw new Error('DSH_IDENTITY_CONFLICT')
        return id
      } catch (error) { identities.forgetRoot(id); throw error }
    },
    /** Disposal acknowledges that this root and its family stopped. Other roots keep running. */
    release: async (sessionId: string) => {
      invalidate(sessionId)
      const result = await request({ t: 'release', sessionId }, 15_000)
      if (result.sessionId !== sessionId) throw new Error('DSH_IDENTITY_CONFLICT')
      identities.forgetRoot(sessionId); revisions.delete(sessionId); inactive.delete(sessionId)
    },
    /** Switch a live session to the `lca-trusted` preset after the user granted its project. */
    trust: (sessionId: string) => send({ t: 'trust', sessionId }),
    /** Back to the default sandbox preset after the user withdrew trust. */
    untrust: (sessionId: string) => { invalidate(sessionId); return send({ t: 'untrust', sessionId }) },
    /** `reference`: LCA's memory references, sent as their own block before your text. */
    /** `degrade`: the reference carries third-party originals that cannot be retired; the session stays degraded. */
    send: (sessionId: string, text: string, mode: 'followup' | 'steer' | 'inject' = 'followup', reference: string | null = null, origin: 'user' | 'event' = 'user', degrade: readonly DshSource[] = [], state?: DshConversationState, eventId?: string, workRevision?: number, eventIds?: readonly string[]) => {
      if (mode === 'followup' || inactive.has(sessionId)) invalidate(sessionId)
      inactive.delete(sessionId)
      return send({ t: 'send', sessionId, text, mode, origin, ...(reference ? { reference } : {}), ...(degrade.length ? { degrade } : {}), ...(state ? { state } : {}), ...(eventId ? { eventId } : {}), ...(workRevision ? { workRevision } : {}), ...(eventIds?.length ? { eventIds } : {}) })
    },
    state: (sessionId: string, state: DshConversationState) => send({ t: 'state', sessionId, state }),
    workRevision: (sessionId: string, revision: number) => send({ t: 'work-revision', sessionId, revision }),
    deliverWork: async (sessionId: string, input: { text: string; eventId: string; revision: number; mode: 'followup' | 'steer'; reference: string | null; state: DshConversationState }) => {
      if (input.mode === 'followup' || inactive.has(sessionId)) invalidate(sessionId)
      inactive.delete(sessionId)
      const answer = await request({ t: 'send', sessionId, origin: 'user', ...input, workRevision: input.revision }, 15_000)
      if (answer.sessionId !== sessionId || answer.eventId !== input.eventId) throw new Error('DSH_DELIVERY_MISMATCH')
    },
    cancel: (sessionId: string) => { invalidate(sessionId); return send({ t: 'cancel', sessionId }) },
    /** Replace her LCA tools (a plugin was enabled or disabled); the next step sees the new list. */
    tools: (tools: readonly DshTool[], sessionId?: string) => send({ t: 'tools', tools, ...(sessionId ? { sessionId } : {}) }),
    /** Thinking levels DSH can send for each role's model; null where it cannot tell. */
    describe: async () => {
      await started
      const answer = await request({ t: 'describe' })
      const levels = (value: unknown) => Array.isArray(value) ? value.filter((level): level is string => typeof level === 'string') : null
      const schema = z.object({ contextWindow: z.number().int().positive().max(100_000_000).optional(), maxOutputTokens: z.number().int().positive().max(100_000_000).optional(),
        inputModalities: z.array(z.enum(['text', 'image'])).max(2).optional(), reasoningLevels: z.array(z.enum(CAPABILITY_LEVELS)).max(7).optional() })
      const metadata = answer.capabilities as Record<string, unknown> | undefined
      const capabilities: { chat?: ResolvedModelCapabilities; work?: ResolvedModelCapabilities } = {}
      for (const role of ['chat', 'work'] as const) { const parsed = schema.safeParse(metadata?.[role]); if (parsed.success) capabilities[role] = parsed.data }
      return { chat: levels(answer.chat), work: levels(answer.work), ...(Object.keys(capabilities).length ? { capabilities } : {}) }
    },
    /** One connection test through DSH's own adapter for the role's route. The bridge stops waiting after 30 s. */
    probe: async (role: 'chat' | 'work'): Promise<DshProbeResult> => {
      await started
      const answer = probedSchema.parse(await request({ t: 'probe', role }, 45_000))
      return { ok: answer.ok, durationMs: answer.durationMs, route: answer.route ?? { provider: '', model: '' }, ...(answer.failure ? { failure: answer.failure } : {}) }
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
