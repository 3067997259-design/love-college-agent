import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron } from 'playwright'
import electronPath from 'electron'
import JSZip from 'jszip'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { runtimeEnv, initializeTestBook } from './runtime-env.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..'); const data = join(root, '.local-data', 'gifts-smoke-' + randomUUID()); let sceneId = randomUUID()
const env = { ...runtimeEnv(root), LCA_DATA_DIR: data, LCA_PROVIDERS_FILE: join(data, 'absent.json'), LCA_CDP_PORT: '19536', LCA_MCP_PORT: '0' }
let instance; let page; let client
const errors = []
async function launch() { instance = await _electron.launch({ executablePath: electronPath, args: [root], env, timeout: 30000 }); page = await instance.firstWindow(); page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()) }); await initializeTestBook(page); await page.locator('[data-mode][data-pose]').waitFor() }
const snapshot = () => page.evaluate(() => window.lca.getSnapshot())
const send = (body) => page.evaluate(async (body) => { const s = await window.lca.getSnapshot(); return window.lca.dispatch({ protocolVersion: 1, requestId: crypto.randomUUID(), epoch: s.epoch, ...body }) }, body)
async function waitFor(test, code) { for (let i = 0; i < 150; i++) { if (test(await snapshot())) return; await new Promise((done) => setTimeout(done, 100)) }; throw new Error(code) }
async function debug(name, args = {}) { const result = await client.callTool({ name, arguments: args }); assert.ok(!result.isError); return JSON.parse(result.content[0].text) }
const tools = () => page.getByRole('button', { name: '工具与设置', exact: true }).click()
try {
  await mkdir(data, { recursive: true }); await writeFile(join(data, 'settings.json'), JSON.stringify({ version: 1, developer: true, booth: false, plugins: {}, sceneId }))
  await launch(); const connection = JSON.parse(await readFile(join(data, 'developer', sceneId, 'debug-connection.json'), 'utf8')); client = new Client({ name: 'gift-smoke', version: '1.0.0' })
  await client.connect(new StreamableHTTPClientTransport(new URL(connection.url), { requestInit: { headers: { Authorization: 'Bearer ' + connection.token } } }))
  await debug('set_clock', { frozen: true }); await debug('set_fake_model', { script: [{ text: '合成共同经历回应', toolCalls: [], delayMs: 0 }] })
  await send({ type: 'message.send', text: '我把纸桥放在书桌上，给它取名叫周五桥。' }); await waitFor((s) => s.task?.status === 'completed', 'GIFT_CONTEXT_NOT_READY')
  await send({ type: 'memory.extract' }); await waitFor((s) => s.memory.items.some((memory) => memory.kind === 'experience'), 'GIFT_MEMORY_NOT_READY')
  const sourceMemory = (await snapshot()).memory.items.find((memory) => memory.kind === 'experience')
  await tools(); await page.getByRole('combobox', { name: '礼物来源经历', exact: true }).selectOption(sourceMemory.id); await page.getByRole('button', { name: '提议礼物', exact: true }).click()
  await waitFor((s) => s.gifts.items[0]?.status === 'proposed', 'GIFT_NOT_PROPOSED')
  await send({ type: 'pomodoro.plan', plan: { label: '礼物合成验收', plannedCount: 1, focusDurationMs: 60000, shortBreakDurationMs: 20000, longBreakDurationMs: 20000, longBreakEvery: 4, timing: 'demo' } })
  const planId = (await snapshot()).pomodoro.proposal.id; await send({ type: 'pomodoro.confirm', planId }); await send({ type: 'pomodoro.start', planId }); await waitFor((s) => s.windows.mode === 'mini', 'GIFT_MINI_NOT_READY'); await send({ type: 'window.expand' }); await waitFor((s) => s.windows.mode === 'book', 'GIFT_BOOK_NOT_READY')
  await debug('set_clock', { nowMs: (await snapshot()).clock.nowMs + 5000 }); await waitFor((s) => s.gifts.items[0].status === 'making', 'GIFT_NOT_MAKING')
  await debug('set_clock', { nowMs: (await snapshot()).clock.nowMs + 5000 }); await waitFor((s) => s.gifts.items[0].status === 'ready', 'GIFT_NOT_READY')
  await page.locator('model-viewer').scrollIntoViewIfNeeded(); await page.locator('model-viewer[data-loaded="true"]').waitFor()
  assert.equal((await snapshot()).gifts.items[0].givenAtMs, null)
  await debug('set_clock', { nowMs: (await snapshot()).pomodoro.endsAtMs }); await debug('set_clock', { nowMs: (await snapshot()).clock.nowMs + 5000 }); await waitFor((s) => s.gifts.items[0].status === 'given', 'GIFT_NOT_GIVEN_AT_REST')
  const gift = (await snapshot()).gifts.items[0]; const archive = join(data, 'gift.lca-save')
  await instance.evaluate(({ dialog }, file) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: file }) }, archive)
  await send({ type: 'backup.export' }); await waitFor((s) => s.backup.status === 'exported', 'GIFT_ARCHIVE_NOT_EXPORTED')
  const zip = await JSZip.loadAsync(await readFile(archive)); const manifest = JSON.parse(await zip.file('manifest.json').async('string'))
  assert.ok(manifest.files.some((file) => file.path === 'artifacts/' + gift.assetRef.slice(6) + '.glb')); assert.ok(manifest.files.every((file) => !file.path.includes('rodin-jobs')))
  const serialized = JSON.stringify(await snapshot()) + JSON.stringify(await debug('get_diagnostics')); assert.ok(!serialized.includes('synthetic-private-handle'))
  assert.equal(errors.length, 0, 'MODEL_VIEWER_CONSOLE_ERROR')
  await client.close(); client = undefined; await instance.close(); sceneId = randomUUID(); await writeFile(join(data, 'settings.json'), JSON.stringify({ version: 1, developer: true, booth: false, plugins: {}, sceneId }))
  await launch(); await instance.evaluate(({ dialog, app }, file) => { app.relaunch = () => {}; dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }) }, archive)
  await send({ type: 'backup.import' }); await waitFor((s) => s.backup.status === 'awaiting-confirmation', 'GIFT_RESTORE_NOT_VALIDATED')
  const closed = instance.waitForEvent('close'); await send({ type: 'backup.restore', restoreId: (await snapshot()).backup.restoreId }); await closed; await launch()
  assert.deepEqual((await snapshot()).gifts.items[0], gift); await tools(); await page.locator('model-viewer').scrollIntoViewIfNeeded(); await page.locator('model-viewer[data-loaded="true"]').waitFor()
  assert.equal(errors.length, 0, 'RESTORED_MODEL_VIEWER_CONSOLE_ERROR')
  await mkdir(join(root, 'test-results'), { recursive: true }); await page.screenshot({ path: join(root, 'test-results', 'gifts.png') })
  console.log('Gifts Electron: witnessed experience / UI proposal, focus-only MCP making, validated GLB through owned local protocol and real model-viewer load, ready versus rest-given, private-handle exclusion, actual archive and blank-profile restore / 3D reload verified; fake generation only.')
} finally { await client?.close(); await instance?.close() }
