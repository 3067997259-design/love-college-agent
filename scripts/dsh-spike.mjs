// DSH spike probe: prepares LCA's DSH profile, boots the forked DSH runtime and drives the lca-bridge
// handshake over Node IPC. It never reads model credentials; real-model runs go through the LCA main
// process (see src/main/dsh). Usage: node scripts/dsh-spike.mjs [--open <cwd>]
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { prepareDshProfile } from '../dsh/profile.mjs'

const { values: args } = parseArgs({ options: { open: { type: 'string' }, timeout: { type: 'string', default: '90000' } } })
const repo = resolve(import.meta.dirname, '..')
const dshRoot = resolve(process.env.DSH_ROOT ?? 'D:/dsh-lca')
const dataDir = resolve(process.env.LCA_DATA_DIR ?? join(repo, '.local-data'))
const { home, cli } = prepareDshProfile({ dshRoot, dataDir, bridge: join(repo, 'dsh', 'lca-bridge') })
const work = resolve(args.open ?? join(dataDir, 'dsh-work', 'scratch'))
if (!existsSync(work)) mkdirSync(work, { recursive: true })

const started = Date.now()
const child = spawn(process.execPath, [cli, '--profile', 'lca'], {
  cwd: work,
  env: { ...process.env, DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1', LCA_GUARDED_ROOTS: [dataDir].join(';'), DEEPSEEK_API_KEY: '' },
  stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
})
const log = (...parts) => console.log(`[${((Date.now() - started) / 1000).toFixed(1)}s]`, ...parts)
child.stdout.on('data', (chunk) => process.stdout.write(`  dsh> ${chunk}`))
child.stderr.on('data', (chunk) => process.stderr.write(`  dsh! ${chunk}`))
const timer = setTimeout(() => { log('timeout'); child.kill() }, Number(args.timeout))
child.on('exit', (code, signal) => { clearTimeout(timer); log('exit', code, signal ?? ''); process.exitCode = code === 0 ? 0 : 1 })
child.on('message', (message) => {
  log('<-', JSON.stringify(message).slice(0, 600))
  if (message.t === 'hello') child.send({ t: 'init', persona: '你是 LCA 里的角色。', suffix: '', tools: [{ name: 'lca_get_timer', description: 'Read the pomodoro timer of the LCA book.', parameters: { type: 'object', properties: {}, additionalProperties: false } }] })
  if (message.t === 'init-ok') child.send({ t: 'open', ref: 'probe', cwd: work })
  if (message.t === 'session' || message.t === 'error') child.send({ t: 'shutdown' })
})
writeFileSync(join(dataDir, 'dsh-spike.last-run.txt'), new Date().toISOString() + '\n')
