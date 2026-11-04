// A frozen, budgeted production-service story evaluation. Does not authorize any live request.
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { build } from 'vite'
import { _electron } from 'playwright'
import { runtimeEnv } from './runtime-env.mjs'

const repo = resolve(import.meta.dirname, '..')
const read = async file => JSON.parse(await readFile(file, 'utf8'))
const sha = async file => createHash('sha256').update(await readFile(file)).digest('hex')
const basePlan = await read(join(repo, 'scripts/memory-stories-plan.json'))
const workInterruptionOnly = process.argv.includes('--work-interruption')
const remainingStoriesOnly = process.argv.includes('--remaining-stories')
const pendingStoriesOnly = process.argv.includes('--pending-stories')
assert.ok([workInterruptionOnly, remainingStoriesOnly, pendingStoriesOnly].filter(Boolean).length <= 1, 'AMBIGUOUS_STORY_SCOPE')
const plan = { ...basePlan, ...(workInterruptionOnly ? basePlan.workInterruptionRetest : remainingStoriesOnly ? basePlan.remainingStories : pendingStoriesOnly ? basePlan.pendingStories : {}) }
const coverageScope = workInterruptionOnly ? 'work-interruption-only' : remainingStoriesOnly ? 'remaining-22-stories' : pendingStoriesOnly ? 'pending-17-stories' : 'all-24-stories'
const names = [
  'scripts/probe-memory-stories-quality.mjs', 'scripts/memory-stories-plan.json',
  'scripts/fixtures/memory-stories-quality.ts', 'scripts/fixtures/continuity-live-budget.ts',
  'tests/fixtures/continuity-stories.json', 'scripts/fixtures/memory-story-io.ts',
  'scripts/fixtures/memory-story-harness.ts', 'scripts/fixtures/memory-story-cases.ts',
  'scripts/fixtures/world-probe-stream.ts', 'scripts/fixtures/probe-response-deadline.ts',
  'scripts/fixtures/continuity-scripted-model.ts',
  'scripts/fixtures/memory-story-embedding.ts', 'scripts/fixtures/probe-transport.ts',
]
const sources = Object.fromEntries(await Promise.all(names.map(async name => [name, await sha(join(repo, name))])))
// The fixture imports production code from this checkout: refuse drift from the packaged candidate.
execFileSync('git', ['diff', '--exit-code', plan.productionCommit, '--', 'src'], { cwd: repo, stdio: 'pipe' })
const prepare = process.argv.indexOf('--prepare')
if (prepare >= 0) {
  const [preflightPath, outputPath] = process.argv.slice(prepare + 1)
  assert.ok(preflightPath && outputPath, 'PREFLIGHT_AND_OUTPUT_REQUIRED')
  const root = resolve(preflightPath), report = await read(join(root, 'report.json')), receipt = await read(join(root, 'run.json'))
  const closed = await read(join(root, 'closed.json'))
  assert.ok(report.ok && report.selfTest && report.qualityPassed === null && report.upstreamRequests === 0 && closed.ok && !closed.reuseAllowed, 'PREFLIGHT_NOT_PASSED')
  assert.deepEqual(receipt.sources, sources, 'PROBE_SOURCE_CHANGED')
  assert.equal(receipt.batch, plan.batch, 'PREFLIGHT_SCOPE_CHANGED')
  assert.equal(report.coverageScope, coverageScope, 'PREFLIGHT_SCOPE_CHANGED')
  assert.deepEqual(report.completed, plan.storyOrder, 'PREFLIGHT_SCOPE_CHANGED')
  assert.deepEqual(receipt.limits, plan.limits, 'PREFLIGHT_LIMITS_CHANGED')
  const grant = { authorized: false, authorizationId: null, batch: plan.batch, coverageScope, storyOrder: plan.storyOrder, ...plan.limits,
    expectedEmbeddingModel: plan.expectedEmbeddingModel, asarSha256: receipt.asarSha256, sources, bundleSha256: receipt.bundleSha256,
    preflight: { root, reportSha256: await sha(join(root, 'report.json')) }, firstFailureStops: true, failurePolicy: plan.failurePolicy,
    unitDefinition: 'Admission estimates, not money; autonomous is included in total.' }
  const output = resolve(outputPath); await mkdir(dirname(output), { recursive: true })
  await writeFile(output, JSON.stringify(grant, null, 2), { flag: 'wx' })
  console.log(JSON.stringify({ output, authorized: false, batch: plan.batch }))
} else {
  const selfTest = process.argv.includes('--self-test')
  assert.ok(process.env.LCA_QUALITY_RUN && process.env.LCA_TEST_EXECUTABLE, 'ISOLATED_RUN_AND_PACKAGE_REQUIRED')
  assert.ok(selfTest || process.env.LCA_REAL_MODEL === '1' && process.env.LCA_CONTINUITY_AUTH_FILE && process.env.LCA_PROVIDERS_FILE && process.env.LCA_MEMORY_CONNECTION_FILE, 'LIVE_EMBEDDING_AUTHORIZATION_REQUIRED')
  const root = resolve(process.env.LCA_QUALITY_RUN), executable = resolve(process.env.LCA_TEST_EXECUTABLE)
  const asarSha256 = await sha(join(dirname(executable), 'resources/app.asar'))
  assert.equal(asarSha256, plan.asarSha256, 'CANDIDATE_CHANGED')
  let grant
  if (!selfTest) {
    grant = await read(process.env.LCA_CONTINUITY_AUTH_FILE)
    assert.ok(grant.authorized === true && grant.authorizationId && grant.firstFailureStops === true, 'BATCH_AUTHORIZATION_REQUIRED')
    for (const name of ['batch', 'expectedEmbeddingModel', 'failurePolicy']) assert.equal(grant[name], plan[name], 'AUTHORIZATION_SCOPE_CHANGED')
    assert.equal(grant.coverageScope, coverageScope, 'AUTHORIZATION_SCOPE_CHANGED')
    assert.deepEqual(grant.storyOrder, plan.storyOrder, 'AUTHORIZATION_SCOPE_CHANGED')
    for (const [field, limit] of Object.entries(plan.limits)) assert.equal(grant[field], limit, 'LIMIT_CHANGED:' + field)
    assert.equal(grant.asarSha256, asarSha256, 'AUTHORIZED_PACKAGE_CHANGED')
    assert.deepEqual(grant.sources, sources, 'AUTHORIZED_SOURCE_CHANGED')
    assert.equal(await sha(join(grant.preflight.root, 'report.json')), grant.preflight.reportSha256, 'PREFLIGHT_CHANGED')
  }
  await mkdir(root, { recursive: true })
  await writeFile(join(root, 'claimed.json'), JSON.stringify({ selfTest, batch: plan.batch }), { flag: 'wx' })
  if (grant) {
    await writeFile(resolve(process.env.LCA_CONTINUITY_AUTH_FILE) + '.used', JSON.stringify({ root, authorizationId: grant.authorizationId }), { flag: 'wx' })
    await writeFile(join(root, 'authorization.json'), JSON.stringify(grant, null, 2), { flag: 'wx' })
  }
  let instance, timer, ok = false, cleanupUncertain = false, stage = 'compile'
  try {
    const compiled = join(repo, '.cache', 'memory-stories-quality', randomUUID(), 'probe.cjs')
    await build({ configFile: false, logLevel: 'error', build: { ssr: join(repo, 'scripts/fixtures/memory-stories-quality.ts'), outDir: dirname(compiled),
      emptyOutDir: false, minify: false, rollupOptions: { external: ['electron', '@duckdb/node-api', 'better-sqlite3'], output: { format: 'cjs', entryFileNames: 'probe.cjs' } } } })
    const bundleSha256 = await sha(compiled)
    if (grant) assert.equal(bundleSha256, grant.bundleSha256, 'AUTHORIZED_BUNDLE_CHANGED')
    await mkdir(join(root, 'bundle')); await writeFile(join(root, 'bundle', 'probe.cjs'), await readFile(compiled), { flag: 'wx' })
    await writeFile(join(root, 'run.json'), JSON.stringify({ selfTest, batch: plan.batch, coverageScope, storyOrder: plan.storyOrder, limits: plan.limits, asarSha256, sources, bundleSha256,
      productionCommit: plan.productionCommit, credentialReader: 'isolated Electron main only' }, null, 2), { flag: 'wx' })
    await mkdir(join(root, 'source'))
    for (const name of names) await writeFile(join(root, 'source', name.replaceAll('/', '__')), await readFile(join(repo, name)), { flag: 'wx' })
    const env = { ...runtimeEnv(repo), LCA_DATA_DIR: join(root, 'application'), LCA_PROVIDERS_FILE: join(root, 'absent.json'),
      LCA_TEST_SILENT: '1', LCA_MCP_PORT: '0', LCA_CDP_PORT: '0' }
    delete env.DSH_ROOT; delete env.LCA_BOOTH; delete env.ELECTRON_RENDERER_URL
    stage = 'electron-launch'
    instance = await _electron.launch({ executablePath: executable, args: [], env, timeout: 30000 })
    timer = setTimeout(() => { void instance?.close().catch(() => {}) }, 4 * 60 * 60_000)
    stage = 'story-evaluation'
    const report = await instance.evaluate(async (_, input) => process.mainModule.require(input.compiled).runMemoryStoriesQuality(input),
      { compiled, root, repo, selfTest, workInterruptionOnly, remainingStoriesOnly, pendingStoriesOnly, runtime: join(dirname(executable), 'resources/dsh-runtime'), bridge: join(dirname(executable), 'resources/lca-bridge'),
        authorized: selfTest ? undefined : resolve(process.env.LCA_PROVIDERS_FILE), embeddingConfig: selfTest ? undefined : resolve(process.env.LCA_MEMORY_CONNECTION_FILE) })
    ok = report.ok
    console.log(JSON.stringify({ root, ok, selfTest, coverageScope, qualityPassed: report.qualityPassed, fullSuitePassed: report.fullSuitePassed, completed: report.completed,
      upstreamRequests: report.upstreamRequests, counts: report.counts, error: report.error }))
  } catch (error) {
    await writeFile(join(root, 'runner-failure.json'), JSON.stringify({ error: 'STORY_QUALITY_PROBE_FAILED', stage, originalReportPreserved: true,
      ...(selfTest ? { diagnostic: error instanceof Error ? error.message : String(error) } : {}) }), { flag: 'wx' })
    console.error('STORY_QUALITY_PROBE_FAILED; preserve this run and do not automatically retry.')
  } finally {
    clearTimeout(timer); await instance?.close().catch(() => { cleanupUncertain = true })
    await writeFile(join(root, 'closed.json'), JSON.stringify({ ok: ok && !cleanupUncertain, reuseAllowed: false, cleanupUncertain }), { flag: 'wx' })
    if (!ok || cleanupUncertain) process.exitCode = 1
  }
}
