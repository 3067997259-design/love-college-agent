import assert from 'node:assert/strict'
import { randomUUID, createHash } from 'node:crypto'
import { mkdir, readFile, writeFile, appendFile, readdir } from 'node:fs/promises'
import { createServer } from 'node:http'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron } from 'playwright'
import electronPath from 'electron'
import { runtimeEnv, initializeTestBook, electronLaunchTarget } from './runtime-env.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..'); const data = join(root, '.local-data', 'life-port-' + randomUUID())
const requests = []; let scenario = 'ready'; let aborted = 0
const server = createServer((request, response) => { void (async () => {
  let text = ''; for await (const chunk of request) text += chunk
  const body = JSON.parse(text); let input = {}; try { input = JSON.parse(body.messages[1].content) } catch { /* Ordinary chat is not a JSON work task. */ }
  requests.push({ model: body.model, input, messages: body.messages, tools: body.tools })
  const work = body.model === 'synthetic-life-background' && ['read', 'write'].includes(input.kind)
  if (work && scenario === 'hold') { response.on('close', () => { if (!response.writableEnded) aborted++ }); return }
  const result = work ? scenario === 'invalid' ? { markdown: '', extra: true } : { markdown: (input.previous ? input.previous + '\n\n' : '') + '# NORMAL_TRANSPORT_PRODUCT ' + input.kind + ' ' + input.step } : null
  const content = work ? JSON.stringify(result) : 'NORMAL_PUBLIC_SYNTHETIC_REPLY'
  response.writeHead(200, { 'Content-Type': 'text/event-stream' }).end('data: ' + JSON.stringify({ choices: [{ index: 0, delta: { content }, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n')
})().catch(() => { if (!response.headersSent) response.writeHead(500); response.end() }) })
await new Promise((done) => server.listen(0, '127.0.0.1', done)); await mkdir(data, { recursive: true })
const providers = join(data, 'synthetic-providers.json'); const endpoint = 'http://127.0.0.1:' + server.address().port + '/v1'
await writeFile(providers, JSON.stringify({ providers: { chat: { base_url: endpoint, api_key: 'synthetic-test-only', model: 'synthetic-life-chat' }, background: { base_url: endpoint, api_key: 'synthetic-test-only', model: 'synthetic-life-background' } } }))
const env = { ...runtimeEnv(root), LCA_DATA_DIR: data, LCA_PROVIDERS_FILE: providers }; let instance; let page
const snapshot = () => page.evaluate(() => window.lca.getSnapshot())
const send = (body) => page.evaluate(async (body) => { const s = await window.lca.getSnapshot(); return window.lca.dispatch({ protocolVersion: 1, epoch: s.epoch, requestId: crypto.randomUUID(), ...body }) }, body)
async function accepted(body) { assert.equal((await send(body)).status, 'accepted', body.type) }
async function waitFor(predicate, code) { for (let i = 0; i < 250; i++) { if (predicate(await snapshot())) return; await new Promise((done) => setTimeout(done, 100)) }; throw new Error(code) }
async function launch() { instance = await _electron.launch({ ...electronLaunchTarget(root, electronPath), env }); page = await instance.firstWindow(); await initializeTestBook(page) }
async function stop() { await instance?.close(); instance = undefined }
const job = async (kind) => (await snapshot()).life.work.jobs.find((item) => item.kind === kind)
const hash = (text) => createHash('sha256').update(text).digest('hex')
try {
  await launch(); assert.equal((await snapshot()).runtime.developer.mode, 'normal'); assert.equal((await snapshot()).life.work.source, 'real')
  assert.equal((await snapshot()).life.work.materials.length, 0); assert.equal(requests.length, 0)
  const time = (await snapshot()).clock.nowMs; await stop()
  // Private fixture only: append the existing registered synthetic material to this
  // isolated normal journal, never expose a production arbitrary-file registration API.
  const fixtures = JSON.parse(await readFile(join(root, 'src/main/life/work/fixtures.json'), 'utf8')); const material = fixtures.material.trim(); const id = hash(material)
  const journalRoot = join(data, 'journals'); const owner = (await readdir(journalRoot))[0]; const folder = join(journalRoot, owner)
  const file = (await readdir(folder)).filter((name) => name.endsWith('.jsonl')).sort().at(-1); const journal = join(folder, file)
  const rows = (await readFile(journal, 'utf8')).trim().split('\n').map((line) => JSON.parse(line))
  await appendFile(journal, JSON.stringify({ version: 1, seq: rows.at(-1).seq + 1, atMs: time, type: 'life/material', material: { id, path: '合成材料/' + id + '.md', text: material, sha256: id, source: 'fake' } }) + '\n')
  await launch(); await accepted({ type: 'mode.set', mode: 'quiet' }); await accepted({ type: 'life.work.start', kind: 'read' })
  await waitFor((s) => s.life.work.jobs.some((item) => item.kind === 'read' && item.completedSteps === 1), 'NORMAL_FIRST_CHECKPOINT_FAILED')
  const reading = await job('read'); const room = join(data, 'rooms', (await readdir(join(data, 'rooms')))[0]); const desk = join(room, '书桌')
  assert.equal(reading.source, 'real'); assert.equal(hash(await readFile(join(desk, reading.output.path), 'utf8')), reading.output.sha256)
  await stop(); const count = requests.filter((row) => row.input.kind === 'read').length; await launch()
  assert.equal((await job('read')).status, 'interrupted'); await new Promise((done) => setTimeout(done, 5500))
  assert.equal((await job('read')).completedSteps, 1); assert.equal(requests.filter((row) => row.input.kind === 'read').length, count)
  await accepted({ type: 'life.work.resume', workId: reading.id }); await waitFor((s) => s.life.work.jobs.some((item) => item.kind === 'read' && item.status === 'completed'), 'NORMAL_READ_FAILED')
  // The real daily schedule may already have registered an unstarted writing
  // job before the restart (e.g. afternoon). Restart deliberately interrupts it;
  // use its explicit resume action instead of assuming that job does not exist.
  scenario = 'hold'; const existingWriting = await job('write')
  if (existingWriting && ['interrupted', 'paused', 'failed'].includes(existingWriting.status)) await accepted({ type: 'life.work.resume', workId: existingWriting.id })
  else await accepted({ type: 'life.work.start', kind: 'write' })
  await waitFor(() => requests.some((row) => row.input.kind === 'write'), 'NORMAL_PENDING_REQUEST_MISSING')
  await accepted({ type: 'mode.set', mode: 'rest' }); await waitFor((s) => s.life.work.jobs.some((item) => item.kind === 'write' && item.status === 'paused'), 'NORMAL_CANCEL_FAILED')
  for (let i = 0; i < 50 && !aborted; i++) await new Promise((done) => setTimeout(done, 100)); assert.ok(aborted > 0)
  assert.equal((await job('write')).completedSteps, 0)
  scenario = 'invalid'; await accepted({ type: 'mode.set', mode: 'quiet' }); await accepted({ type: 'life.work.resume', workId: (await job('write')).id })
  await waitFor((s) => s.life.work.jobs.some((item) => item.kind === 'write' && item.status === 'failed'), 'NORMAL_INVALID_OUTPUT_ACCEPTED')
  assert.equal((await job('write')).completedSteps, 0); assert.equal((await job('write')).output, undefined)
  scenario = 'ready'; await accepted({ type: 'life.work.resume', workId: (await job('write')).id }); await waitFor((s) => s.life.work.jobs.some((item) => item.kind === 'write' && item.status === 'completed'), 'NORMAL_WRITE_FAILED')
  const writing = await job('write'); assert.equal(hash(await readFile(join(desk, writing.output.path), 'utf8')), writing.output.sha256)
  assert.equal((await snapshot()).life.work.attemptsToday, 8)
  const workCalls = requests.filter((row) => ['read', 'write'].includes(row.input.kind)); assert.equal(workCalls.length, 8)
  assert.ok(workCalls.every((row) => row.model === 'synthetic-life-background' && row.messages.length === 2 && row.tools === undefined))
  await page.getByRole('button', { name: '日程', exact: true }).click()
  const row = page.locator(`.work-row[data-work-id="${writing.id}"]`); assert.equal(await row.locator('.demo-tag').count(), 1)
  const opened = instance.waitForEvent('window'); await row.getByRole('button', { name: '看看', exact: true }).click(); const preview = await opened; await preview.locator('pre').waitFor()
  assert.ok((await preview.locator('pre').innerText()).includes('NORMAL_TRANSPORT_PRODUCT')); assert.ok((await preview.locator('body').innerText()).includes('合成材料作品')); assert.equal(await preview.evaluate(() => typeof window.lca), 'undefined'); await preview.close()
  await accepted({ type: 'mode.set', mode: 'rest' }); await accepted({ type: 'message.send', text: '普通模式合成边界核对。' }); await waitFor((s) => s.task?.status === 'completed', 'NORMAL_CHAT_FAILED')
  const chat = requests.findLast((row) => row.model === 'synthetic-life-chat'); assert.ok(chat)
  assert.ok(!JSON.stringify(chat).includes(material.slice(0, 40))); assert.ok(!JSON.stringify(chat).includes('NORMAL_TRANSPORT_PRODUCT'))
  assert.ok(chat.messages.some((message) => typeof message.content === 'string' && message.content.includes('"materialSource":"fake"')))
  const currentRows = (await readFile(journal, 'utf8')).trim().split('\n').map((line) => JSON.parse(line)); const visible = JSON.stringify(currentRows.filter((row) => ['model/seen', 'context/inject', 'inbox/event'].includes(row.type)))
  assert.ok(!visible.includes(material.slice(0, 40))); assert.ok(!visible.includes('NORMAL_TRANSPORT_PRODUCT'))
  assert.ok(currentRows.some((row) => row.type === 'model/attempt' && row.slot === 'background' && row.bucket === 'autonomous'))
  await mkdir(join(root, 'test-results'), { recursive: true }); await writeFile(join(root, 'test-results/life-port-report.json'), JSON.stringify({ ok: true, atIso: new Date().toISOString(), mode: 'normal', sourceTransport: 'real-client', syntheticMaterialsAndHttp: true, actualProductionSteps: 6, attemptsIncludingInvalidAndCancelled: 8, resumeAfterRestart: true, ordinaryContextExcluded: true, liveProviderQualityAccepted: false }, null, 2))
  console.log('Normal life port passed: real compatible HTTP client/background only, actual read/write files, interrupted restart and explicit resume, native cancellation, invalid output refusal, eight bounded attempts and ordinary-context exclusion. Synthetic material/server; no real supplier call.')
} finally { await stop(); server.closeAllConnections(); await new Promise((done) => server.close(done)) }
