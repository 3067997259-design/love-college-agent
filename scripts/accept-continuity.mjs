// Sequential acceptance of one source candidate. Never launches paid/live services.
import { createHash } from 'node:crypto'
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const gate = process.argv[process.argv.indexOf('--gate') + 1]
const storageOnly = process.argv.includes('--gate') && gate === 'storage'
if (process.argv.includes('--gate') && !storageOnly) throw new Error('Unknown gate')
const tasks = storageOnly ? [
  ['sources', 'scripts/verify-airi-memory.mjs'],
  ['memory-unit', 'node_modules/vitest/vitest.mjs', 'run', 'tests/unit/airi'],
  ['storage', 'scripts/memory-storage-gate.mjs'],
] : [
  ['sources', 'scripts/verify-airi-memory.mjs'],
  ['typecheck-main', 'node_modules/typescript/bin/tsc', '--noEmit', '-p', 'tsconfig.node.json'],
  ['typecheck-renderer', 'node_modules/typescript/bin/tsc', '--noEmit', '-p', 'tsconfig.web.json'],
  ['lint', 'node_modules/eslint/bin/eslint.js', '.'],
  ['unit', 'node_modules/vitest/vitest.mjs', 'run'],
  ['dsh-bridge', 'scripts/dsh-bridge-check.mjs'],
  ['dsh-family', 'scripts/dsh-family-check.mjs'],
  ['dsh-collaboration', 'scripts/dsh-collaboration-check.mjs'],
  ['memory-conversation', 'scripts/memory-conversation-gate.mjs'],
  ['work-execution', 'scripts/work-execution-gate.mjs'],
  ['build', 'node_modules/electron-vite/bin/electron-vite.js', 'build'],
  ['memory', 'scripts/smoke-memory.mjs'],
  ['model-routing', 'scripts/smoke-model-routing.mjs'],
  ['collaboration', 'scripts/smoke-collaboration.mjs'],
  ['backup', 'scripts/smoke-backup.mjs'],
  ['recovery', 'scripts/smoke-v12-recovery.mjs'],
  ['continuity-t1-t16', 'scripts/smoke-continuity.mjs'],
]
const missing = tasks.filter(([, entry]) => !existsSync(entry)).map(([name, entry]) => ({ name, entry }))
if (process.argv.includes('--list')) {
  console.log(JSON.stringify({ mode: storageOnly ? 'storage' : 'candidate', tasks: tasks.map(([name]) => name), missing }, null, 2))
} else {
  const results = resolve('test-results/continuity')
  mkdirSync(results, { recursive: true })
  const root = mkdtempSync(join(results, storageOnly ? 'storage-suite-' : 'candidate-'))
  const fingerprint = () => {
    const paths = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { encoding: 'utf8' }).trim().split('\n')
      .filter(path => /^(src\/|scripts\/|tests\/|dsh\/lca-bridge\/|vendor\/airi-memory\/|package\.json$|pnpm-lock\.yaml$|.*config\..*$|electron-builder\.yml$)/.test(path))
    const digest = createHash('sha256')
    for (const path of [...new Set(paths)].sort()) { digest.update(path); digest.update(existsSync(path) ? readFileSync(path) : 'deleted') }
    return digest.digest('hex')
  }
  const report = { mode: storageOnly ? 'storage' : 'candidate', source: fingerprint(), ok: false, missing, tasks: [], liveServices: 'not run' }
  const save = () => writeFileSync(join(root, 'report.json'), JSON.stringify(report, null, 2))
  save()
  if (missing.length) {
    console.error(JSON.stringify({ root, error: 'Candidate scenarios are not yet implemented', missing }))
    process.exitCode = 1
  } else {
    for (const [name, ...args] of tasks) {
      const output = []
      const child = spawn(process.execPath, args, { cwd: resolve('.'), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, LCA_TEST_SILENT: '1', LCA_CONTINUITY_RUN_DIR: root, LCA_MEMORY_TEST_POSTGRES: '0' } })
      for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { output.push(chunk); process.stdout.write(chunk) })
      const code = await new Promise((done, reject) => { child.once('exit', done); child.once('error', reject) })
      writeFileSync(join(root, `${name}.log`), Buffer.concat(output))
      report.tasks.push({ name, code, log: `${name}.log` }); save()
      if (code !== 0) break
      if (fingerprint() !== report.source) { report.tasks.push({ name: 'source-changed', code: 1 }); save(); break }
    }
    report.ok = report.tasks.length === tasks.length && report.tasks.every(task => task.code === 0)
    save(); console.log(JSON.stringify({ root, ok: report.ok, mode: report.mode }))
    if (!report.ok) process.exitCode = 1
  }
}
