import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import electronPath from 'electron'
import { runtimeEnv } from './runtime-env.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const probe = process.argv[2]
assert.ok(['sqlite', 'imap', 'journal', 'model', 'harness', 'pomodoro', 'campus'].includes(probe), 'Unknown probe.')
const env = { ...runtimeEnv(root), LCA_DATA_DIR: join(root, '.local-data', `probe-${randomUUID()}`) }
const child = spawn(electronPath, [root, `--lca-probe=${probe}`], { cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
let output = ''
// Never echo native or third-party stderr: a connection error can include private data.
child.stderr.resume()
child.stdout.on('data', (chunk) => {
  output = (output + chunk.toString()).slice(-16_384)
})
const deadline = setTimeout(() => { child.kill(); console.error('Probe timed out (details suppressed).'); process.exitCode = 1 }, 60_000)
child.on('error', () => { clearTimeout(deadline); console.error('Unable to start Electron probe.'); process.exitCode = 1 })
child.on('exit', (code) => {
  clearTimeout(deadline)
  const line = output.split(/\r?\n/).find((value) => value.startsWith('LCA_PROBE:'))
  if (!line) { console.error('Probe failed before producing a safe report.'); process.exitCode = 1; return }
  try {
    const report = JSON.parse(line.slice('LCA_PROBE:'.length))
    // Only main's predefined boolean/numeric fields and static error enums can appear here.
    console.log(JSON.stringify(report))
    process.exitCode = code === 0 && report.ok ? 0 : 1
  } catch { console.error('Invalid probe report.'); process.exitCode = 1 }
})
