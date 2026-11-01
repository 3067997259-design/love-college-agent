// Focused candidate package gate: no installation, no daily profile and no real services.
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { globSync, readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { runtimeEnv, testDataRoot } from './runtime-env.mjs'
import { candidateFingerprint } from './continuity-candidate.mjs'

const root = resolve(import.meta.dirname, '..'), release = resolve(process.env.LCA_RELEASE_DIR ?? 'release')
const receipt = JSON.parse(readFileSync(join(release, 'build-receipt.json'), 'utf8'))
const sha = path => createHash('sha256').update(readFileSync(path)).digest('hex')
assert.equal(sha(join(release, receipt.installerFileName)), receipt.installerSha256)
assert.equal(sha(join(release, 'win-unpacked/resources/app.asar')), receipt.asarSha256)
const unpacked = join(release, 'win-unpacked'), exe = join(unpacked, 'LoveCollegeAgent.exe')
assert.ok(statSync(exe).isFile())
assert.ok(globSync('resources/app.asar.unpacked/**/duckdb*.node', { cwd: unpacked }).length > 0, 'DUCKDB_NATIVE_MISSING')
assert.ok(globSync('resources/app.asar.unpacked/**/*duckdb*.dll', { cwd: unpacked }).length > 0, 'DUCKDB_DLL_MISSING')
assert.ok(globSync('resources/app.asar.unpacked/**/better-sqlite3/prebuilds/win32-x64.node', { cwd: unpacked }).length > 0, 'SQLITE_NATIVE_MISSING')
assert.ok(statSync(join(unpacked, 'resources/licenses/airi-memory-LICENSE.txt')).isFile())
const evidence = resolve(process.env.LCA_CONTINUITY_RUN_DIR ?? 'test-results/continuity', 'package-' + randomUUID())
mkdirSync(evidence, { recursive: true })
const report = { ok: false, source: candidateFingerprint(), receipt, target: 'unpacked', installed: false, realServices: false, checks: [] }
const save = () => writeFileSync(join(evidence, 'report.json'), JSON.stringify(report, null, 2)); save()
async function run(name, executable, args, extra = {}) {
  const data = join(testDataRoot(root), 'package-' + name + '-' + randomUUID())
  mkdirSync(data, { recursive: true })
  const child = spawn(executable, args, { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...runtimeEnv(root), LCA_DATA_DIR: data, LCA_PROVIDERS_FILE: join(data, 'absent.json'), ...extra } })
  const chunks = []; child.stdout.on('data', chunk => chunks.push(chunk)); child.stderr.on('data', chunk => chunks.push(chunk))
  let timedOut = false; const timer = setTimeout(() => { timedOut = true; child.kill() }, 180_000)
  const code = await new Promise((done, reject) => { child.once('error', reject); child.once('exit', done) }); clearTimeout(timer)
  const output = Buffer.concat(chunks); writeFileSync(join(evidence, name + '.log'), output)
  report.checks.push({ name, code, timedOut, log: name + '.log' }); save()
  assert.equal(code, 0, 'PACKAGE_SCENARIO_FAILED:' + name); assert.equal(timedOut, false)
  return output.toString('utf8')
}
for (const name of ['sqlite', 'continuity']) {
  const output = await run(name, exe, ['--lca-probe=' + name])
  const line = output.split(/\r?\n/).find(line => line.startsWith('LCA_PROBE:'))
  assert.ok(line); assert.equal(JSON.parse(line.slice(10)).ok, true)
}
for (const name of ['memory', 'v12-recovery']) await run(name, process.execPath, [join(root, 'scripts/smoke-' + name + '.mjs')], { LCA_TEST_EXECUTABLE: exe })
assert.equal(candidateFingerprint(), report.source, 'PACKAGE_TEST_SOURCE_CHANGED')
report.ok = true; save(); console.log(JSON.stringify({ ok: true, evidence, target: report.target, checks: report.checks.map(check => check.name) }))
