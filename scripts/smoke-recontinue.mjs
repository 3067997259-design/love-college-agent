// Real Electron + pinned DSH, scripted local model, isolated data only.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { _electron } from 'playwright'
import electronPath from 'electron'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { runtimeEnv, initializeTestBook, testDataRoot, whenIdle } from './runtime-env.mjs'
const root = resolve(import.meta.dirname, '..'), runId = randomUUID(), sceneId = randomUUID()
const data = join(testDataRoot(root), 'recontinue-' + runId)
const env = { ...runtimeEnv(root), LCA_DATA_DIR: data, LCA_PROVIDERS_FILE: join(data, 'absent.json'), LCA_CDP_PORT: '0', LCA_MCP_PORT: '0' }
let instance, page, client
const snapshot = () => page.evaluate(() => window.lca.getSnapshot())
const send = body => page.evaluate(async body => { const state = await window.lca.getSnapshot(); return window.lca.dispatch({ ...body, protocolVersion: 1, epoch: state.epoch, requestId: crypto.randomUUID() }) }, body)
async function until(predicate, label) {
  for (let i = 0; i < 600; i++) { const state = await snapshot(); if (predicate(state)) return state; await new Promise(done => setTimeout(done, 100)) }
  await writeFile(join(data, 'failed-state.json'), JSON.stringify(await snapshot(), null, 2)); throw new Error(label)
}
async function debug(name, args) { const result = await client.callTool({ name, arguments: args }); assert.ok(!result.isError); return JSON.parse(result.content[0].text) }
async function launch() {
  instance = await _electron.launch({ executablePath: electronPath, args: [root], env }); page = await instance.firstWindow()
  await page.emulateMedia({ reducedMotion: 'reduce' }); await initializeTestBook(page)
  const connection = JSON.parse(await readFile(join(data, 'developer', sceneId, 'debug-connection.json'), 'utf8'))
  client = new Client({ name: 'recontinue-smoke', version: '1.0.0' })
  await client.connect(new StreamableHTTPClientTransport(new URL(connection.url), { requestInit: { headers: { Authorization: 'Bearer ' + connection.token } } }))
}
async function stop() { await client?.close(); client = undefined; await instance?.close(); instance = undefined }
try {
  await mkdir(join(data, 'developer', sceneId), { recursive: true })
  await writeFile(join(data, 'settings.json'), JSON.stringify({ version: 1, developer: true, booth: false, plugins: {}, sceneId }))
  await writeFile(join(data, 'developer', sceneId, 'clock.json'), JSON.stringify({ nowMs: Date.parse('2026-11-04T20:00:00+08:00'), frozen: true, rate: 1 }))
  await launch()
  for (const text of ['SAFE_PREFIX', 'WITHDRAWN_POISON', 'WITHDRAWN_TAIL']) {
    const previous = (await snapshot()).task?.id
    await debug('set_fake_model', { script: [{ text: '合成回答：' + text, toolCalls: [], delayMs: 0 }] })
    assert.equal((await send({ type: 'message.send', text })).status, 'accepted')
    await until(state => state.task?.id !== previous && state.task?.status === 'completed', 'TURN_FAILED')
  }
  const original = await snapshot(), target = original.messages.find(message => message.text === 'WITHDRAWN_POISON')
  await page.getByRole('button', { name: '从这里重新继续', exact: true }).nth(1).click()
  const ready = await until(state => state.recontinue?.phase === 'ready' || state.recontinue?.phase === 'failed', 'PREVIEW_TIMEOUT')
  assert.equal(ready.recontinue.phase, 'ready', ready.recontinue.error)
  await page.screenshot({ path: join(data, 'preview.png') })
  await page.getByRole('button', { name: '确认重新继续', exact: true }).click()
  const done = await until(state => state.recontinue?.phase === 'complete' || state.recontinue?.phase === 'failed', 'COMMIT_TIMEOUT')
  assert.equal(done.recontinue.phase, 'complete', done.recontinue.error)
  assert.ok(done.messages.some(message => message.text === 'SAFE_PREFIX'))
  assert.ok(!JSON.stringify(done.messages).includes('WITHDRAWN_'))
  assert.equal(await page.locator('.composer-input').inputValue(), 'WITHDRAWN_POISON')
  const archived = await page.evaluate(id => window.lca.readSession(id), original.scope.sessionId)
  assert.equal(archived.messages.find(message => message.id === target.id).withdrawn, true)
  // get_context is the fixture provider's last actual request, not a freshly
  // assembled prompt. Recontinue must not call the model just to replace it.
  await stop(); await launch()
  const restarted = await snapshot()
  assert.ok(!JSON.stringify(restarted.messages).includes('WITHDRAWN_'))
  assert.equal(await page.locator('.composer-input').inputValue(), 'WITHDRAWN_POISON')
  await page.locator('.composer-input').fill('CLEAN_CONTINUATION')
  await debug('set_fake_model', { script: [{ text: '干净的新回答', toolCalls: [], delayMs: 0 }] })
  await page.getByRole('button', { name: '发送', exact: true }).click()
  await until(state => state.messages.some(message => message.text === '干净的新回答') && state.task?.status === 'completed', 'CONTINUE_FAILED')
  assert.ok(!JSON.stringify(await debug('get_context', {})).includes('WITHDRAWN_'))
  const save = join(data, 'recontinue.lca-save')
  await instance.evaluate(({ dialog }, file) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: file }) }, save)
  assert.equal((await whenIdle(send, { type: 'backup.export' })).status, 'accepted')
  await until(state => state.backup?.status === 'exported', 'EXPORT_FAILED')
  await debug('set_fake_model', { script: [{ text: 'POST_SAVE_MUST_NOT_RETURN', toolCalls: [], delayMs: 0 }] })
  const savedTurn = (await snapshot()).task.id
  await send({ type: 'message.send', text: 'POST_SAVE_MUST_NOT_RETURN' })
  await until(state => state.task?.id !== savedTurn && state.task?.status === 'completed', 'AFTER_SAVE_FAILED')
  await instance.evaluate(({ dialog, app }, file) => { app.relaunch = () => {}; dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }) }, save)
  assert.equal((await whenIdle(send, { type: 'backup.import' })).status, 'accepted')
  const staged = await until(state => state.backup?.status === 'awaiting-confirmation', 'IMPORT_FAILED')
  await client.close(); client = undefined
  const closed = instance.waitForEvent('close')
  await send({ type: 'backup.restore', restoreId: staged.backup.restoreId }); await closed; instance = undefined
  await launch()
  const restored = await snapshot()
  assert.ok(!JSON.stringify(restored.messages).match(/WITHDRAWN_|POST_SAVE/))
  await debug('set_fake_model', { script: [{ text: '恢复后的干净回答', toolCalls: [], delayMs: 0 }] })
  await send({ type: 'message.send', text: 'AFTER_RESTORE' })
  await until(state => state.messages.some(message => message.text === '恢复后的干净回答') && state.task?.status === 'completed', 'RESTORE_CONTINUE_FAILED')
  assert.ok(!JSON.stringify(await debug('get_context', {})).match(/WITHDRAWN_|POST_SAVE/))
  await debug('set_clock', { nowMs: Date.parse('2026-11-05T04:00:01+08:00'), frozen: true })
  const later = await snapshot()
  await send({ type: 'recontinue.preview', sessionId: original.scope.sessionId, messageId: original.messages.find(message => message.role === 'user').id, revision: later.recontinue.revision })
  const refused = await until(state => state.recontinue?.phase === 'failed', 'CROSS_DAY_NOT_REFUSED')
  assert.match(refused.recontinue.error, /今天这页/)
  await writeFile(join(data, 'report.json'), JSON.stringify({ ok: true, data, checks: ['native-cut', 'ui-preview', 'archive', 'draft-no-auto-send', 'restart', 'new-turn', 'private-save-restore', '04:00-refusal'] }, null, 2))
  console.log(JSON.stringify({ ok: true, data }))
} catch (error) {
  await writeFile(join(data, 'report.json'), JSON.stringify({ ok: false, data, error: String(error) }, null, 2))
  console.error(JSON.stringify({ ok: false, data })); throw error
} finally { await stop() }
