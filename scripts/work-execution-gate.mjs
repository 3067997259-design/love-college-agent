import { build } from 'vite'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { spawn } from 'node:child_process'

const repo = resolve(import.meta.dirname, '..')
const base = resolve(process.env.LCA_CONTINUITY_RUN_DIR ?? 'test-results/continuity', 'execution')
mkdirSync(base, { recursive: true }); const root = mkdtempSync(join(base, 'gate-'))
await build({ configFile: false, logLevel: 'error', build: { ssr: true, outDir: join(root, 'bundle'), emptyOutDir: false, minify: false,
  rollupOptions: { input: resolve('scripts/fixtures/work-execution.ts'), external: ['electron', 'better-sqlite3'], output: { format: 'cjs', entryFileNames: 'execution.cjs' } } } })
// The report directory may be on another volume; native externals still belong
// to this checkout, not to an ancestor of the generated fixture bundle.
const child = spawn(process.execPath, [join(root, 'bundle/execution.cjs'), root, repo], { cwd: repo, env: { ...process.env, NODE_PATH: join(repo, 'node_modules') }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
const output = []; child.stdout.on('data', chunk => output.push(chunk)); child.stderr.on('data', chunk => output.push(chunk))
let timedOut = false
const deadline = setTimeout(() => { timedOut = true; child.kill() }, 120_000)
const code = await new Promise((done, reject) => { child.once('exit', done); child.once('error', reject) })
clearTimeout(deadline); writeFileSync(join(root, 'process.log'), Buffer.concat(output))
const report = existsSync(join(root, 'report.json')) ? JSON.parse(readFileSync(join(root, 'report.json'), 'utf8')) : { ok: false, error: 'Execution did not report' }
writeFileSync(join(root, 'exit.json'), JSON.stringify({ code, timedOut }))
console.log(JSON.stringify({ root, code, timedOut, ok: report.ok, phase: report.phase, error: report.error, checks: report.checks }, null, 2))
if (code !== 0 || timedOut || !report.ok) process.exitCode = 1
