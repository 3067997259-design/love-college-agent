// Normal product -> DSH -> local scripted HTTP. Tests projection, NOT model quality.
import assert from 'node:assert/strict'
import { randomUUID, createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdir, readFile, writeFile, appendFile, readdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { _electron } from 'playwright'
import electronPath from 'electron'
import { runtimeEnv, testDataRoot, electronLaunchTarget, initializeTestBook } from './runtime-env.mjs'
import { candidateFingerprint } from './continuity-candidate.mjs'

const root = resolve(import.meta.dirname, '..'), id = randomUUID()
const dataRoot = join(testDataRoot(root), 'world-reference-' + id)
const reportDir = resolve(process.env.LCA_CONTINUITY_RUN_DIR ?? 'test-results/continuity', 'world-' + id)
await mkdir(reportDir, { recursive: true })
const cases = JSON.parse(await readFile(join(root, 'tests/fixtures/world-reference-cases.json'), 'utf8'))
const report = { ok: false, source: candidateFingerprint(), mode: 'normal-product-scripted-http', realServices: false, responseQualityAccepted: false, cases: [] }
const save = () => writeFile(join(reportDir, 'report.json'), JSON.stringify(report, null, 2))
const requests = []
const server = createServer((request, response) => { void (async () => {
  let raw = ''; for await (const chunk of request) { raw += chunk; assert.ok(raw.length < 2_000_000) }
  const body = JSON.parse(raw); requests.push(body)
  const content = body.model === 'world-chat' ? 'WORLD_SYNTHETIC_REPLY' : '{"facts":[]}'
  response.writeHead(200, { 'Content-Type': 'text/event-stream' }).end('data: ' + JSON.stringify({ choices: [{ index: 0, delta: { content }, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n')
})().catch(() => { if (!response.headersSent) response.writeHead(500); response.end() }) })
await new Promise(done => server.listen(0, '127.0.0.1', done))
let instance, page
const snapshot = () => page.evaluate(() => window.lca.getSnapshot())
const send = body => page.evaluate(async body => { const s = await window.lca.getSnapshot(); return window.lca.dispatch({ ...body, epoch: s.epoch, protocolVersion: 1, requestId: crypto.randomUUID() }) }, body)
const textOf = content => typeof content === 'string' ? content : (content ?? []).map(part => part.text ?? '').join('\n')
const files = async folder => (await Promise.all((await readdir(folder, { withFileTypes: true })).map(async e => e.isDirectory() ? files(join(folder, e.name)) : [join(folder, e.name)]))).flat()
async function stop() { await instance?.close(); instance = undefined }
async function launch(env) { instance = await _electron.launch({ ...electronLaunchTarget(root, electronPath), env, timeout: 30_000 }); page = await instance.firstWindow(); await initializeTestBook(page) }
try {
  for (const scenario of cases) {
    const data = join(dataRoot, scenario.id); await mkdir(data, { recursive: true })
    const providers = join(data, 'synthetic-providers.json'), endpoint = 'http://127.0.0.1:' + server.address().port + '/v1'
    await writeFile(providers, JSON.stringify({ providers: Object.fromEntries(['chat', 'background'].map(slot => [slot, { base_url: endpoint, api_key: 'synthetic-world-only', model: 'world-' + slot }])) }))
    const env = { ...runtimeEnv(root), LCA_DATA_DIR: data, LCA_PROVIDERS_FILE: providers, LCA_MCP_PORT: '0', LCA_CDP_PORT: '0' }
    await launch(env); const initial = await snapshot(); assert.equal(initial.runtime.developer.mode, 'normal'); await stop()
    // Seed only this closed, fresh profile. No production mutation/debug API added.
    const journals = (await files(join(data, 'journals'))).filter(file => file.endsWith('.jsonl')).sort()
    const journal = journals.at(-1), rows = (await readFile(journal, 'utf8')).trim().split('\n').map(JSON.parse)
    const now = initial.clock.nowMs, start = now - scenario.elapsedMinutes * 60_000
    const outing = { id: 'synthetic-trip-' + scenario.id, place: 'coast', status: scenario.status, startsAtMs: start, returnsAtMs: start + 3600_000, acquiredAtMs: start + 2100_000, item: 'shell', settledAtMs: ['returned', 'cut_short', 'cancelled'].includes(scenario.status) ? now : null, offline: false }
    const storedWorld = rows.findLast(row => row.type === 'life/state').view
    const world = { ...storedWorld, userSchedule: 'work', locationId: scenario.status === 'away' ? 'coast' : 'room', settledUntilMs: now, agenda: [], outings: [outing], items: scenario.hasItem ? [{ id: 'synthetic-shell', outingId: outing.id, dayKey: initial.life.dayKey, place: 'coast', kind: 'shell', acquiredAtMs: start + 2100_000, display: 'desk' }] : [] }
    await appendFile(journal, JSON.stringify({ version: 1, seq: rows.at(-1).seq + 1, atMs: now, type: 'life/state', view: world }) + '\n')
    await launch(env); const marker = 'WORLD_CASE_' + scenario.id
    assert.equal((await send({ type: 'message.send', text: marker + ' 今天去海边了吗？带回东西了吗？' })).status, 'accepted')
    let completed = false
    for (let poll = 0; poll < 300; poll++) {
      const state = await snapshot()
      if (state.task?.status === 'completed') { completed = true; break }
      await new Promise(done => setTimeout(done, 100))
    }
    assert.ok(completed, 'PRODUCT_TURN_NOT_COMPLETE')
    const wire = requests.findLast(body => body.model === 'world-chat' && JSON.stringify(body.messages).includes(marker)); assert.ok(wire, 'PRODUCT_REQUEST_MISSING')
    const references = wire.messages.flatMap(message => { try { const ref = JSON.parse(textOf(message.content).split('\n\n')[0]); return ref.worldFacts ? [ref] : [] } catch { return [] } })
    assert.equal(references.length, 1, 'WORLD_REFERENCE_MISSING')
    const ref = references[0], facts = ref.worldFacts
    const expectedStatus = scenario.afterForeground ?? scenario.status
    const group = scenario.afterForeground ? 'completedOutings' : scenario.group
    assert.equal(facts[group][0].status, expectedStatus)
    assert.equal(facts[group][0].broughtItems.length, scenario.hasItem ? 1 : 0)
    assert.equal(facts.ownedItemCount, scenario.hasItem ? 1 : 0)
    assert.equal(facts.items.length, scenario.hasItem ? 1 : 0)
    assert.ok(!Object.hasOwn(facts[group][0], 'item')); assert.ok(!Object.hasOwn(facts[group][0], 'acquiredAtMs'))
    assert.ok(ref.worldFactsNote.includes('计划时间经过')); assert.ok(ref.currentTime.local)
    assert.equal(ref.actualOfflineWork, false)
    const after = await snapshot(); assert.equal(after.life.outings.find(o => o.id === outing.id).status, expectedStatus)
    await writeFile(join(reportDir, scenario.id + '.json'), JSON.stringify({ reference: ref, expectedStatus, modelResponseIsSynthetic: true }, null, 2))
    report.cases.push({ id: scenario.id, ok: true, expectedStatus, referenceSha256: createHash('sha256').update(JSON.stringify(ref)).digest('hex') }); await save(); await stop()
  }
  assert.equal(candidateFingerprint(), report.source); report.ok = true
} catch (error) {
  report.error = error instanceof Error ? error.message : 'WORLD_SCENARIO_FAILED'; process.exitCode = 1
  await writeFile(join(reportDir, 'synthetic-requests.json'), JSON.stringify(requests, null, 2))
  if (page && !page.isClosed()) { const state = await snapshot(); report.lastTask = state.task; report.lastFailure = state.messages.findLast(message => message.role === 'assistant')?.failure }
}
finally { await stop(); server.closeAllConnections(); await new Promise(done => server.close(done)); await save() }
console.log(JSON.stringify({ ok: report.ok, reportDir, cases: report.cases, error: report.error }))
