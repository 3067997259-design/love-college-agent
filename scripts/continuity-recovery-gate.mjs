import { build } from 'vite'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import electron from 'electron'

const base = resolve(process.env.LCA_CONTINUITY_RUN_DIR ?? 'test-results/continuity', 'recovery')
mkdirSync(base, { recursive: true }); const root = mkdtempSync(join(base, 'gate-'))
await build({ configFile: false, logLevel: 'error', build: { ssr: true, outDir: join(root, 'bundle'), emptyOutDir: false, minify: false,
  rollupOptions: { input: { recoveryGate: resolve('scripts/fixtures/continuity-recovery-electron.ts'), memoryWorker: resolve('src/main/memory/storage/worker.ts') },
    external: ['electron', 'better-sqlite3', '@duckdb/node-api'], output: { format: 'cjs', entryFileNames: '[name].cjs' } } } })
const env = { ...process.env, LCA_DATA_DIR: join(root, 'unused-app-data'), LCA_TEST_SILENT: '1' }; delete env.ELECTRON_RUN_AS_NODE
const child = spawn(electron, [join(root, 'bundle/recoveryGate.cjs'), root], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
const output = []; child.stdout.on('data', chunk => output.push(chunk)); child.stderr.on('data', chunk => output.push(chunk))
let timedOut = false
const deadline = setTimeout(() => { timedOut = true; child.kill() }, 120_000)
const code = await new Promise((done, reject) => { child.once('exit', done); child.once('error', reject) })
clearTimeout(deadline); writeFileSync(join(root, 'process.log'), Buffer.concat(output))
writeFileSync(join(root, 'exit.json'), JSON.stringify({ code, timedOut }))
const report = existsSync(join(root, 'report.json')) ? JSON.parse(readFileSync(join(root, 'report.json'), 'utf8')) : { ok: false, error: 'Recovery did not report' }
console.log(JSON.stringify({ root, code, timedOut, ...report }, null, 2))
if (code !== 0 || timedOut || !report.ok) process.exitCode = 1
