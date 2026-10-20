import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import type { Clock } from '../clock'
import type { DshRoutes } from './routes'

/**
 * DSH host launcher (spike). Runs the forked DSH runtime as an Electron-Node child with LCA's `lca`
 * profile and talks to its lca-bridge plugin over the IPC channel. Main supplies credentials through
 * the child environment only; the child gets an explicit environment, never main's whole one.
 */
export type DshEvent = { t: string; sessionId?: string; [key: string]: unknown }
export type DshTool = { name: string; description: string; parameters: Record<string, unknown> }
/** Third-party content kinds, as in D2's `turn/degraded`. */
export type DshSource = 'mail' | 'document' | 'web' | 'mcp' | 'plugin'
const SOURCES: readonly DshSource[] = ['mail', 'document', 'web', 'mcp', 'plugin']
export const dshSources = (value: unknown): DshSource[] => Array.isArray(value) ? SOURCES.filter((source) => value.includes(source)) : []
/**
 * `degraded`: third-party content is in her context, so this approval may not create or apply standing grants.
 * `trust`: the OS sandbox cannot run commands in her project; asks whether to trust the project instead.
 */
export type DshApproval = { sessionId: string; toolName: string; callId: string | null; reason: string | null; kind: 'risky' | 'escalation' | 'degraded' | 'trust'; command: string | null; subject: string | null; degraded: DshSource[] | null }
export interface DshHostOptions {
  clock: Clock; dshRoot: string; dataDir: string; bridge: string; workspace: string
  /** Her chat and work models (routes.ts); null keeps DSH's own default model. */
  routes: DshRoutes | null; guardedRoots: readonly string[]
  persona: string; suffix?: string; tools: readonly DshTool[]
  onEvent(event: DshEvent): void
  /** `source` marks a result carrying third-party content; the bridge then degrades the turn. */
  onCall(name: string, args: unknown, sessionId: string, callId: string): Promise<{ value: unknown; source: DshSource | null }>
  onApproval(request: DshApproval): Promise<'allowed-once' | 'rejected'>
}

const INHERITED = ['SystemRoot', 'SYSTEMDRIVE', 'WINDIR', 'ComSpec', 'PATHEXT', 'Path', 'PATH', 'TEMP', 'TMP', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH',
  'APPDATA', 'LOCALAPPDATA', 'ProgramData', 'ProgramFiles', 'ProgramFiles(x86)', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'OS',
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'no_proxy', 'all_proxy']

export function prepareDshProfile(options: { dshRoot: string; dataDir: string; bridge: string }) {
  const home = join(options.dataDir, 'dsh-home')
  const profile = join(home, 'profiles', 'lca')
  const manifest = { name: 'dsh-profile-lca', private: true, dependencies: { '@lca/dsh-bridge': `link:${options.bridge.replaceAll('\\', '/')}` },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@lca/dsh-bridge'] } } }
  mkdirSync(profile, { recursive: true })
  const manifestPath = join(profile, 'package.json'); const text = JSON.stringify(manifest, null, 2) + '\n'
  if (!existsSync(manifestPath) || readFileSync(manifestPath, 'utf8') !== text) writeFileSync(manifestPath, text)
  if (!existsSync(join(profile, 'cordis.patch.yml'))) writeFileSync(join(profile, 'cordis.patch.yml'), '[]\n')
  if (!existsSync(join(profile, 'pnpm-workspace.yaml'))) writeFileSync(join(profile, 'pnpm-workspace.yaml'), 'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n')
  const link = join(profile, 'node_modules', '@lca', 'dsh-bridge')
  // Re-link when the bridge moved (a checkout in development, the app's resources once installed).
  let linked: string | null = null; let present = false
  try { const stat = lstatSync(link); present = true; if (stat.isSymbolicLink()) linked = resolve(readlinkSync(link)) } catch { /* not linked yet */ }
  if (linked !== resolve(options.bridge)) {
    // unlink, not rm: Electron's Node refuses rmSync on a directory junction (ERR_FS_EISDIR).
    if (present) unlinkSync(link)
    mkdirSync(dirname(link), { recursive: true }); symlinkSync(options.bridge, link, 'junction')
  }
  return { home, cli: dshCli(options.dshRoot) }
}

/** DSH's CLI: the pinned npm runtime (dsh/runtime, shipped with the app) or a built checkout of the fork. */
export function dshCli(root: string) {
  const npm = join(root, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  return existsSync(npm) ? npm : join(root, 'apps', 'cli', 'lib', 'bin.js')
}

export function startDshHost(options: DshHostOptions) {
  const { home, cli } = prepareDshProfile(options)
  mkdirSync(options.workspace, { recursive: true })
  const env: Record<string, string> = {}
  for (const key of INHERITED) if (process.env[key]) env[key] = process.env[key]!
  // DSH's native runtime hooks accept exact Electron builds only; LCA pins 44.7.0 to match. A system
  // Node can still host DSH for diagnosis (LCA_DSH_NODE).
  const runtime = process.env.LCA_DSH_NODE || process.execPath
  Object.assign(env, { DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1', LCA_GUARDED_ROOTS: options.guardedRoots.join(';'), ...options.routes?.env,
    ...(process.env.LCA_DSH_NODE ? {} : { ELECTRON_RUN_AS_NODE: '1' }) })
  const child = spawn(runtime, [cli, '--profile', 'lca'], { cwd: options.workspace, env, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] })
  // Never echo the child's stderr: provider errors can quote request details.
  child.stderr?.resume()
  const waiting = new Map<string, { done(value: Record<string, unknown>): void; fail(error: Error): void }>()
  let ready!: () => void
  let failed!: (error: Error) => void
  const started = new Promise<void>((resolve, reject) => { ready = resolve; failed = reject })
  const exited = new Promise<number | null>((resolve) => child.once('exit', (code) => { failed(new Error('DSH_HOST_EXITED')); for (const entry of waiting.values()) entry.fail(new Error('DSH_HOST_EXITED')); resolve(code) }))
  child.on('message', (raw) => {
    const message = raw as DshEvent
    if (message.t === 'hello') child.send({ t: 'init', persona: options.persona, suffix: options.suffix ?? '', tools: options.tools })
    else if (message.t === 'init-ok') ready()
    else if (message.t === 'lca-call') void options.onCall(String(message.name), message.args, String(message.sessionId), String(message.callId))
      .then((result) => child.send({ t: 'lca-result', id: message.id, ok: true, value: result.value, source: result.source }), (error: unknown) => child.send({ t: 'lca-result', id: message.id, ok: false, error: error instanceof Error ? error.message : 'LCA_TOOL_FAILED' }))
    else if (message.t === 'approval') void options.onApproval({ sessionId: String(message.sessionId), toolName: String(message.toolName), callId: (message.callId as string | null) ?? null, reason: (message.reason as string | null) ?? null,
      kind: message.kind === 'risky' || message.kind === 'degraded' || message.kind === 'trust' ? message.kind : 'escalation', command: (message.command as string | null) ?? null, subject: typeof message.subject === 'string' ? message.subject : null,
      degraded: Array.isArray(message.degraded) ? dshSources(message.degraded) : null })
      .then((outcome) => child.send({ t: 'approval-answer', id: message.id, outcome }), () => child.send({ t: 'approval-answer', id: message.id, outcome: 'rejected' }))
    else if ((message.t === 'session' || message.t === 'described' || message.t === 'error') && typeof message.ref === 'string' && waiting.has(message.ref)) {
      const entry = waiting.get(message.ref)!; waiting.delete(message.ref)
      if (message.t === 'error') entry.fail(new Error(String(message.message))); else entry.done(message)
    }
    options.onEvent(message)
  })
  const request = (command: Record<string, unknown>) => new Promise<Record<string, unknown>>((done, fail) => { const ref = randomUUID(); waiting.set(ref, { done, fail }); child.send({ ...command, ref }) })
  return {
    started,
    /** `degraded`: the resumed session still holds third-party content LCA could not retire before a restart. */
    open: async (cwd: string, sessionId?: string, trusted = false, degraded: readonly DshSource[] = []) => { await started; return String((await request({ t: 'open', cwd, trusted, degraded, ...(sessionId ? { sessionId } : {}) })).sessionId) },
    /** Switch a live session to the `lca-trusted` preset after the user granted its project. */
    trust: (sessionId: string) => child.send({ t: 'trust', sessionId }),
    /** Back to the default sandbox preset after the user withdrew trust. */
    untrust: (sessionId: string) => child.send({ t: 'untrust', sessionId }),
    send: (sessionId: string, text: string, mode: 'followup' | 'steer' | 'inject' = 'followup') => child.send({ t: 'send', sessionId, text, mode }),
    cancel: (sessionId: string) => child.send({ t: 'cancel', sessionId }),
    /** Thinking levels DSH can send for each role's model; null where it cannot tell. */
    describe: async () => {
      await started
      const answer = await request({ t: 'describe' })
      const levels = (value: unknown) => Array.isArray(value) ? value.filter((level): level is string => typeof level === 'string') : null
      return { chat: levels(answer.chat), work: levels(answer.work) }
    },
    /** New thinking levels from the settings; they apply from each session's next step. */
    efforts: (efforts: { chat?: string; work?: string }) => child.send({ t: 'efforts', efforts }),
    close: async () => { if (child.connected) child.send({ t: 'shutdown' }); const stop = options.clock.after(10_000, () => child.kill()); try { return await exited } finally { stop() } },
  }
}
export type DshHost = ReturnType<typeof startDshHost>
