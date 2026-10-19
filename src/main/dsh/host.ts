import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { Clock } from '../clock'

/**
 * DSH host launcher (spike). Runs the forked DSH runtime as an Electron-Node child with LCA's `lca`
 * profile and talks to its lca-bridge plugin over the IPC channel. Main supplies credentials through
 * the child environment only; the child gets an explicit environment, never main's whole one.
 */
export type DshEvent = { t: string; sessionId?: string; [key: string]: unknown }
export type DshTool = { name: string; description: string; parameters: Record<string, unknown> }
export type DshApproval = { sessionId: string; toolName: string; callId: string | null; reason: string | null; kind: 'risky' | 'escalation'; command: string | null }
export type DshRoute = { kind: 'deepseek-official'; apiKey: string; model?: string } | { kind: 'openai-compatible'; baseUrl: string; model: string; apiKey: string }
export interface DshHostOptions {
  clock: Clock; dshRoot: string; dataDir: string; bridge: string; workspace: string
  route: DshRoute | null; guardedRoots: readonly string[]
  persona: string; suffix?: string; tools: readonly DshTool[]
  onEvent(event: DshEvent): void
  onCall(name: string, args: unknown, sessionId: string, callId: string): Promise<unknown>
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
  if (!existsSync(link)) { mkdirSync(dirname(link), { recursive: true }); symlinkSync(options.bridge, link, 'junction') }
  return { home, cli: join(options.dshRoot, 'apps', 'cli', 'lib', 'bin.js') }
}

export function startDshHost(options: DshHostOptions) {
  const { home, cli } = prepareDshProfile(options)
  mkdirSync(options.workspace, { recursive: true })
  const env: Record<string, string> = {}
  for (const key of INHERITED) if (process.env[key]) env[key] = process.env[key]!
  // DSH's native runtime hooks accept exact Electron builds only; LCA pins 44.7.0 to match. A system
  // Node can still host DSH for diagnosis (LCA_DSH_NODE).
  const runtime = process.env.LCA_DSH_NODE || process.execPath
  const route = options.route
  Object.assign(env, { DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1', LCA_GUARDED_ROOTS: options.guardedRoots.join(';'),
    ...(route?.kind === 'deepseek-official' ? { DEEPSEEK_API_KEY: route.apiKey, ...(route.model ? { LCA_DSH_MODEL: route.model } : {}) } : {}),
    ...(route?.kind === 'openai-compatible' ? { LCA_CHAT_BASE_URL: route.baseUrl, LCA_CHAT_MODEL: route.model, LCA_CHAT_API_KEY: route.apiKey } : {}),
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
      .then((value) => child.send({ t: 'lca-result', id: message.id, ok: true, value }), (error: unknown) => child.send({ t: 'lca-result', id: message.id, ok: false, error: error instanceof Error ? error.message : 'LCA_TOOL_FAILED' }))
    else if (message.t === 'approval') void options.onApproval({ sessionId: String(message.sessionId), toolName: String(message.toolName), callId: (message.callId as string | null) ?? null, reason: (message.reason as string | null) ?? null,
      kind: message.kind === 'risky' ? 'risky' : 'escalation', command: (message.command as string | null) ?? null })
      .then((outcome) => child.send({ t: 'approval-answer', id: message.id, outcome }), () => child.send({ t: 'approval-answer', id: message.id, outcome: 'rejected' }))
    else if ((message.t === 'session' || message.t === 'error') && typeof message.ref === 'string' && waiting.has(message.ref)) {
      const entry = waiting.get(message.ref)!; waiting.delete(message.ref)
      if (message.t === 'session') entry.done(message); else entry.fail(new Error(String(message.message)))
    }
    options.onEvent(message)
  })
  const request = (command: Record<string, unknown>) => new Promise<Record<string, unknown>>((done, fail) => { const ref = randomUUID(); waiting.set(ref, { done, fail }); child.send({ ...command, ref }) })
  return {
    started,
    open: async (cwd: string, sessionId?: string) => { await started; return String((await request({ t: 'open', cwd, ...(sessionId ? { sessionId } : {}) })).sessionId) },
    send: (sessionId: string, text: string, mode: 'followup' | 'steer' | 'inject' = 'followup') => child.send({ t: 'send', sessionId, text, mode }),
    cancel: (sessionId: string) => child.send({ t: 'cancel', sessionId }),
    close: async () => { if (child.connected) child.send({ t: 'shutdown' }); const stop = options.clock.after(10_000, () => child.kill()); try { return await exited } finally { stop() } },
  }
}
export type DshHost = ReturnType<typeof startDshHost>
