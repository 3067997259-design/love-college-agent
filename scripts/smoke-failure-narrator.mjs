import assert from 'node:assert/strict'
import { randomUUID, createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdir, readFile, readdir, writeFile, appendFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron } from 'playwright'
import electronPath from 'electron'
import { runtimeEnv, initializeTestBook, electronLaunchTarget, whenIdle } from './runtime-env.mjs'
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..'); const data = join(root, '.local-data', 'failure-narrator-' + randomUUID())
const credential = 'synthetic-failure-private-key'; const vendorBody = 'PRIVATE_UPSTREAM_ERROR_BODY'; const requests = []; let mode = 'configuration'; let phase = 0
// Her conversation runs on DSH: LCA tools carry the lca_ prefix, your words are the last text block of their message
// (LCA's references come first), and DSH adds its own reminders and runtime context as user messages.
const partsOf = (content) => typeof content === 'string' ? [content] : (content ?? []).map((part) => part?.text ?? '')
const textOf = (content) => partsOf(content).join('')
const dshContext = (message) => /^(?:<system-reminder>|Current runtime context)/.test(textOf(message.content))
// LCA's references come first in a turn's opening message, then a blank line, then your words (some protocols join
// a message's text blocks into one string).
const wordsOf = (content) => { const text = textOf(content); return /^(?:\{|\[LCA references)/.test(text) && text.includes('\n\n') ? text.slice(text.indexOf('\n\n') + 2) : text }
const referenceOf = (content) => { const text = textOf(content); return text.startsWith('{') ? text.slice(0, text.includes('\n\n') ? text.indexOf('\n\n') : undefined) : '' }
const yourLast = (request) => wordsOf(request.messages.findLast((message) => message.role === 'user' && !dshContext(message))?.content)
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
  if (mode === 'recall-expand' && phase === 1) {
    const reference = requests.at(-1).messages.map((message) => { try { return JSON.parse(referenceOf(message.content)).recalledSeenReference } catch { return undefined } }).find(Boolean)
    assert.ok(reference?.requestId)
    res.end(frame({ tool_calls: [{ index: 0, id: 'recall-expand', type: 'function', function: { name: 'lca_recall_seen', arguments: JSON.stringify({ requestId: reference.requestId, relativeStart: 0, count: 1 }) } }] }, 'tool_calls') + 'data: [DONE]\n\n'); return
  }
  if (mode === 'tool-fail') { res.end(frame({ tool_calls: [{ index: 0, id: 'clock-' + requests.length, type: 'function', function: { name: 'lca_get_clock', arguments: '{}' } }] }, 'tool_calls') + 'data: [DONE]\n\n'); return }
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
async function waitFor(test, message) { for (let i = 0; i < 400; i++) { if (test(await snapshot())) return; await new Promise((done) => setTimeout(done, 100)) }; throw new Error(message) }
const failureFor = (s, id = s.task?.id) => s.messages.find((message) => message.role === 'narrator' && message.failure?.turnId === id)
async function fail(next, text) { mode = next; phase = 0; const previous = (await snapshot()).task?.id; await accept({ type: 'message.send', text }); await waitFor((s) => !!s.task && s.task.id !== previous, 'TURN_NOT_STARTED'); const id = (await snapshot()).task.id; await waitFor((s) => s.task?.id === id && s.task.status === 'failed' && !!failureFor(s, id), 'FAILURE_MISSING_' + next); return failureFor(await snapshot(), id) }
async function records() { const rows = []; for (const owner of await readdir(join(data, 'journals'))) for (const file of await readdir(join(data, 'journals', owner))) if (file.endsWith('.jsonl')) rows.push(...(await readFile(join(data, 'journals', owner, file), 'utf8')).trim().split('\n').map(JSON.parse)); return rows }
const safe = (value) => { const text = JSON.stringify(value); assert.ok(!text.includes(credential) && !text.includes(vendorBody), 'PRIVATE_FAILURE_LEAK') }
try {
  await mkdir(data, { recursive: true }); await writeFile(fixture, JSON.stringify({ providers: { chat: { base_url: 'http://127.0.0.1:' + server.address().port + '/v1', api_key: credential, model: 'synthetic-failure-model' } } }))
  // An explicit synthetic historical page with successful-input evidence; no
  // private data, accelerated normal clock or relaxed recall validation.
  const oldAt = Date.now() - 86400000; const oldDay = new Date(oldAt + 4 * 3600000).toISOString().slice(0, 10)
  const oldSession = randomUUID(); const oldText = 'SYNTHETIC_SEEN_QUOTE 周五桥在窗边。'
  const folder = join(data, 'journals', createHash('sha256').update(JSON.stringify(['local-user', 'default-character'])).digest('hex')); await mkdir(folder, { recursive: true })
  const oldRows = [{ type: 'session/header', userId: 'local-user', characterId: 'default-character', sessionId: oldSession },
    { type: 'user/message', id: 'old-seen', text: oldText, requestId: 'old-seen', commandHash: 'h' }, { type: 'inbox/drain', ids: ['old-seen'] },
    { type: 'model/seen', turnId: 'old-turn', source: 'fake', messages: [{ role: 'user', content: oldText }], eligibleIndexes: [0] }]
  await writeFile(join(folder, oldDay + '.jsonl'), oldRows.map((row, index) => JSON.stringify({ ...row, version: 1, seq: index + 1, atMs: oldAt })).join('\n') + '\n')
  await launch(); await accept({ type: 'mode.set', mode: 'quiet' })
  const first = await fail('configuration', 'ORIGINAL_REVIEWED_REQUEST'); assert.equal(first.failure.category, 'configuration'); assert.equal(first.failure.httpStatus, 401); assert.equal(first.failure.attemptCount, 1)
  const details = page.locator(`[data-failure-turn="${first.failure.turnId}"]`); await details.locator('summary').click(); assert.ok((await details.innerText()).includes('configuration-failed'))
  const beforeRetry = requests.length; let composer = page.locator('.composer-input')
  await composer.fill('UNSENT_DRAFT'); await details.getByRole('button', { name: '带回原请求，检查后发送', exact: true }).click(); assert.equal(await composer.inputValue(), 'UNSENT_DRAFT'); assert.equal(requests.length, beforeRetry)
  await composer.fill(''); await details.getByRole('button', { name: '带回原请求，检查后发送', exact: true }).click(); assert.equal(await composer.inputValue(), 'ORIGINAL_REVIEWED_REQUEST'); assert.equal(requests.length, beforeRetry)
  mode = 'success'; phase = 0; await page.getByRole('button', { name: '发送', exact: true }).click(); await waitFor((s) => s.task?.id !== first.failure.turnId && s.task?.status === 'completed', 'USER_RETRY_FAILED')
  assert.ok(!JSON.stringify(requests.at(-1).messages).includes(first.text)); assert.equal(yourLast(requests.at(-1)), 'ORIGINAL_REVIEWED_REQUEST')
  const anchor = { sessionId: oldSession, messageId: 'old-seen', start: 0, end: oldText.length }
  mode = 'configuration'; phase = 0; await accept({ type: 'history.recall', anchor, question: 'ORIGINAL_RECALL_QUESTION' })
  await waitFor((s) => s.task?.status === 'failed' && !!failureFor(s), 'RECALL_FAILURE_MISSING')
  const recallFailure = failureFor(await snapshot()); assert.deepEqual(recallFailure.failure.sourceRecallAnchor, anchor)
  const oldRequest = (await records()).filter((row) => row.type === 'history/recall-request').at(-1).requestId; const beforeRecallRetry = requests.length
  await page.locator(`[data-failure-turn="${recallFailure.failure.turnId}"]`).getByRole('button', { name: '带回原请求，检查后发送', exact: true }).click()
  await page.waitForFunction(() => document.querySelector('.composer-input').value === 'ORIGINAL_RECALL_QUESTION')
  assert.equal(await page.locator('.quote-chip-text').innerText(), oldText); assert.equal(requests.length, beforeRecallRetry)
  mode = 'recall-expand'; phase = 0; await page.getByRole('button', { name: '发送', exact: true }).click()
  await waitFor((s) => s.task?.id !== recallFailure.failure.turnId && s.task?.status === 'completed', 'RECALL_RESEND_FAILED')
  const newRequest = (await records()).filter((row) => row.type === 'history/recall-request').at(-1).requestId
  assert.notEqual(newRequest, oldRequest); assert.equal(phase, 2); assert.ok(requests.at(-2).messages.some((message) => textOf(message.content).includes('recalledSeenReference') && textOf(message.content).includes(newRequest)))
  assert.ok(requests.at(-1).messages.some((message) => message.role === 'tool' && textOf(message.content).includes(oldText)))
  // A new turn each time: the previous one already reads as completed, and DSH may take a moment to begin.
  let previousTask = (await snapshot()).task?.id
  mode = 'success'; phase = 0; await accept({ type: 'message.send', text: 'UNRELATED_AFTER_RECALL' }); await waitFor((s) => s.task?.id !== previousTask && s.task?.status === 'completed' && s.messages.at(-1)?.text === 'SYNTHETIC_SUCCESS_REPLY', 'UNRELATED_TURN_FAILED')
  // The quote was for that turn only: DSH's later requests carry it no more (the bridge retires references).
  assert.ok(!requests.at(-1).messages.some((message) => textOf(message.content).includes('recalledSeenReference')))
  // Append an old-writer-format failure fixture to the closed, owned journal.
  // Its genuine source message and recall request above provide the authority.
  await close(); const journalOwner = (await readdir(join(data, 'journals')))[0]; const journalFolder = join(data, 'journals', journalOwner)
  const journalFile = join(journalFolder, (await readdir(journalFolder)).filter((name) => name.endsWith('.jsonl')).sort().at(-1))
  const prior = (await readFile(journalFile, 'utf8')).trim().split('\n').map(JSON.parse); const legacyFailure = { ...recallFailure.failure }; delete legacyFailure.sourceRecallAnchor
  const legacyId = randomUUID(); await appendFile(journalFile, JSON.stringify({ version: 1, seq: prior.at(-1).seq + 1, atMs: Date.now(), type: 'narrator/failure', id: legacyId, turnId: legacyFailure.turnId, text: recallFailure.text, failure: legacyFailure }) + '\n')
  const legacyHttp = requests.length; await launch(); composer = page.locator('.composer-input'); assert.equal(requests.length, legacyHttp)
  assert.deepEqual((await snapshot()).messages.find((message) => message.id === legacyId).failure.sourceRecallAnchor, anchor)
  const legacyArchive = await page.evaluate(async () => { const s = await window.lca.getSnapshot(); return window.lca.readSession(s.scope.sessionId) })
  assert.deepEqual(legacyArchive.messages.find((message) => message.id === legacyId).failure.sourceRecallAnchor, anchor)
  await page.locator(`[data-failure-turn="${legacyFailure.turnId}"]`).last().getByRole('button', { name: '带回原请求，检查后发送', exact: true }).click()
  await page.locator('.quote-chip-text').waitFor(); assert.equal(await composer.inputValue(), 'ORIGINAL_RECALL_QUESTION'); assert.equal(await page.locator('.quote-chip-text').innerText(), oldText); assert.equal(requests.length, legacyHttp)
  previousTask = (await snapshot()).task?.id
  mode = 'recall-expand'; phase = 0; await page.getByRole('button', { name: '发送', exact: true }).click(); await waitFor((s) => s.task?.id !== previousTask && s.task?.status === 'completed', 'LEGACY_RECALL_RETRY_FAILED')
  const legacyNewRequest = (await records()).filter((row) => row.type === 'history/recall-request').at(-1).requestId
  assert.notEqual(legacyNewRequest, newRequest); assert.notEqual(legacyNewRequest, oldRequest); assert.equal(phase, 2)
  assert.ok(requests.at(-1).messages.some((message) => message.role === 'tool' && textOf(message.content).includes(oldText)))
  assert.equal((await records()).find((row) => row.id === legacyId).failure.sourceRecallAnchor, undefined)
  const plain = await fail('plain-403', 'plain status is not evidence of filtering'); assert.equal(plain.failure.category, 'configuration')
  const filtered = await fail('filter', 'explicit filter marker'); assert.equal(filtered.failure.category, 'content-filtered'); assert.equal(phase, 1)
  // DSH asks again after a transient failure (a cut stream, a busy server): five retries with backoff, then the failure.
  const interrupted = await fail('interrupted', 'partial stream'); assert.equal(interrupted.failure.category, 'interrupted'); assert.equal(phase, 6); assert.ok((await snapshot()).messages.some((message) => message.text === 'SAFE_PARTIAL_REPLY' && message.status === 'interrupted'))
  const tools = await fail('tool-fail', 'tool followed by known upstream failure'); assert.equal(tools.failure.category, 'upstream'); assert.equal(tools.failure.httpStatus, 503); assert.equal(tools.failure.toolsExecuted, true); assert.equal(phase, 7)
  assert.equal((await snapshot()).activities.filter((activity) => activity.taskId === tools.failure.turnId && activity.status === 'completed').length, 1)
  assert.ok((await page.locator(`[data-failure-turn="${tools.failure.turnId}"]`).innerText()).includes('已尝试调用工具'))
  const count = (await records()).filter((row) => row.type === 'narrator/failure').length
  mode = 'waiting'; phase = 0; await accept({ type: 'message.send', text: 'stop pending request' }); const stopped = (await snapshot()).task.id
  for (let i = 0; i < 100 && phase === 0; i++) await new Promise((done) => setTimeout(done, 20)); assert.equal(phase, 1)
  await accept({ type: 'turn.stop', taskId: stopped }); await waitFor((s) => s.task?.status === 'aborted', 'STOP_FAILED'); assert.equal((await records()).filter((row) => row.type === 'narrator/failure').length, count)
  const archive = join(data, 'failures.lca-save'); await instance.evaluate(({ dialog }, file) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: file }) }, archive)
  assert.equal((await whenIdle(send, { type: 'backup.export' })).status, 'accepted'); await waitFor((s) => s.backup.status === 'exported', 'EXPORT_FAILED')
  const attempts = (await records()).filter((row) => row.type === 'model/attempt' && row.status === 'started').length; const failures = (await records()).filter((row) => row.type === 'narrator/failure').length; const httpCount = requests.length
  await close(); await launch(); assert.equal(requests.length, httpCount); assert.equal((await records()).filter((row) => row.type === 'narrator/failure').length, failures)
  const oldPage = await page.evaluate(async () => { const s = await window.lca.getSnapshot(); return window.lca.readSession(s.scope.sessionId) }); const archived = oldPage.messages.find((message) => message.id === first.id)
  assert.deepEqual(archived.failure, first.failure); assert.ok(!oldPage.recallableMessageIds.includes(first.id))
  await instance.evaluate(({ dialog, app }, file) => { app.relaunch = () => {}; dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }) }, archive)
  await accept({ type: 'backup.import' }); await waitFor((s) => s.backup.status === 'awaiting-confirmation', 'IMPORT_FAILED'); const restoreId = (await snapshot()).backup.restoreId
  const closed = instance.waitForEvent('close'); await accept({ type: 'backup.restore', restoreId }); await closed; instance = undefined; await launch()
  assert.equal(requests.length, httpCount); assert.equal((await records()).filter((row) => row.type === 'model/attempt' && row.status === 'started').length, attempts)
  const finalRows = await records(); assert.equal(finalRows.filter((row) => row.type === 'narrator/failure').length, failures); safe(await snapshot()); safe(finalRows)
  assert.deepEqual((await snapshot()).messages.find((message) => message.id === legacyId).failure.sourceRecallAnchor, anchor)
  const narration = finalRows.filter((row) => row.type === 'narrator/failure').map((row) => row.text)
  for (const request of requests) for (const text of narration) assert.ok(!request.messages.some((message) => textOf(message.content).includes(text)), 'NARRATOR_IN_HTTP')
  for (const row of finalRows.filter((row) => row.type === 'model/seen')) for (const text of narration) assert.ok(!row.messages.some((message) => message.content.includes(text)))
  console.log(JSON.stringify({ ok: true, probe: 'failure-narrator', source: 'synthetic-http', nativeSQLite: true, classifiedFailures: true, explicitFilterOnly: true, partialPreserved: true, userDraftReviewNoReplay: true, recallQuestionAndQuoteRestored: true, freshRecallRequestAndToolExpansion: true, legacySavedFailureProjectedAfterReopenAndRestore: true, toolReceiptWarning: true, stoppedNotFailure: true, workIsolation: true, modelAndRecallExclusion: true, restartNoReplay: true, privateRestore: true, noPrivateErrorBody: true }))
} finally { await close(); server.closeAllConnections(); await new Promise((done) => server.close(done)) }
