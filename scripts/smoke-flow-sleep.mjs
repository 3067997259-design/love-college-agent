import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, appendFile, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron } from 'playwright'
import electronPath from 'electron'
import { runtimeEnv, initializeTestBook, electronLaunchTarget } from './runtime-env.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const data = join(root, '.local-data', 'flow-sleep-' + randomUUID())
let pendingSummary; let summaryCalls = 0
const server = createServer((request, response) => { void (async () => {
  let text = ''; for await (const chunk of request) text += chunk
  const body = JSON.parse(text); const summary = body.messages[0].content.includes('{lines:')
  const input = JSON.parse(body.messages[1].content)
  assert.equal(body.model, 'synthetic-slow-memory'); assert.deepEqual(body.tools ?? [], [])
  const respond = (output) => response.writeHead(200, { 'Content-Type': 'text/event-stream' }).end('data: ' + JSON.stringify({ choices: [{ index: 0, delta: { content: JSON.stringify(output) }, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n')
  if (summary) { summaryCalls++; assert.ok(input.length); pendingSummary = () => respond({ lines: [{ sourceId: input[0].id, quote: input[0].text.slice(0, 80) }] }) }
  else respond({ items: [] })
})().catch(() => { if (!response.headersSent) response.writeHead(500); response.end() }) })
await new Promise((done) => server.listen(0, '127.0.0.1', done)); await mkdir(data, { recursive: true })
const providers = join(data, 'synthetic-providers.json')
await writeFile(providers, JSON.stringify({ providers: { background: { base_url: 'http://127.0.0.1:' + server.address().port + '/v1', api_key: 'synthetic-test-only', model: 'synthetic-slow-memory' } } }))
const env = { ...runtimeEnv(root), LCA_DATA_DIR: data, LCA_PROVIDERS_FILE: providers }
let instance; let page
const snapshot = () => page.evaluate(() => window.lca.getSnapshot())
const send = (body) => page.evaluate(async (body) => { const s = await window.lca.getSnapshot(); return window.lca.dispatch({ protocolVersion: 1, epoch: s.epoch, requestId: crypto.randomUUID(), ...body }) }, body)
async function waitFor(predicate, code) { for (let i = 0; i < 200; i++) { if (predicate(await snapshot())) return; await new Promise((done) => setTimeout(done, 100)) }; throw new Error(code) }
async function launch() { instance = await _electron.launch({ ...electronLaunchTarget(root, electronPath), env }); page = await instance.firstWindow(); await initializeTestBook(page) }
async function stop() { await instance?.close(); instance = undefined }
try {
  await launch(); assert.equal((await snapshot()).runtime.developer.mode, 'normal'); await stop()
  // Append synthetic completed conversations only to this script's isolated profile.
  // On reopen the real journal/SQLite replay and normal automatic compaction run.
  const journals = join(data, 'journals'); const owner = (await readdir(journals))[0]; const folder = join(journals, owner)
  const journal = join(folder, (await readdir(folder)).filter((name) => name.endsWith('.jsonl')).sort().at(-1))
  const rows = (await readFile(journal, 'utf8')).trim().split('\n').map((line) => JSON.parse(line)); let seq = rows.at(-1).seq
  const atMs = Date.now(); const fixture = []
  const append = (body) => fixture.push(JSON.stringify({ version: 1, seq: ++seq, atMs, ...body }))
  for (let i = 0; i < 8; i++) {
    const id = 'synthetic-user-' + i; const turnId = 'synthetic-turn-' + i; const text = 'Synthetic seen conversation ' + i + ': ' + 'plain material '.repeat(320)
    append({ type: 'turn/start', turnId, trigger: 'user' })
    append({ type: 'user/message', id, text, requestId: id, commandHash: id }); append({ type: 'inbox/drain', ids: [id] })
    append({ type: 'model/seen', turnId, source: 'fake', messages: [{ role: 'user', content: text }], eligibleIndexes: [0] })
    append({ type: 'assistant/message', id: 'synthetic-reply-' + i, turnId, text: 'Synthetic reply ' + i, status: 'complete' })
    append({ type: 'turn/end', turnId, reason: 'completed' })
  }
  await appendFile(journal, fixture.join('\n') + '\n'); await launch()
  assert.ok((await snapshot()).memory.contextChars > 24000)
  await page.getByRole('button', { name: '工具与设置', exact: true }).click()
  await page.getByRole('button', { name: '进入心流', exact: true }).click()
  await waitFor(() => !!pendingSummary, 'SLOW_COMPACTION_NOT_REACHED')
  assert.equal((await snapshot()).heartFlow.activeId, null); assert.equal((await snapshot()).memory.status, 'compacting')
  await page.getByRole('button', { name: '让她休息', exact: true }).click()
  await page.getByRole('region', { name: '她的生活', exact: true }).getByRole('alert').filter({ hasText: 'unavailable' }).waitFor()
  assert.equal((await snapshot()).companion.sleeping, false)
  pendingSummary(); pendingSummary = undefined
  await waitFor((s) => !!s.heartFlow.activeId, 'PREPARED_FLOW_MISSING')
  assert.equal(summaryCalls, 1); assert.equal((await snapshot()).companion.sleeping, false); assert.equal((await snapshot()).companion.pose, 'desk-computer')
  await page.getByRole('button', { name: '退出心流', exact: true }).click()
  await waitFor((s) => !s.heartFlow.activeId, 'FLOW_EXIT_FAILED')
  await page.getByRole('button', { name: '工具与设置', exact: true }).click()
  await page.getByRole('button', { name: '让她休息', exact: true }).click()
  await waitFor((s) => s.companion.sleeping && s.companion.pose === 'sleeping', 'POST_FLOW_SLEEP_FAILED')
  await stop(); await launch()
  assert.equal((await snapshot()).companion.sleeping, true); assert.equal((await snapshot()).heartFlow.activeId, null)
  assert.equal((await send({ type: 'companion.sleep', sleeping: false })).status, 'accepted')
  await mkdir(join(root, 'test-results'), { recursive: true })
  await writeFile(join(root, 'test-results/flow-sleep-report.json'), JSON.stringify({ ok: true, atIso: new Date().toISOString(), mode: 'normal', syntheticSeenHistory: true, realAutomaticCompactionClient: true, slowSyntheticHttp: true, nativeButtons: true, sleepRefusedDuringPrepare: true, completedFlowThenSleep: true, restartConsistent: true, liveProviderUsed: false }, null, 2))
  console.log('Flow/sleep race passed: normal Electron, real automatic compaction held at synthetic HTTP, native sleep refusal during preparation, flow completion/exit, sleep and restart consistency. No live provider.')
} finally { await stop(); server.closeAllConnections(); await new Promise((done) => server.close(done)) }
