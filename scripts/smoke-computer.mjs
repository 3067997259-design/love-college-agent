import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron } from 'playwright'
import electronPath from 'electron'
import JSZip from 'jszip'
import { runtimeEnv, initializeTestBook } from './runtime-env.mjs'
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..'); const data = join(root, '.local-data', 'computer-smoke-' + randomUUID()); const profile = join(data, 'profile'); const requests = []
let index = 0; let scenario = 'interact'; let forbidden = 0
const call = (name, args) => ({ id: randomUUID(), type: 'function', function: { name, arguments: JSON.stringify(args) } })
const server = createServer((request, response) => { void (async () => {
  if (request.url !== '/v1/chat/completions') { forbidden++; response.writeHead(404).end(); return }
  let text = ''; for await (const part of request) text += part; const body = JSON.parse(text); requests.push(body)
  const result = body.messages.filter((message) => message.role === 'tool').flatMap((message) => { try { const row = JSON.parse(message.content); return row.frameRef ? [row] : [] } catch { return [] } }).at(-1)
  let tool; const step = index++
  if (scenario !== 'ordinary') {
    if (step === 0) tool = call('desk_computer_observe', {})
    else if (step === 1) tool = call('desk_computer_action', { frameRef: result.frameRef, action: { type: 'click', x: 100, y: 140 } })
    else if (step === 2) tool = call('desk_computer_action', { frameRef: result.frameRef, action: { type: 'type', text: 'SYNTHETIC_TYPED_TEXT' } })
    else if (step === 3) tool = call('desk_write', { path: 'ui-proof.md', text: 'SYNTHETIC_COMPUTER_PRODUCT: check the real preview pixels before accepting this draft.' })
  }
  const delta = tool ? { tool_calls: [{ index: 0, ...tool }] } : { content: 'Synthetic response; no real provider.' }
  response.writeHead(200, { 'Content-Type': 'text/event-stream' }).end('data: ' + JSON.stringify({ choices: [{ index: 0, delta, finish_reason: tool ? 'tool_calls' : 'stop' }] }) + '\n\ndata: [DONE]\n\n')
})().catch(() => { if (!response.headersSent) response.writeHead(500); response.end() }) })
await new Promise((done) => server.listen(0, '127.0.0.1', done)); const endpoint = 'http://127.0.0.1:' + server.address().port
await mkdir(data, { recursive: true }); const providers = join(data, 'synthetic-providers.json'); await writeFile(providers, JSON.stringify({ providers: { chat: { base_url: endpoint + '/v1', api_key: 'synthetic-test-only', model: 'synthetic-test-only' } } }))
const env = { ...runtimeEnv(root), LCA_DATA_DIR: profile, LCA_PROVIDERS_FILE: providers }; let instance; let page
async function launch() { instance = await _electron.launch({ executablePath: electronPath, args: [root], env }); page = await instance.firstWindow(); await initializeTestBook(page) }
const snapshot = () => page.evaluate(() => window.lca.getSnapshot())
const send = (body) => page.evaluate(async (body) => { const s = await window.lca.getSnapshot(); return window.lca.dispatch({ protocolVersion: 1, epoch: s.epoch, requestId: crypto.randomUUID(), ...body }) }, body)
async function waitFor(test, message) { for (let i = 0; i < 150; i++) { if (test(await snapshot())) return; await new Promise((done) => setTimeout(done, 100)) }; throw new Error(message) }
async function preview() { const opened = instance.waitForEvent('window'); assert.equal((await send({ type: 'flow.computer.open', path: 'ui.html' })).status, 'accepted'); const window = await opened; await window.waitForLoadState(); await waitFor((s) => s.heartFlow.computer.status === 'ready', 'PREVIEW_NOT_READY'); return window }
try {
  await launch(); await send({ type: 'mode.set', mode: 'quiet' }); await send({ type: 'flow.enter' }); await waitFor((s) => s.heartFlow.activeId, 'FLOW_MISSING')
  assert.equal((await send({ type: 'flow.computer.open', path: 'ui.html' })).error.code, 'permission-denied'); await send({ type: 'flow.mode', mode: 'execute' })
  const owner = (await readdir(join(profile, 'rooms')))[0]; const desk = join(profile, 'rooms', owner, '书桌')
  const html = '<body style="margin:0;background:white;font:20px sans-serif"><h1>PRIVATE_SYNTHETIC_DESK_PREVIEW</h1><input id="name" style="position:absolute;left:70px;top:120px;width:300px;height:40px"><input id="file" type="file" style="position:absolute;top:240px"><a style="position:absolute;top:350px" href="' + endpoint + '/forbidden">blocked link</a><img src="' + endpoint + '/forbidden-image"><script>window.PAGE_SCRIPT_RAN=true;fetch("' + endpoint + '/forbidden-script")</script></body>'
  await writeFile(join(desk, 'ui.html'), html); let window = await preview(); assert.equal(await window.evaluate(() => typeof window.lca), 'undefined'); assert.equal(await window.evaluate(() => typeof window.require), 'undefined'); assert.equal(await window.evaluate(() => typeof window.PAGE_SCRIPT_RAN), 'undefined'); assert.equal(await window.locator('#file').isDisabled(), true)
  const firstHash = (await snapshot()).heartFlow.computer.frame.sha256
  assert.equal(await instance.evaluate(async ({ net }, sha) => (await net.fetch('lca-media://asset/' + sha)).status, firstHash), 404)
  assert.equal((await send({ type: 'message.send', text: 'Inspect the static desk preview, click the text field, request typing approval, then save a draft proof.' })).status, 'accepted')
  await waitFor((s) => s.heartFlow.computer.pending?.action.type === 'click', 'CLICK_APPROVAL_MISSING'); const oldApproval = (await snapshot()).heartFlow.computer.pending.id
  assert.equal((await snapshot()).heartFlow.computer.actionsUsed, 0); assert.equal(await window.locator('#name').inputValue(), '')
  await page.bringToFront(); await page.getByRole('button', { name: '仅批准这个预览动作', exact: true }).click()
  await waitFor((s) => s.heartFlow.computer.pending?.action.type === 'type', 'TYPE_APPROVAL_MISSING'); assert.equal(await window.evaluate(() => document.activeElement.id), 'name'); assert.equal(await window.locator('#name').inputValue(), '')
  await page.bringToFront(); await page.getByRole('button', { name: '仅批准这个预览动作', exact: true }).click()
  await waitFor((s) => s.task?.status === 'completed' && s.heartFlow.computer.actionsUsed === 2, 'COMPUTER_TURN_NOT_DONE'); assert.equal(await window.locator('#name').inputValue(), 'SYNTHETIC_TYPED_TEXT'); assert.ok((await readFile(join(desk, 'ui-proof.md'), 'utf8')).includes('SYNTHETIC_COMPUTER_PRODUCT'))
  assert.notEqual((await snapshot()).heartFlow.computer.frame.sha256, firstHash); assert.equal((await send({ type: 'flow.computer.approve', approvalId: oldApproval, allow: true })).status, 'rejected')
  const imageRequests = requests.filter((request) => request.messages.some((message) => Array.isArray(message.content))); assert.ok(imageRequests.length >= 3)
  for (const request of imageRequests) { const images = request.messages.flatMap((message) => Array.isArray(message.content) ? message.content.filter((part) => part.type === 'image_url') : []); assert.ok(images.length <= 2); for (const image of images) { assert.equal(image.image_url.detail, 'low'); const png = Buffer.from(image.image_url.url.split(',')[1], 'base64'); assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a'); assert.equal(png.readUInt32BE(16), 800); assert.equal(png.readUInt32BE(20), 600) } }
  assert.equal(forbidden, 0)
  index = 0; await send({ type: 'message.send', text: 'Observe again and propose a single synthetic action for cancellation.' }); await waitFor((s) => !!s.heartFlow.computer.pending, 'STOP_APPROVAL_MISSING'); const closedPreview = window.waitForEvent('close')
  await send({ type: 'turn.stop', taskId: (await snapshot()).task.id }); await closedPreview; await waitFor((s) => s.task?.status === 'aborted' && s.heartFlow.computer.status === 'closed', 'STOP_DID_NOT_CLOSE')
  await instance.close(); await launch(); assert.equal(instance.windows().length, 1); assert.equal((await snapshot()).heartFlow.computer.status, 'closed'); assert.equal((await snapshot()).heartFlow.computer.pending, undefined)
  window = await preview(); index = 0; await send({ type: 'message.send', text: 'Request a synthetic action, then reject it as stale.' }); await waitFor((s) => !!s.heartFlow.computer.pending, 'STALE_APPROVAL_MISSING')
  const beforeActions = (await snapshot()).heartFlow.computer.actionsUsed; await window.locator('#name').fill('USER_EDIT_OUTSIDE_MODEL_ACTION'); await page.bringToFront(); await page.getByRole('button', { name: '仅批准这个预览动作', exact: true }).click()
  // Failed action cannot consume an approval twice or mutate the now-different user input.
  await waitFor((s) => s.heartFlow.computer.pending?.action.type === 'type' || s.task?.status === 'completed' || s.task?.status === 'failed', 'STALE_ACTION_NOT_SETTLED')
  assert.equal((await snapshot()).heartFlow.computer.actionsUsed, beforeActions); assert.equal(await window.locator('#name').inputValue(), 'USER_EDIT_OUTSIDE_MODEL_ACTION')
  if ((await snapshot()).task?.status === 'running') await send({ type: 'turn.stop', taskId: (await snapshot()).task.id }); await waitFor((s) => s.task?.status !== 'running', 'STALE_TURN_STOP_FAILED')
  await send({ type: 'flow.computer.close' }); await send({ type: 'flow.exit' }); await waitFor((s) => !s.heartFlow.activeId, 'FLOW_NOT_CLOSED')
  const archive = join(data, 'computer.lca-save'); await instance.evaluate(({ dialog }, file) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: file }) }, archive); await send({ type: 'backup.export' }); await waitFor((s) => s.backup.status === 'exported', 'FRAME_ARCHIVE_FAILED')
  const zip = await JSZip.loadAsync(await readFile(archive)); const manifest = JSON.parse(await zip.file('manifest.json').async('string')); let privateFrames = 0
  for (const file of manifest.files.filter((file) => file.path.endsWith('.jsonl'))) for (const line of (await zip.file(file.path).async('string')).trim().split('\n')) { const record = JSON.parse(line); if (record.type === 'flow/computer-frame') { assert.ok(zip.file('artifacts/' + record.asset.sha256 + '.png')); privateFrames++ } }
  assert.ok(privateFrames >= 4)
  await instance.evaluate(({ dialog }, file) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }) }, archive); await send({ type: 'backup.import' }); await waitFor((s) => s.backup.status === 'awaiting-confirmation', 'FRAME_IMPORT_FAILED')
  await instance.evaluate(({ app }) => { app.relaunch = () => {} }); const restoreId = (await snapshot()).backup.restoreId; const restarted = instance.waitForEvent('close'); await send({ type: 'backup.restore', restoreId }); await restarted; instance = undefined; await launch()
  assert.equal((await snapshot()).backup.status, 'restored'); assert.equal((await snapshot()).heartFlow.computer.status, 'closed'); assert.equal(instance.windows().length, 1)
  assert.equal(await instance.evaluate(async ({ net }, sha) => (await net.fetch('lca-media://asset/' + sha)).status, firstHash), 404)
  scenario = 'ordinary'; await send({ type: 'message.send', text: 'Return to ordinary synthetic chat.' }); await waitFor((s) => s.task?.status === 'completed', 'ORDINARY_NOT_DONE'); const ordinary = requests.at(-1)
  assert.ok(ordinary.messages.every((message) => typeof message.content === 'string')); assert.ok(!JSON.stringify(ordinary).includes('PRIVATE_SYNTHETIC_DESK_PREVIEW')); assert.ok(!JSON.stringify(ordinary).includes('SYNTHETIC_COMPUTER_PRODUCT'))
  console.log('Computer Electron: isolated static HTML/no page script or network/disabled file picker/no bridge; actual PNG delivered through compatible multimodal HTTP, two separate native approvals cause real click/type and saved draft; stale-page refusal, stop/restart without preview or approval replay, private frame export/restore and ordinary-context exclusion. Synthetic HTML/model HTTP only; no whole-PC or existing-app control.')
} finally { await instance?.close(); await new Promise((done) => { server.close(() => done()); server.closeAllConnections() }) }
