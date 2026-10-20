import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdir, readFile, readdir, appendFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import JSZip from 'jszip'
import { _electron } from 'playwright'
import electronPath from 'electron'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { runtimeEnv, initializeTestBook, electronLaunchTarget, openSettings } from './runtime-env.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..'); const data = join(root, '.local-data', 'resources-smoke-' + randomUUID())
let calls = 0
const server = createServer((request, response) => { void (async () => { for await (const chunk of request) { void chunk }; calls++; response.writeHead(200, { 'Content-Type': 'text/event-stream' }).end('data: ' + JSON.stringify({ choices: [{ index: 0, delta: { content: '合成预算回复' }, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n') })().catch(() => response.end()) })
await new Promise((done) => server.listen(0, '127.0.0.1', done)); await mkdir(data, { recursive: true })
const providers = join(data, 'synthetic.json'); await writeFile(providers, JSON.stringify({ providers: { chat: { base_url: 'http://127.0.0.1:' + server.address().port + '/v1', api_key: 'synthetic-resource-key', model: 'synthetic-resource-model' } } }))
let env = { ...runtimeEnv(root), LCA_DATA_DIR: data, LCA_PROVIDERS_FILE: providers }; let instance; let page; let client
const snapshot = () => page.evaluate(() => window.lca.getSnapshot())
const send = (body) => page.evaluate(async (body) => { const s = await window.lca.getSnapshot(); return window.lca.dispatch({ protocolVersion: 1, epoch: s.epoch, requestId: crypto.randomUUID(), ...body }) }, body)
async function accepted(body) { assert.equal((await send(body)).status, 'accepted', body.type) }
async function waitFor(test, code) { for (let i = 0; i < 200; i++) { if (test(await snapshot())) return; await new Promise((done) => setTimeout(done, 100)) }; throw new Error(code) }
async function launch() { instance = await _electron.launch({ ...electronLaunchTarget(root, electronPath), env }); page = await instance.firstWindow(); await initializeTestBook(page); await instance.evaluate(({ BrowserWindow }) => { for (const window of BrowserWindow.getAllWindows()) window.webContents.setAudioMuted(true) }) }
async function stop() { await client?.close(); client = undefined; await instance?.close(); instance = undefined }
async function exportBook(file) { await instance.evaluate(({ dialog }, file) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: file }) }, file); await accepted({ type: 'backup.export' }); await waitFor((s) => s.backup.status === 'exported', 'EXPORT_FAILED') }
async function restoreBook(file) {
  await instance.evaluate(({ dialog, app }, file) => { app.relaunch = () => {}; dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }) }, file)
  await accepted({ type: 'backup.import' }); await waitFor((s) => s.backup.status === 'awaiting-confirmation', 'IMPORT_FAILED'); const restoreId = (await snapshot()).backup.restoreId
  await client?.close(); client = undefined; const closed = instance.waitForEvent('close'); await accepted({ type: 'backup.restore', restoreId }); await closed; instance = undefined; await launch()
}
async function bookReserved(base) {
  let count = 0; const journals = join(base, 'journals')
  for (const owner of await readdir(journals)) for (const name of await readdir(join(journals, owner))) if (name.endsWith('.jsonl')) for (const line of (await readFile(join(journals, owner, name), 'utf8')).trim().split('\n')) { const row = JSON.parse(line); if (row.type === 'model/attempt' && row.status === 'started') count += row.reservedTokens ?? 0 }
  return count
}
try {
  await launch(); assert.equal((await snapshot()).resources.status, 'ready'); assert.equal((await snapshot()).resources.configurable, false)
  await accepted({ type: 'mode.set', mode: 'quiet' }); await accepted({ type: 'onboarding.profile', userName: 'PRIVATE_OWNER_CANARY' })
  assert.equal((await send({ type: 'resources.configure', dailyTotalUnits: 1000000, dailyAutonomousUnits: 500000 })).error.code, 'permission-denied')
  const archive = join(data, 'before-request.lca-save'); await exportBook(archive); const atExport = await bookReserved(data)
  await accepted({ type: 'message.send', text: 'PRIVATE_BUDGET_PROMPT ' + '合成预算核对。'.repeat(400) }); await waitFor((s) => s.task?.status === 'completed', 'NORMAL_REQUEST_FAILED')
  const charged = (await snapshot()).resources.model; assert.ok(charged.totalReservedUnits > 10000); assert.equal(charged.attemptCount, 1); assert.equal(calls, 1)
  const bookBeforeRestore = await bookReserved(data); assert.ok(bookBeforeRestore > atExport)
  await stop(); await launch(); assert.equal((await snapshot()).resources.model.totalReservedUnits, charged.totalReservedUnits)
  await restoreBook(archive); assert.equal(await bookReserved(data), atExport)
  assert.equal((await snapshot()).resources.model.totalReservedUnits, charged.totalReservedUnits); assert.equal((await snapshot()).resources.model.attemptCount, 1)
  const zip = await JSZip.loadAsync(await readFile(archive)); assert.ok(Object.keys(zip.files).every((name) => !name.includes('runtime-resources')))
  await stop(); env.LCA_BOOTH = '1'; await launch(); assert.equal((await snapshot()).runtime.developer.mode, 'booth')
  assert.equal((await snapshot()).onboarding.userName, null); assert.equal((await snapshot()).resources.model.totalReservedUnits, charged.totalReservedUnits); assert.equal((await snapshot()).resources.configurable, true)
  await accepted({ type: 'mode.set', mode: 'quiet' }); await openSettings(page)
  const panel = page.getByRole('region', { name: '运行资源', exact: true }); assert.ok((await panel.innerText()).includes(String(charged.totalReservedUnits)))
  await panel.getByLabel('总日预留上限').fill('1000000'); await panel.getByLabel('自主日预留上限').fill('500000'); await panel.getByRole('button', { name: '保存展位预算', exact: true }).click()
  await waitFor((s) => s.resources.model.totalLimitUnits === 1000000 && s.resources.model.autonomousLimitUnits === 500000, 'OPERATOR_INCREASE_FAILED')
  assert.equal((await snapshot()).resources.model.totalReservedUnits, charged.totalReservedUnits)
  assert.equal((await send({ type: 'resources.configure', dailyTotalUnits: 10000, dailyAutonomousUnits: 10001 })).error.code, 'invalid-command')
  await panel.getByLabel('总日预留上限').fill('10000'); await panel.getByLabel('自主日预留上限').fill('0'); await panel.getByRole('button', { name: '保存展位预算', exact: true }).click()
  await waitFor((s) => s.resources.model.totalLimitUnits === 10000 && s.resources.model.autonomousLimitUnits === 0, 'OPERATOR_REDUCTION_FAILED')
  await accepted({ type: 'message.send', text: '超过已降低预算的合成请求。' }); await waitFor((s) => s.task?.status === 'failed' && s.task.error?.code === 'budget-exceeded', 'CAP_DID_NOT_BLOCK')
  assert.equal(calls, 1, 'BUDGET_REJECTION_DISPATCHED_HTTP')
  await stop(); delete env.LCA_BOOTH; await launch(); assert.equal((await snapshot()).resources.configurable, false)
  assert.equal((await snapshot()).resources.model.totalLimitUnits, 10000); assert.equal((await snapshot()).resources.model.totalReservedUnits, charged.totalReservedUnits)
  await accepted({ type: 'message.send', text: '个人模式也不能绕过共享预算。' }); await waitFor((s) => s.task?.status === 'failed' && s.task.error?.code === 'budget-exceeded', 'PERSONAL_CAP_BYPASS'); assert.equal(calls, 1)
  await stop(); const authority = join(data, 'runtime-resources', 'usage.jsonl'); const authorityBeforeCorruption = await readFile(authority, 'utf8')
  for (const marker of ['PRIVATE_', 'synthetic-resource', 'http', '桃子']) assert.ok(!authorityBeforeCorruption.includes(marker))
  await appendFile(authority, '{'); await launch(); assert.equal((await snapshot()).resources.status, 'unavailable'); assert.equal((await snapshot()).resources.model.totalReservedUnits, null)
  assert.equal((await snapshot()).onboarding.userName, 'PRIVATE_OWNER_CANARY')
  await accepted({ type: 'message.send', text: '坏账本不应该清零或继续请求。' }); await waitFor((s) => s.task?.status === 'failed' && s.task.error?.code === 'unavailable', 'CORRUPT_LEDGER_NOT_CLOSED'); assert.equal(calls, 1)
  assert.equal(await readFile(authority, 'utf8'), authorityBeforeCorruption + '{'); await stop()

  // Speech has a separate natural-day character budget, also outside the developer book.
  const voiceRoot = join(data, 'voice-case'); const sceneId = randomUUID(); const voiceProfile = join(voiceRoot, 'developer', sceneId)
  await mkdir(voiceProfile, { recursive: true }); await writeFile(join(voiceRoot, 'settings.json'), JSON.stringify({ version: 1, developer: true, booth: false, plugins: {}, sceneId }))
  await writeFile(join(voiceProfile, 'clock.json'), JSON.stringify({ nowMs: Date.parse('2026-10-17T12:00:00+08:00'), rate: 1, frozen: true }))
  env = { ...runtimeEnv(root), LCA_DATA_DIR: voiceRoot, LCA_PROVIDERS_FILE: join(voiceRoot, 'absent.json'), LCA_CDP_PORT: '19568', LCA_MCP_PORT: '0' }; await launch()
  const connection = JSON.parse(await readFile(join(voiceProfile, 'debug-connection.json'), 'utf8')); client = new Client({ name: 'resource-voice-smoke', version: '1.0.0' }); await client.connect(new StreamableHTTPClientTransport(new URL(connection.url), { requestInit: { headers: { Authorization: 'Bearer ' + connection.token } } }))
  const voiceArchive = join(voiceRoot, 'before-speech.lca-save'); await exportBook(voiceArchive)
  await accepted({ type: 'voice.set', enabled: true }); const script = await client.callTool({ name: 'set_fake_model', arguments: { script: [{ text: '合成语音预算核对。', toolCalls: [], delayMs: 0 }] } }); assert.ok(!script.isError)
  await accepted({ type: 'message.send', text: '合成语音。' }); await waitFor((s) => s.resources.speech.attemptCount === 1, 'SPEECH_NOT_RESERVED')
  for (let i = 0; i < 3; i++) { const advanced = await client.callTool({ name: 'set_clock', arguments: { nowMs: (await snapshot()).clock.nowMs + 100, frozen: true } }); assert.ok(!advanced.isError) }
  await waitFor((s) => s.voice.utterance?.status === 'ready', 'SPEECH_NOT_READY'); const speech = (await snapshot()).resources.speech; assert.ok(speech.reservedChars > 0)
  await restoreBook(voiceArchive); assert.equal((await snapshot()).voice.enabled, false); assert.equal((await snapshot()).voice.utterance, undefined)
  assert.equal((await snapshot()).resources.speech.reservedChars, speech.reservedChars); assert.equal((await snapshot()).resources.speech.attemptCount, 1)
  assert.ok(!(await readFile(join(voiceProfile, 'runtime-resources/usage.jsonl'), 'utf8')).includes('合成语音'))
  await mkdir(join(root, 'test-results'), { recursive: true }); await writeFile(join(root, 'test-results/resources-report.json'), JSON.stringify({ ok: true, atIso: new Date().toISOString(), syntheticModelHttpAndFakeSpeechOnly: true, modelReservedBeforeAndAfterRestore: charged.totalReservedUnits, bookRowsActuallyRolledBack: true, normalAndBoothShareBudget: true, nativeOperatorIncreaseAndReduction: true, refusedBeforeHttp: true, corruptionFailsClosedWithBookIntact: true, speechCharsBeforeAndAfterRestore: speech.reservedChars, privateArchiveExcludesLedger: true, realProviderUsed: false }, null, 2))
  console.log('Resource Electron passed: actual book restore retains out-of-book model/speech reservations, normal/booth share usage, native operator limits, pre-HTTP cap refusal, corrupt ledger fails closed with book preserved and no speech replay. Synthetic HTTP/fake speech only.')
} finally { await stop(); server.closeAllConnections(); await new Promise((done) => server.close(done)) }
