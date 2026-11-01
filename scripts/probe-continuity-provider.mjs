// Explicitly bounded provider diagnostics. Only the isolated Electron main reads the selected connection.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { build } from 'vite'
import { _electron } from 'playwright'
import { runtimeEnv } from './runtime-env.mjs'

const root = resolve(import.meta.dirname, '..'), selfTest = process.argv.includes('--self-test')
assert.ok(selfTest || process.env.LCA_REAL_MODEL === '1', 'LIVE_OPT_IN_REQUIRED')
assert.ok(process.env.LCA_TEST_EXECUTABLE, 'PACKAGED_EXECUTABLE_REQUIRED')
assert.ok(process.env.LCA_PROVIDER_PROBE_RUN, 'FIXED_RUN_DIRECTORY_REQUIRED')
assert.ok(selfTest || process.env.LCA_PROVIDERS_FILE, 'AUTHORIZED_CONNECTION_REQUIRED')
const data = resolve(process.env.LCA_PROVIDER_PROBE_RUN), reportFile = join(data, 'report.json')
mkdirSync(data, { recursive: true })
// An existing receipt is never replaced by a fresh ledger after a failed or uncertain run.
const executable = resolve(process.env.LCA_TEST_EXECUTABLE)
const hash = file => createHash('sha256').update(readFileSync(file)).digest('hex')
const receipt = { selfTest, authorizedMaximumCalls: 8, authorizedMaximumReservedUnits: 128000, zeroAutonomousBudget: true,
  executable, asarSha256: hash(join(dirname(executable), 'resources/app.asar')), scriptSha256: hash(import.meta.filename),
  fixtureSha256: hash(join(root, 'scripts/fixtures/continuity-provider.ts')), providerConfigReadBy: 'Electron main only' }
writeFileSync(join(data, 'run.json'), JSON.stringify(receipt, null, 2), { flag: 'wx' })
const compiled = join(root, '.cache', 'continuity-provider-probe'); mkdirSync(compiled, { recursive: true })
await build({ configFile: false, logLevel: 'error', build: { ssr: join(root, 'scripts/fixtures/continuity-provider.ts'), outDir: compiled,
  emptyOutDir: false, minify: false, rollupOptions: { external: ['electron'], output: { format: 'cjs', entryFileNames: 'main.cjs' } } } })
const env = { ...runtimeEnv(root), LCA_DATA_DIR: join(data, 'application'), LCA_PROVIDERS_FILE: join(data, 'absent.json'), LCA_TEST_SILENT: '1', LCA_MCP_PORT: '0', LCA_CDP_PORT: '0' }
delete env.DSH_ROOT; delete env.LCA_BOOTH; delete env.ELECTRON_RENDERER_URL
let instance, timer
try {
  instance = await _electron.launch({ executablePath: executable, args: [], env, timeout: 30000 })
  timer = setTimeout(() => { void instance?.close().catch(() => {}) }, 6 * 60_000)
  const result = await instance.evaluate(async (_, input) => {
    const probe = process.mainModule.require(input.compiled)
    return probe.runProviderProbe({ data: input.data, authorized: input.authorized, reportFile: input.reportFile, selfTest: input.selfTest })
  }, { compiled: join(compiled, 'main.cjs'), data, authorized: selfTest ? '' : resolve(process.env.LCA_PROVIDERS_FILE), reportFile, selfTest })
  console.log(JSON.stringify({ ...result, report: reportFile, selfTest }))
  if (!result.ok) process.exitCode = 1
} catch {
  writeFileSync(join(data, 'runner-failure.json'), JSON.stringify({ error: 'RUNNER_FAILED', existingReportPreserved: true }))
  console.error('RUNNER_FAILED; details suppressed; keep this run directory and do not automatically retry.')
  process.exitCode = 1
} finally { clearTimeout(timer); await instance?.close().catch(() => {}) }
