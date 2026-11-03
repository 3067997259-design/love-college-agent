// Supplemental adapter check, not the normal-product memory lifecycle or a quality evaluation.
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { build } from 'vite'
import { _electron } from 'playwright'
import { runtimeEnv } from './runtime-env.mjs'

const repo = resolve(import.meta.dirname, '..')
const read = async file => JSON.parse(await readFile(file, 'utf8'))
const sha = async file => createHash('sha256').update(await readFile(file)).digest('hex')
const plan = await read(join(repo, 'scripts/embedding-input-plan.json'))
const names = [
  'scripts/probe-embedding-inputs.mjs', 'scripts/embedding-input-plan.json',
  'scripts/fixtures/embedding-input-probe.ts', 'scripts/fixtures/continuity-live-budget.ts',
  'src/main/memory/airi/embedding.ts', 'src/main/resources/service.ts', 'src/main/clock/index.ts',
]
const sources = Object.fromEntries(await Promise.all(names.map(async name => [name, await sha(join(repo, name))])))
const prepareIndex = process.argv.indexOf('--prepare')
if (prepareIndex >= 0) {
  const [preflightPath, outputPath] = process.argv.slice(prepareIndex + 1)
  assert.ok(preflightPath && outputPath, 'PREFLIGHT_AND_OUTPUT_REQUIRED')
  const root = resolve(preflightPath), report = await read(join(root, 'report.json')), receipt = await read(join(root, 'run.json'))
  const closed = await read(join(root, 'closed.json'))
  assert.ok(report.ok && report.selfTest && report.upstreamRequests === 0 && closed.ok && closed.reuseAllowed === false, 'PREFLIGHT_NOT_PASSED')
  assert.deepEqual(receipt.sources, sources, 'PROBE_SOURCE_CHANGED')
  assert.deepEqual(receipt.limits, plan.limits, 'LIMITS_CHANGED')
  const grant = { authorized: false, authorizationId: null, batch: plan.batch, ...plan.limits, expectedModel: plan.expectedModel,
    asarSha256: receipt.asarSha256, sources, bundleSha256: receipt.bundleSha256,
    preflight: { root, reportSha256: await sha(join(root, 'report.json')) },
    firstFailureStops: true, unitDefinition: 'Admission estimates, not money; autonomous is included in total.' }
  const output = resolve(outputPath); await mkdir(dirname(output), { recursive: true })
  await writeFile(output, JSON.stringify(grant, null, 2), { flag: 'wx' })
  console.log(JSON.stringify({ output, authorized: false, batch: plan.batch }))
} else {
  const selfTest = process.argv.includes('--self-test')
  assert.ok(process.env.LCA_EMBEDDING_PROBE_RUN && process.env.LCA_TEST_EXECUTABLE, 'ISOLATED_RUN_AND_PACKAGE_REQUIRED')
  assert.ok(selfTest || process.env.LCA_REAL_EMBEDDING === '1', 'LIVE_EMBEDDING_OPT_IN_REQUIRED')
  assert.ok(selfTest || process.env.LCA_CONTINUITY_AUTH_FILE && process.env.LCA_MEMORY_CONNECTION_FILE, 'EMBEDDING_AUTHORIZATION_REQUIRED')
  const root = resolve(process.env.LCA_EMBEDDING_PROBE_RUN), executable = resolve(process.env.LCA_TEST_EXECUTABLE)
  const asarSha256 = await sha(join(dirname(executable), 'resources/app.asar'))
  let grant
  if (!selfTest) {
    grant = await read(process.env.LCA_CONTINUITY_AUTH_FILE)
    assert.ok(grant.authorized === true && grant.authorizationId && grant.firstFailureStops === true, 'BATCH_AUTHORIZATION_REQUIRED')
    assert.equal(grant.batch, plan.batch, 'AUTHORIZATION_SCOPE_MISMATCH')
    assert.equal(grant.expectedModel, plan.expectedModel, 'AUTHORIZED_MODEL_CHANGED')
    for (const [field, limit] of Object.entries(plan.limits)) assert.equal(grant[field], limit, 'LIMIT_CHANGED:' + field)
    assert.equal(grant.asarSha256, asarSha256, 'AUTHORIZED_PACKAGE_CHANGED')
    assert.deepEqual(grant.sources, sources, 'AUTHORIZED_SOURCE_CHANGED')
    assert.equal(await sha(join(grant.preflight.root, 'report.json')), grant.preflight.reportSha256, 'PREFLIGHT_CHANGED')
  }
  await mkdir(root, { recursive: true })
  // Claim both the run and authorization once. Failed or uncertain attempts cannot reset a ledger.
  await writeFile(join(root, 'claimed.json'), JSON.stringify({ selfTest, batch: plan.batch }), { flag: 'wx' })
  if (grant) {
    await writeFile(resolve(process.env.LCA_CONTINUITY_AUTH_FILE) + '.used', JSON.stringify({ root, authorizationId: grant.authorizationId }), { flag: 'wx' })
    await writeFile(join(root, 'authorization.json'), JSON.stringify(grant, null, 2), { flag: 'wx' })
  }
  let instance, timer, ok = false, cleanupUncertain = false, stage = 'compile'
  try {
    // Native dependencies resolve from this checkout, just as in the existing continuity harness.
    const compiled = join(repo, '.cache', 'embedding-input-probe', randomUUID(), 'probe.cjs')
    await build({ configFile: false, logLevel: 'error', build: { ssr: join(repo, 'scripts/fixtures/embedding-input-probe.ts'), outDir: dirname(compiled),
      emptyOutDir: false, minify: false, rollupOptions: { external: ['electron'], output: { format: 'cjs', entryFileNames: 'probe.cjs' } } } })
    const bundleSha256 = await sha(compiled)
    if (grant) assert.equal(bundleSha256, grant.bundleSha256, 'AUTHORIZED_BUNDLE_CHANGED')
    await mkdir(join(root, 'bundle'))
    await writeFile(join(root, 'bundle', 'probe.cjs'), await readFile(compiled), { flag: 'wx' })
    const receipt = { selfTest, batch: plan.batch, limits: plan.limits, asarSha256, sources, bundleSha256, credentialReader: 'isolated Electron main only' }
    await writeFile(join(root, 'run.json'), JSON.stringify(receipt, null, 2), { flag: 'wx' })
    await mkdir(join(root, 'source'))
    for (const name of names) await writeFile(join(root, 'source', name.replaceAll('/', '__')), await readFile(join(repo, name)), { flag: 'wx' })
    const env = { ...runtimeEnv(repo), LCA_DATA_DIR: join(root, 'application'), LCA_PROVIDERS_FILE: join(root, 'absent.json'), LCA_TEST_SILENT: '1', LCA_MCP_PORT: '0', LCA_CDP_PORT: '0' }
    delete env.DSH_ROOT; delete env.LCA_BOOTH; delete env.ELECTRON_RENDERER_URL
    stage = 'electron-launch'
    instance = await _electron.launch({ executablePath: executable, args: [], env, timeout: 30000 })
    timer = setTimeout(() => { void instance?.close().catch(() => {}) }, 90_000)
    stage = 'adapter-checks'
    const report = await instance.evaluate(async (_, input) => process.mainModule.require(input.compiled).runEmbeddingInputProbe(input),
      { compiled, root, selfTest, authorized: selfTest ? undefined : resolve(process.env.LCA_MEMORY_CONNECTION_FILE) })
    ok = report.ok
    console.log(JSON.stringify({ root, ...report }))
  } catch {
    // Connection material and upstream exceptions never leave main or enter ordinary logs.
    await writeFile(join(root, 'runner-failure.json'), JSON.stringify({ error: 'EMBEDDING_PROBE_FAILED', stage, originalReportPreserved: true }), { flag: 'wx' })
    console.error('EMBEDDING_PROBE_FAILED; preserve this run and do not automatically retry.')
  } finally {
    clearTimeout(timer)
    await instance?.close().catch(() => { cleanupUncertain = true })
    await writeFile(join(root, 'closed.json'), JSON.stringify({ ok: ok && !cleanupUncertain, reuseAllowed: false, cleanupUncertain }), { flag: 'wx' })
    if (!ok || cleanupUncertain) process.exitCode = 1
  }
}
