// Public CLI control for the native-daemon launch probe. Only opens about:blank.
import { spawn } from 'node:child_process'
import { randomUUID, createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
const root = resolve(import.meta.dirname, '..'), directory = join(root, 'test-results', 'browser-cli-control-' + randomUUID())
mkdirSync(directory, { recursive: true })
const config = join(directory, 'config.json'); writeFileSync(config, '{}')
const executable = join(root, '.cache/agent-browser/0.40.0/agent-browser.exe'), session = 'probe-' + randomUUID()
if (createHash('sha256').update(readFileSync(executable)).digest('hex') !== 'b142ca8946efda2d506e0947b232596e7949f08296e6b953b57f63eb50fee751') throw Error('BROWSER_BINARY_MISMATCH')
const env = {}
for (const key of ['SystemRoot', 'WINDIR', 'SYSTEMDRIVE', 'ComSpec', 'ProgramFiles', 'ProgramFiles(x86)', 'ProgramData', 'ALLUSERSPROFILE', 'Path', 'PATH', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'HOMEDRIVE', 'HOMEPATH', 'USERNAME', 'USERDOMAIN', 'TEMP', 'TMP']) if (process.env[key]) env[key] = process.env[key]
Object.assign(env, { AGENT_BROWSER_SOCKET_DIR: directory, AGENT_BROWSER_NO_WEBMCP: '1' })
const base = ['--config', config, '--session', session, '--json', '--no-webmcp', '--executable-path', 'C:/Program Files/Google/Chrome/Application/chrome.exe', '--allowed-domains', '127.0.0.1', '--idle-timeout', '10s']
const run = (args) => new Promise((done) => {
  const child = spawn(executable, [...base, ...args], { cwd: directory, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  let out = '', err = '', timedOut = false
  const timer = setTimeout(() => { timedOut = true; child.kill() }, 15000)
  child.stdout.on('data', (b) => { out += b.toString(); if (out.length > 64000) child.kill() })
  child.stderr.on('data', (b) => { err += b.toString(); if (err.length > 64000) child.kill() })
  child.on('error', () => {})
  child.on('close', (code) => { clearTimeout(timer); done({ code, out, err, timedOut }) })
})
const result = await run(['open', 'about:blank'])
const pidFile = join(directory, session + '.pid'), pid = existsSync(pidFile) ? Number(readFileSync(pidFile, 'utf8')) : null
const close = pid ? await run(['close']) : null
await new Promise((done) => setTimeout(done, 500))
let alive = false; if (pid) try { process.kill(pid, 0); alive = true } catch (error) { if (error.code !== 'ESRCH') alive = 'unknown' }
const receipt = { directory, session, pid, result, close, daemonAliveAfterClose: alive }
writeFileSync(join(directory, 'receipt.json'), JSON.stringify(receipt, null, 2))
console.log(JSON.stringify(receipt))
if (alive || result.code !== 0) process.exitCode = 1
