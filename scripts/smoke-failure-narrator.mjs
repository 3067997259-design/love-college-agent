import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron } from 'playwright'
import electronPath from 'electron'
import { runtimeEnv, initializeTestBook, electronLaunchTarget } from './runtime-env.mjs'
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..'); const data = join(root, '.local-data', 'failure-narrator-' + randomUUID())
const credential = 'synthetic-failure-private-key'; const vendorBody = 'PRIVATE_UPSTREAM_ERROR_BODY'; const requests = []; let mode = 'configuration'; let phase = 0
const frame = (delta, finish_reason) => 'data: ' + JSON.stringify({ choices: [{ index: 0, delta, finish_reason }] }) + '\n\n'
const server = createServer(async (req, res) => {
  let text = ''; for await (const chunk of req) text += chunk; requests.push(JSON.parse(text)); phase++
  assert.ok(req.headers.authorization === 'Bearer ' + credential, 'AUTH_MISMATCH')
  if (mode === 'waiting') return
  if (mode === 'configuration' || mode === 'plain-403' || mode === 'filter' || mode === 'tool-fail' && phase > 1) {
    const status = mode === 'configuration' ? 401 : mode === 'plain-403' ? 403 : mode === 'filter' ? 400 : 503
    res.writeHead(status, { 'Content-Type': 'application/json', 'Retry-After': '0' }).end(JSON.stringify({ error: { code: mode === 'filter' ? 'content_policy_violation' : mode === 'plain-403' ? 'invalid_api_key' : 'synthetic_failure', message: vendorBody + ' content filter ' + credential } })); return
  }
  res.writeHead(200, { 'Content-Type': 'text/event-stream' })
  if (mode === 'tool-fail') { res.end(frame({ tool_calls: [{ index: 0, id: 'clock-' + requests.length, type: 'function', function: { name: 'get_clock', arguments: '{}' } }] }, 'tool_calls') + 'data: [DONE]\n\n'); return }
  if (mode === 'interrupted') { res.end(frame({ content: 'SAFE_PARTIAL_REPLY' }, null)); return }
  res.end(frame({ content: 'SYNTHETIC_SUCCESS_REPLY' }, 'stop') + 'data: [DONE]\n\n')
})
await new Promise((done) => server.listen(0, '127.0.0.1', done))
const fixture = join(data, 'providers.json'); const env = { ...runtimeEnv(root), LCA_DATA_DIR: data, LCA_PROVIDERS_FILE: fixture }
let instance; let page
async function launch() { instance = await _electron.launch({ ...electronLaunchTarget(root, electronPath), env }); page = await instance.firstWindow(); await initializeTestBook(page) }
async function close() { await instance?.close(); instance = undefined }
const snapshot = () => page.evaluate(() => window.lca.getSnapshot())
const send = (body) => page.evaluate(async (body) => { const s = await window.lca.getSnapshot(); return window.lca.dispatch({ protocolVersion: 1, epoch: s.epoch, requestId: crypto.randomUUID(), ...body }) }, body)
async function accept(body) { assert.equal((await send(body)).status, 'accepted', body.type) }
async function waitFor(test, message) { for (let i = 0; i < 200; i++) { if (test(await snapshot())) return; await new Promise((done) => setTimeout(done, 100)) }; throw new Error(message) }
const failureFor = (s, id = s.task?.id) => s.messages.find((message) => message.role === 'narrator' && message.failure?.turnId === id)
async function fail(next, text) { mode = next; phase = 0; await accept({ type: 'message.send', text }); const id = (await snapshot()).task.id; await waitFor((s) => s.task?.id === id && s.task.status === 'failed' && !!failureFor(s, id), 'FAILURE_MISSING_' + next); return failureFor(await snapshot(), id) }
async function records() { const rows = []; for (const owner of await readdir(join(data, 'journals'))) for (const file of await readdir(join(data, 'journals', owner))) if (file.endsWith('.jsonl')) rows.push(...(await readFile(join(data, 'journals', owner, file), 'utf8')).trim().split('\n').map(JSON.parse)); return rows }
const safe = (value) => { const text = JSON.stringify(value); assert.ok(!text.includes(credential) && !text.includes(vendorBody), 'PRIVATE_FAILURE_LEAK') }
try {
  await mkdir(data, { recursive: true }); await writeFile(fixture, JSON.stringify({ providers: { chat: { base_url: 'http://127.0.0.1:' + server.address().port + '/v1', api_key: credential, model: 'synthetic-failure-model' } } }))
  await launch(); await accept({ type: 'mode.set', mode: 'quiet' })
  const first = await fail('configuration', 'ORIGINAL_REVIEWED_REQUEST'); assert.equal(first.failure.category, 'configuration'); assert.equal(first.failure.httpStatus, 401); assert.equal(first.failure.attemptCount, 1)
  const details = page.locator(`[data-failure-turn="${first.failure.turnId}"]`); await details.locator('summary').click(); assert.ok((await details.innerText()).includes('configuration-failed'))
  const beforeRetry = requests.length; const composer = page.locator('.composer-input')
  await composer.fill('UNSENT_DRAFT'); await details.getByRole('button', { name: '带回原请求，检查后发送', exact: true }).click(); assert.equal(await composer.inputValue(), 'UNSENT_DRAFT'); assert.equal(requests.length, beforeRetry)
  await composer.fill(''); await details.getByRole('button', { name: '带回原请求，检查后发送', exact: true }).click(); assert.equal(await composer.inputValue(), 'ORIGINAL_REVIEWED_REQUEST'); assert.equal(requests.length, beforeRetry)
  mode = 'success'; phase = 0; await page.getByRole('button', { name: '发送', exact: true }).click(); await waitFor((s) => s.task?.id !== first.failure.turnId && s.task?.status === 'completed', 'USER_RETRY_FAILED')
  assert.ok(!JSON.stringify(requests.at(-1).messages).includes(first.text)); assert.equal(requests.at(-1).messages.at(-1).content, 'ORIGINAL_REVIEWED_REQUEST')
  const plain = await fail('plain-403', 'plain status is not evidence of filtering'); assert.equal(plain.failure.category, 'configuration')
  const filtered = await fail('filter', 'explicit filter marker'); assert.equal(filtered.failure.category, 'content-filtered'); assert.equal(phase, 1)
  const interrupted = await fail('interrupted', 'partial stream'); assert.equal(interrupted.failure.category, 'interrupted'); assert.equal(phase, 1); assert.ok((await snapshot()).messages.some((message) => message.text === 'SAFE_PARTIAL_REPLY' && message.status === 'interrupted'))
  const tools = await fail('tool-fail', 'tool followed by known upstream failure'); assert.equal(tools.failure.category, 'upstream'); assert.equal(tools.failure.httpStatus, 503); assert.equal(tools.failure.toolsExecuted, true); assert.equal(phase, 3)
  assert.equal((await snapshot()).activities.filter((activity) => activity.taskId === tools.failure.turnId && activity.status === 'completed').length, 1)
  assert.ok((await page.locator(`[data-failure-turn="${tools.failure.turnId}"]`).innerText()).includes('已尝试调用工具'))
  const count = (await records()).filter((row) => row.type === 'narrator/failure').length
  mode = 'waiting'; phase = 0; await accept({ type: 'message.send', text: 'stop pending request' }); const stopped = (await snapshot()).task.id
  for (let i = 0; i < 100 && phase === 0; i++) await new Promise((done) => setTimeout(done, 20)); assert.equal(phase, 1)
  await accept({ type: 'turn.stop', taskId: stopped }); await waitFor((s) => s.task?.status === 'aborted', 'STOP_FAILED'); assert.equal((await records()).filter((row) => row.type === 'narrator/failure').length, count)
  mode = 'success'; phase = 0; await accept({ type: 'flow.enter' }); await waitFor((s) => s.heartFlow?.activeId, 'FLOW_MISSING')
  const work = await fail('configuration', 'WORK_FAILURE_REQUEST'); assert.ok((await snapshot()).messages.some((message) => message.id === work.id))
  mode = 'success'; await accept({ type: 'flow.exit' }); assert.ok(!(await snapshot()).messages.some((message) => message.id === work.id)); assert.ok(!(await snapshot()).messages.some((message) => message.text === 'WORK_FAILURE_REQUEST'))
  const archive = join(data, 'failures.lca-save'); await instance.evaluate(({ dialog }, file) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: file }) }, archive)
  await accept({ type: 'backup.export' }); await waitFor((s) => s.backup.status === 'exported', 'EXPORT_FAILED')
  const attempts = (await records()).filter((row) => row.type === 'model/attempt' && row.status === 'started').length; const failures = (await records()).filter((row) => row.type === 'narrator/failure').length; const httpCount = requests.length
  await close(); await launch(); assert.equal(requests.length, httpCount); assert.equal((await records()).filter((row) => row.type === 'narrator/failure').length, failures)
  const oldPage = await page.evaluate(async () => { const s = await window.lca.getSnapshot(); return window.lca.readSession(s.scope.sessionId) }); const archived = oldPage.messages.find((message) => message.id === first.id)
  assert.deepEqual(archived.failure, first.failure); assert.ok(!oldPage.recallableMessageIds.includes(first.id))
  await instance.evaluate(({ dialog, app }, file) => { app.relaunch = () => {}; dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }) }, archive)
  await accept({ type: 'backup.import' }); await waitFor((s) => s.backup.status === 'awaiting-confirmation', 'IMPORT_FAILED'); const restoreId = (await snapshot()).backup.restoreId
  const closed = instance.waitForEvent('close'); await accept({ type: 'backup.restore', restoreId }); await closed; instance = undefined; await launch()
  assert.equal(requests.length, httpCount); assert.equal((await records()).filter((row) => row.type === 'model/attempt' && row.status === 'started').length, attempts)
  const finalRows = await records(); assert.equal(finalRows.filter((row) => row.type === 'narrator/failure').length, failures); safe(await snapshot()); safe(finalRows)
  const narration = finalRows.filter((row) => row.type === 'narrator/failure').map((row) => row.text)
  for (const request of requests) for (const text of narration) assert.ok(!request.messages.some((message) => message.content?.includes(text)), 'NARRATOR_IN_HTTP')
  for (const row of finalRows.filter((row) => row.type === 'model/seen')) for (const text of narration) assert.ok(!row.messages.some((message) => message.content.includes(text)))
  console.log(JSON.stringify({ ok: true, probe: 'failure-narrator', source: 'synthetic-http', nativeSQLite: true, classifiedFailures: true, explicitFilterOnly: true, partialPreserved: true, userDraftReviewNoReplay: true, toolReceiptWarning: true, stoppedNotFailure: true, workIsolation: true, modelAndRecallExclusion: true, restartNoReplay: true, privateRestore: true, noPrivateErrorBody: true }))
} finally { await close(); server.closeAllConnections(); await new Promise((done) => server.close(done)) }
