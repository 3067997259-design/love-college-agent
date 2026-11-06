import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { connect } from 'node:net'
import { StringDecoder } from 'node:string_decoder'
import type { Clock } from '../../src/main/clock'

export const AGENT_BROWSER = {
  version: '0.40.0', commit: 'c3880a7de9be3b075c8779e8aaca4b530b7f0e10',
  sha256: 'b142ca8946efda2d506e0947b232596e7949f08296e6b953b57f63eb50fee751',
} as const

/** Validation fixture only. NOT wired into LCA: Windows startup has not passed acceptance.
 * Own the native daemon child directly; never expose this private protocol as a model/renderer API. */
export async function startBrowserNative(options: {
  executable: string; browser: string; directory: string; hostname: string; clock: Clock; signal: AbortSignal
  spawned?(pid: number): void
}) {
  if (process.platform !== 'win32') throw new Error('BROWSER_PLATFORM_UNSUPPORTED')
  if (createHash('sha256').update(readFileSync(options.executable)).digest('hex') !== AGENT_BROWSER.sha256) throw new Error('BROWSER_BINARY_MISMATCH')
  options.signal.throwIfAborted()
  const session = 'lca-' + randomUUID(), sockets = join(options.directory, 'sockets'), home = join(options.directory, 'home')
  for (const path of [sockets, home, join(home, 'tmp')]) mkdirSync(path, { recursive: true })
  const env: Record<string, string> = {}
  for (const key of ['SystemRoot', 'WINDIR', 'SYSTEMDRIVE', 'ComSpec', 'ProgramFiles', 'ProgramFiles(x86)', 'ProgramData', 'ALLUSERSPROFILE', 'Path', 'PATH', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'HOMEDRIVE', 'HOMEPATH', 'USERNAME', 'USERDOMAIN']) if (process.env[key]) env[key] = process.env[key]!
  Object.assign(env, { HOME: home, TEMP: join(home, 'tmp'), TMP: join(home, 'tmp'),
    AGENT_BROWSER_DAEMON: '1', AGENT_BROWSER_SESSION: session, AGENT_BROWSER_SOCKET_DIR: sockets,
    AGENT_BROWSER_EXECUTABLE_PATH: options.browser, AGENT_BROWSER_ALLOWED_DOMAINS: options.hostname,
    AGENT_BROWSER_NO_WEBMCP: '1', AGENT_BROWSER_NO_AUTO_DIALOG: '1', AGENT_BROWSER_PLUGINS: '[]', AGENT_BROWSER_ARGS: '--enable-automation',
    AGENT_BROWSER_IDLE_TIMEOUT_MS: '30000', AGENT_BROWSER_DEFAULT_TIMEOUT: '10000', AGENT_BROWSER_RESTORE_SAVE: 'never' })
  const child = spawn(options.executable, [], { cwd: home, env, windowsHide: true, detached: true, stdio: ['ignore', 'ignore', 'pipe'] })
  if (child.pid) options.spawned?.(child.pid)
  let stderr = ''
  child.stderr?.on('data', (part: Buffer) => { stderr = (stderr + part.toString('utf8')).slice(0, 2000) })
  let exited = false, launched = false, port = 0, closing: Promise<void> | undefined
  const ended = new Promise<void>((done) => {
    const finish = () => { exited = true; done() }
    child.once('exit', finish); child.once('error', finish)
  })
  const pause = (ms: number) => new Promise<void>((done) => options.clock.after(ms, done))
  const request = (action: string, args: Record<string, unknown> = {}, signal?: AbortSignal, timeout = 10000): Promise<Record<string, unknown>> => new Promise((done, fail) => {
    if (exited || !port || signal?.aborted) { fail(new Error('BROWSER_UNAVAILABLE')); return }
    const id = randomUUID(), socket = connect({ host: '127.0.0.1', port })
    let bytes = 0, data = '', settled = false
    const decoder = new StringDecoder('utf8')
    const finish = (error?: Error, value?: Record<string, unknown>) => {
      if (settled) return
      settled = true; cancelTimer(); signal?.removeEventListener('abort', abort); socket.destroy()
      if (error) fail(error); else done(value!)
    }
    const abort = () => finish(new Error('BROWSER_CANCELLED'))
    const cancelTimer = options.clock.after(timeout, () => finish(new Error('BROWSER_TIMEOUT')))
    signal?.addEventListener('abort', abort, { once: true })
    socket.on('connect', () => socket.write(JSON.stringify({ id, action, ...args }) + '\n'))
    socket.on('error', () => finish(new Error('BROWSER_CONNECTION_FAILED')))
    socket.on('end', () => finish(new Error('BROWSER_OUTCOME_UNKNOWN')))
    socket.on('data', (part: Buffer) => {
      bytes += part.length
      if (bytes > 512000) { finish(new Error('BROWSER_OUTPUT_LIMIT')); return }
      data += decoder.write(part)
      if (!data.includes('\n')) return
      try {
        const value = JSON.parse(data.slice(0, data.indexOf('\n')))
        if (value.id !== id || value.success !== true || !value.data || typeof value.data !== 'object') { finish(new Error('BROWSER_COMMAND_FAILED', { cause: value })); return }
        finish(undefined, value.data)
      } catch { finish(new Error('BROWSER_COMMAND_FAILED')) }
    })
  })
  const close = (): Promise<void> => closing ??= (async () => {
    options.signal.removeEventListener('abort', abortAll)
    // `close` can itself auto-launch a browser in the upstream daemon. On startup failure,
    // terminate our child directly; its Job Object owns any partially launched Chrome tree.
    if (!exited && port && launched) await request('close', {}, undefined, 1500).catch(() => {})
    if (!exited && launched) await Promise.race([ended, pause(500)])
    if (!exited) child.kill()
    await Promise.race([ended, pause(2000)])
    if (!exited) throw new Error('BROWSER_STOP_UNVERIFIED')
  })()
  const abortAll = () => { void close().catch(() => {}) }
  options.signal.addEventListener('abort', abortAll, { once: true })
  try {
    for (let attempt = 0; attempt < 100; attempt++) {
      options.signal.throwIfAborted()
      if (exited) throw new Error('BROWSER_START_FAILED')
      try {
        const pid = Number(readFileSync(join(sockets, session + '.pid'), 'utf8'))
        const candidate = Number(readFileSync(join(sockets, session + '.port'), 'utf8'))
        if (pid === child.pid && Number.isInteger(candidate) && candidate > 0 && candidate < 65536) { port = candidate; break }
      } catch { /* not ready yet */ }
      await pause(50)
    }
    if (!port) throw new Error('BROWSER_START_TIMEOUT', { cause: { stderr, pid: child.pid } })
    const info = await request('session_info', {}, options.signal)
    if (info.backgroundPid !== child.pid || info.session !== session) throw new Error('BROWSER_OWNER_MISMATCH')
    launched = info.browserLaunched === true
    return { pid: child.pid!, session, request: (action: string, args?: Record<string, unknown>) => request(action, args, options.signal), close }
  } catch (error) { await close(); throw error }
}
