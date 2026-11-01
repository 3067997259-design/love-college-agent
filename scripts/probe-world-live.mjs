// Fixed package, fresh profiles, explicit per-case semantic review. No automatic live retries.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile, appendFile, readdir, access } from 'node:fs/promises'
import { join, resolve, dirname } from 'node:path'
import { build } from 'vite'
import { _electron } from 'playwright'
import { runtimeEnv, initializeTestBook } from './runtime-env.mjs'

const repo = resolve(import.meta.dirname, '..'), selfTest = process.argv.includes('--self-test')
assert.ok(selfTest || process.env.LCA_REAL_MODEL === '1', 'LIVE_OPT_IN_REQUIRED')
assert.ok(process.env.LCA_WORLD_PROBE_RUN && process.env.LCA_TEST_EXECUTABLE, 'FIXED_RUN_AND_PACKAGE_REQUIRED')
assert.ok(selfTest || process.env.LCA_PROVIDERS_FILE, 'AUTHORIZED_CONNECTION_REQUIRED')
const root = resolve(process.env.LCA_WORLD_PROBE_RUN), exe = resolve(process.env.LCA_TEST_EXECUTABLE)
const sha = async file => createHash('sha256').update(await readFile(file)).digest('hex')
await mkdir(root, { recursive: true })
const receipt = { selfTest, maximumCalls: 12, maximumReservedUnits: 256000, autonomousUnits: 0,
  asarSha256: await sha(join(dirname(exe), 'resources/app.asar')), runnerSha256: await sha(import.meta.filename),
  gatewaySha256: await sha(join(repo, 'scripts/fixtures/world-live-gateway.ts')), parserSha256: await sha(join(repo, 'scripts/fixtures/world-probe-stream.ts')),
  admissionReaderSha256: await sha(join(repo, 'scripts/fixtures/world-probe-admission.ts')),
  casesSha256: await sha(join(repo, 'tests/fixtures/world-reference-cases.json')) }
await writeFile(join(root, 'run.json'), JSON.stringify(receipt, null, 2), { flag: 'wx' })
const compiled = join(repo, '.cache/world-live-probe')
await build({ configFile: false, logLevel: 'error', build: { ssr: join(repo, 'scripts/fixtures/world-live-gateway.ts'), outDir: compiled, emptyOutDir: false, minify: false, rollupOptions: { external: ['electron'], output: { format: 'cjs', entryFileNames: 'gateway.cjs' } } } })
const frozen = join(root, 'source'); await mkdir(frozen)
const sourceFiles = { 'runner.mjs': import.meta.filename, 'gateway.ts': join(repo, 'scripts/fixtures/world-live-gateway.ts'),
  'parser.ts': join(repo, 'scripts/fixtures/world-probe-stream.ts'), 'admission.ts': join(repo, 'scripts/fixtures/world-probe-admission.ts'),
  'gateway.cjs': join(compiled, 'gateway.cjs'), 'cases.json': join(repo, 'tests/fixtures/world-reference-cases.json') }
const sourceHashes = {}
for (const [name, file] of Object.entries(sourceFiles)) { await writeFile(join(frozen, name), await readFile(file), { flag: 'wx' }); sourceHashes[name] = await sha(file) }
await writeFile(join(root, 'source-manifest.json'), JSON.stringify(sourceHashes, null, 2), { flag: 'wx' })
const cases = JSON.parse(await readFile(join(repo, 'tests/fixtures/world-reference-cases.json'), 'utf8'))
const report = { ok: false, selfTest, normalProduct: true, cases: [], receipt, error: null }
const save = () => writeFile(join(root, 'report.json'), JSON.stringify(report, null, 2))
const env = { ...runtimeEnv(repo), LCA_TEST_SILENT: '1', LCA_MCP_PORT: '0', LCA_CDP_PORT: '0' }
delete env.ELECTRON_RENDERER_URL; delete env.LCA_BOOTH; delete env.DSH_ROOT
let helper, instance, page
const snapshot = () => page.evaluate(() => window.lca.getSnapshot())
const send = body => page.evaluate(async body => { const s = await window.lca.getSnapshot(); return window.lca.dispatch({ ...body, epoch: s.epoch, protocolVersion: 1, requestId: crypto.randomUUID() }) }, body)
const walk = async dir => (await Promise.all((await readdir(dir, { withFileTypes: true })).map(async e => e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]))).flat()
const close = async () => { await instance?.close(); instance = undefined }
async function launch(data, providers) { instance = await _electron.launch({ executablePath: exe, args: [], env: { ...env, LCA_DATA_DIR: data, LCA_PROVIDERS_FILE: providers }, timeout: 30000 }); page = await instance.firstWindow(); await initializeTestBook(page) }
try {
  helper = await _electron.launch({ executablePath: exe, args: [], env: { ...env, LCA_DATA_DIR: join(root, 'helper'), LCA_PROVIDERS_FILE: join(root, 'absent.json') }, timeout: 30000 })
  const providers = await helper.evaluate(async (_, options) => {
    globalThis.worldProbeGateway = await process.mainModule.require(options.compiled).startWorldGateway(options)
    return globalThis.worldProbeGateway.providersFile
  }, { root, selfTest, authorized: selfTest ? '' : resolve(process.env.LCA_PROVIDERS_FILE), compiled: join(compiled, 'gateway.cjs') })
  for (const scenario of cases) {
    const data = join(root, 'profiles', scenario.id); await mkdir(data, { recursive: true })
    // Prepare the closed synthetic life state without exposing a new production write API.
    await launch(data, join(root, 'absent.json')); const initial = await snapshot(); await close()
    const journal = (await walk(join(data, 'journals'))).filter(f => f.endsWith('.jsonl')).sort().at(-1)
    const rows = (await readFile(journal, 'utf8')).trim().split('\n').map(JSON.parse), now = initial.clock.nowMs, start = now - scenario.elapsedMinutes * 60000
    const outing = { id: 'synthetic-trip-' + scenario.id, place: 'coast', status: scenario.status, startsAtMs: start, returnsAtMs: start + 3600000, acquiredAtMs: start + 2100000, item: 'shell', settledAtMs: ['returned', 'cut_short', 'cancelled'].includes(scenario.status) ? now : null, offline: false }
    const view = { ...rows.findLast(r => r.type === 'life/state').view, userSchedule: 'work', locationId: scenario.status === 'away' ? 'coast' : 'room', settledUntilMs: now, agenda: [], outings: [outing], items: scenario.hasItem ? [{ id: 'synthetic-shell', outingId: outing.id, dayKey: initial.life.dayKey, place: 'coast', kind: 'shell', acquiredAtMs: start + 2100000, display: 'desk' }] : [] }
    await appendFile(journal, JSON.stringify({ version: 1, seq: rows.at(-1).seq + 1, atMs: now, type: 'life/state', view }) + '\n')
    await launch(data, providers)
    await helper.evaluate((_, input) => globalThis.worldProbeGateway.active(input.id, input.profile), { id: scenario.id, profile: data })
    assert.equal((await snapshot()).runtime.developer.mode, 'normal')
    assert.equal((await send({ type: 'message.send', text: '今天去海边了吗？带回东西了吗？' })).status, 'accepted')
    let completed
    for (let poll = 0; poll < 1200; poll++) {
      const state = await snapshot(), gateway = await helper.evaluate(() => globalThis.worldProbeGateway.state())
      assert.equal(gateway.halted, false, 'GATEWAY_STOPPED')
      const samples = gateway.samples.filter(sample => sample.caseId === scenario.id)
      // The product may publish its answer before the relay consumes the stream tail.
      if (state.task?.status === 'completed' && samples.length > 0 && samples.every(sample => sample.ok && sample.settled)) { completed = state; break }
      assert.ok(!['waiting', 'queued'].includes(state.question?.status), 'UNEXPECTED_APPROVAL_OR_QUESTION')
      await new Promise(done => setTimeout(done, 100))
    }
    assert.ok(completed, 'TURN_TIMEOUT')
    const answer = completed.messages.findLast(m => m.role === 'assistant' && m.status === 'complete')
    assert.ok(answer?.text && !answer.failure, 'ANSWER_FAILED')
    const reference = JSON.parse(await readFile(join(root, scenario.id + '-reference.json'), 'utf8'))
    const status = scenario.afterForeground ?? scenario.status, group = scenario.afterForeground ? 'completedOutings' : scenario.group
    assert.equal(reference.worldFacts[group][0].status, status)
    assert.equal(reference.worldFacts.ownedItemCount, scenario.hasItem ? 1 : 0)
    const sample = { id: scenario.id, expectedStatus: status, expectedItemCount: scenario.hasItem ? 1 : 0, reference, answer: answer.text, responseQualityAccepted: false }
    await writeFile(join(root, scenario.id + '-answer.json'), JSON.stringify(sample, null, 2))
    await close()
    if (selfTest) sample.review = { accepted: true, synthetic: true }
    else {
      console.log(JSON.stringify({ reviewRequired: scenario.id, file: join(root, scenario.id + '-answer.json'), reviewFile: join(root, scenario.id + '-review.json') }))
      let review
      for (let poll = 0; poll < 600; poll++) {
        const file = join(root, scenario.id + '-review.json')
        try { await access(file); review = JSON.parse(await readFile(file, 'utf8')); break } catch (error) { if (error.code !== 'ENOENT') throw error }
        await new Promise(done => setTimeout(done, 500))
      }
      assert.ok(review && review.caseId === scenario.id && typeof review.reason === 'string', 'SEMANTIC_REVIEW_REQUIRED')
      sample.review = review; sample.responseQualityAccepted = review.accepted === true
    }
    report.cases.push(sample); await save()
    assert.equal(sample.review.accepted, true, 'SEMANTIC_REVIEW_FAILED')
  }
  if (selfTest) assert.equal(await helper.evaluate(() => globalThis.worldProbeGateway.selfTestLimits()), true)
  report.gateway = await helper.evaluate(() => globalThis.worldProbeGateway.state())
  assert.ok(report.gateway.calls <= 12 && report.gateway.reservedUnits <= 256000 && report.gateway.autonomousUnits === 0)
  report.ok = true
} catch (error) { report.error = error.message?.match(/^[A-Z][A-Z_]+/)?.[0] ?? 'WORLD_PROBE_FAILED'; process.exitCode = 1 }
finally {
  await close().catch(() => {})
  if (helper) { try { report.gateway ??= await helper.evaluate(() => globalThis.worldProbeGateway?.state()); await helper.evaluate(async () => { await globalThis.worldProbeGateway?.close() }) } catch { report.cleanupUncertain = true }; await helper.close().catch(() => {}) }
  await save()
}
console.log(JSON.stringify({ ok: report.ok, selfTest, cases: report.cases.map(c => ({ id: c.id, accepted: c.review.accepted })), gateway: report.gateway, error: report.error, report: join(root, 'report.json') }))
