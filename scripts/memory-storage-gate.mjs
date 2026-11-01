import { build } from 'vite'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { spawn } from 'node:child_process'

const results = resolve(process.env.LCA_CONTINUITY_RUN_DIR ?? 'test-results/continuity', 'storage')
mkdirSync(results, { recursive: true })
const root = mkdtempSync(join(results, 'gate-'))
await build({ configFile: false, logLevel: 'error', build: {
  ssr: true, outDir: join(root, 'bundle'), emptyOutDir: false, minify: false,
  rollupOptions: {
    input: { memoryGate: resolve('scripts/fixtures/memory-storage-electron.ts'), memoryWorker: resolve('src/main/memory/storage/worker.ts') },
    external: ['electron', '@duckdb/node-api'],
    output: { format: 'cjs', entryFileNames: '[name].cjs' },
  },
} })
const env = { ...process.env, LCA_DATA_DIR: join(root, 'unused-app-data'), LCA_TEST_SILENT: '1' }
delete env.ELECTRON_RUN_AS_NODE
const child = spawn(resolve('node_modules/electron/dist/electron.exe'), [join(root, 'bundle/memoryGate.cjs'), root], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
const log = []
child.stdout.on('data', chunk => log.push(chunk))
child.stderr.on('data', chunk => log.push(chunk))
let timeout = false
const deadline = setTimeout(() => { timeout = true; child.kill() }, 120_000)
const code = await new Promise((done, reject) => { child.once('exit', done); child.once('error', reject) })
clearTimeout(deadline)
writeFileSync(join(root, 'process.log'), Buffer.concat(log))
writeFileSync(join(root, 'exit.json'), JSON.stringify({ code, timeout }))
const report = existsSync(join(root, 'report.json')) ? JSON.parse(readFileSync(join(root, 'report.json'), 'utf8')) : { ok: false, error: 'Electron exited before the probe reported; inspect process.log' }
console.log(JSON.stringify({ root, code, ...report }, null, 2))
if (code !== 0 || timeout || !report.ok) process.exitCode = 1
