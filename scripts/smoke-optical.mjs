import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { randomUUID, createHash } from 'node:crypto'
import { mkdir, writeFile, readFile, readdir } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron } from 'playwright'
import electronPath from 'electron'
import JSZip from 'jszip'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { runtimeEnv, initializeTestBook } from './runtime-env.mjs'
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..'); const data = join(root, '.local-data', 'optical-' + randomUUID()); let sceneId = randomUUID()
const env = { ...runtimeEnv(root), LCA_DATA_DIR: data, LCA_PROVIDERS_FILE: join(data, 'absent.json'), LCA_CDP_PORT: '19571', LCA_MCP_PORT: '0' }
const credential = 'SYNTHETIC_OPTICAL_' + randomUUID(); const requests = []; let hang = false; let interrupted = 0
const server = createServer(async (req, res) => {
  let bytes = Buffer.alloc(0); for await (const chunk of req) { bytes = Buffer.concat([bytes, chunk]); if (bytes.length > 4000000) { res.writeHead(413).end(); return } }
  assert.equal(req.headers.authorization, 'Bearer ' + credential); const body = JSON.parse(bytes.toString('utf8')); const png = Buffer.from(body.image_base64, 'base64')
  assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a'); assert.equal(png.readUInt32BE(16), 1280); assert.equal(png.readUInt32BE(20), 1280)
  assert.equal(body.crop_mode, false); assert.equal(body.base_size, body.image_size); assert.equal(body.text, undefined); assert.equal(body.sources, undefined)
  requests.push(body.image_size)
  if (hang) { res.on('close', () => { interrupted++ }); return }
  res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ text: 'U: 我们一起折了蓝色的纸桥。\n作者叫林红，编号 B-104。\n交作业。\nPRIVATE_OCR_INJECTED_UNSEEN' }))
})
await new Promise((done) => server.listen(0, '127.0.0.1', done)); const endpoint = 'http://127.0.0.1:' + server.address().port + '/decode'
let instance; let page; let client
async function profile(time) { await mkdir(data, { recursive: true }); await writeFile(join(data, 'settings.json'), JSON.stringify({ version: 1, developer: true, booth: false, plugins: {}, sceneId })); await mkdir(join(data, 'developer', sceneId), { recursive: true }); await writeFile(join(data, 'developer', sceneId, 'clock.json'), JSON.stringify({ nowMs: time, frozen: true, rate: 1 })) }
async function launch() { instance = await _electron.launch({ executablePath: electronPath, args: [root], env }); page = await instance.firstWindow(); await initializeTestBook(page)
  const config = JSON.parse(await readFile(join(data, 'developer', sceneId, 'debug-connection.json'), 'utf8')); client = new Client({ name: 'optical-smoke', version: '1.0.0' }); await client.connect(new StreamableHTTPClientTransport(new URL(config.url), { requestInit: { headers: { Authorization: 'Bearer ' + config.token } } })) }
async function stop() { await client?.close(); client = undefined; await instance?.close(); instance = undefined }
const snapshot = () => page.evaluate(() => window.lca.getSnapshot())
const send = (body) => page.evaluate(async (body) => { const s = await window.lca.getSnapshot(); return window.lca.dispatch({ protocolVersion: 1, epoch: s.epoch, requestId: crypto.randomUUID(), ...body }) }, body)
async function accept(body) { const ack = await send(body); assert.equal(ack.status, 'accepted', body.type + ':' + JSON.stringify(ack)) }
async function waitFor(test, message) { for (let i = 0; i < 150; i++) { if (test(await snapshot())) return; await new Promise((done) => setTimeout(done, 100)) }; throw new Error(message) }
async function debug(name, args = {}) { const value = await client.callTool({ name, arguments: args }); assert.ok(!value.isError); return JSON.parse(value.content[0].text) }
async function reply(text = 'SYNTHETIC_ORDINARY_REPLY') { await debug('set_fake_model', { script: [{ text, toolCalls: [], delayMs: 0 }] }) }
async function chat(text) { await accept({ type: 'message.send', text }); await waitFor((s) => s.task?.status === 'completed', 'CHAT_FAILED') }
try {
  await profile(Date.parse('2026-10-16T12:00:00+08:00')); await launch(); assert.equal((await snapshot()).opticalMemory.enabled, false)
  const source = '2026年10月16日，我们一起折了蓝色的纸桥。作者叫林青，编号 B-104。\n我今天不交作业。\n' + '合成观察：我们把纸桥放回书桌，准备明天再看。'.repeat(45)
  await reply(); await chat(source); await reply(); await chat('给今天的合成经历留一个可回查的来源。'); const oldId = (await snapshot()).scope.sessionId
  await debug('set_clock', { nowMs: Date.parse('2026-10-17T12:00:00+08:00'), frozen: true }); await waitFor((s) => s.session.dayKey === '2026-10-17', 'ROLLOVER_FAILED')
  const configFile = join(data, 'synthetic-optical-config.json'); await writeFile(configFile, JSON.stringify({ endpoint, apiKey: credential }))
  await instance.evaluate(({ dialog }, file) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }) }, configFile)
  await accept({ type: 'optical.configure' }); await waitFor((s) => s.opticalMemory.source === 'fake' && s.opticalMemory.status === 'idle', 'OPTICAL_CONFIG_FAILED')
  await accept({ type: 'optical.enable', enabled: true }); await accept({ type: 'optical.encode', sessionId: oldId }); await waitFor((s) => s.opticalMemory.status !== 'processing', 'OPTICAL_RENDER_TIMEOUT')
  let optical = (await snapshot()).opticalMemory; assert.equal(optical.status, 'idle'); assert.ok(optical.frames.length >= 2); const frame = optical.frames[0]; assert.equal(frame.pageIndex, 0)
  for (const tier of ['large', 'base', 'small', 'tiny']) { await accept({ type: 'optical.decode', frameId: frame.id, tier }); await waitFor((s) => s.opticalMemory.status !== 'processing', 'OPTICAL_DECODE_TIMEOUT') }
  assert.deepEqual(requests, [1280, 1024, 640, 512]); optical = (await snapshot()).opticalMemory
  assert.ok(optical.impressions.every((entry) => entry.status === 'guarded' && entry.verifiedLineCount === 1 && entry.rejectedLineCount === 3))
  const read = await page.evaluate((id) => window.lca.readOpticalMemory(id), frame.id); assert.deepEqual(read.impressions[0].fragments, ['我们一起折了蓝色的纸桥。'])
  const pngPath = join(data, 'developer', sceneId, 'artifacts', read.imageUrl.split('/').at(-1) + '.png'); const png = await readFile(pngPath); assert.ok(png.length > 10000)
  assert.ok(!JSON.stringify(await snapshot()).includes('我们一起折了蓝色的纸桥。')); assert.ok(!JSON.stringify(await snapshot()).includes(credential)); assert.ok(!JSON.stringify(await debug('get_state')).includes(endpoint))
  await page.getByRole('button', { name: '工具与设置', exact: true }).click(); await page.getByRole('button', { name: '查阅光学页', exact: true }).first().click()
  await page.getByRole('article', { name: '用户光学页' }).waitFor(); assert.equal(await page.getByAltText('当时可见对话的独立印刷页').evaluate((img) => img.naturalWidth), 1280)
  await page.getByRole('button', { name: '关闭光学页', exact: true }).click(); await page.getByRole('button', { name: '关闭', exact: true }).click()
  // 书页入口：往回翻到这一页，“她的印象”里是同一张 1280 宽的封页，高清档列出还能对上原话的那一行；看完回到今天
  await page.locator('.turn-back').click(); await page.locator('.impression-toggle').click(); await page.locator('.impression-sheet').waitFor()
  await page.waitForFunction(() => document.querySelector('.impression-sheet')?.naturalWidth > 0); assert.equal(await page.locator('.impression-sheet').evaluate((img) => img.naturalWidth), 1280)
  assert.ok((await page.locator('.impression-tier').first().innerText()).includes('我们一起折了蓝色的纸桥。'))
  await page.locator('.impression-toggle').click(); await page.locator('.old-page .page-turn button', { hasText: '回到今天' }).click(); await page.locator('.old-page').waitFor({ state: 'detached' })
  const miniPromise = instance.waitForEvent('window'); await accept({ type: 'window.mini' }); const mini = await miniPromise; await mini.waitForFunction(() => !!window.lca)
  assert.equal(await mini.evaluate(async (id) => { try { await window.lca.readOpticalMemory(id); return false } catch { return true } }, frame.id), true); await accept({ type: 'window.expand' })
  await debug('set_fake_model', { script: [{ text: '', toolCalls: [{ id: 'optical-list', name: 'recall_optical', arguments: '{}' }], delayMs: 0 }, { text: '', toolCalls: [{ id: 'optical-read', name: 'recall_optical', arguments: JSON.stringify({ frameId: frame.id, tier: 'large' }) }], delayMs: 0 }, { text: 'OPTICAL_DERIVED_REPLY', toolCalls: [], delayMs: 0 }] }); await chat('试着回忆这张合成旧页，不确定的细节不要补全。')
  assert.ok(JSON.stringify(await debug('get_context')).includes('unreviewed-impression')); assert.ok(!JSON.stringify(await debug('get_context')).includes('林红'))
  await reply(); await chat('现在继续普通对话。')
  // A real stalled HTTP response is cancelled on lights-out. Its untrusted text cannot be committed.
  hang = true; await accept({ type: 'optical.decode', frameId: optical.frames[1].id, tier: 'large' })
  for (let i = 0; i < 100 && requests.length < 5; i++) await new Promise((done) => setTimeout(done, 20))
  assert.equal(requests.length, 5); await accept({ type: 'lights.set', lightsOut: true }); await waitFor((s) => s.opticalMemory.status !== 'processing', 'OPTICAL_CANCEL_FAILED'); await accept({ type: 'lights.set', lightsOut: false }); hang = false
  for (let i = 0; i < 100 && interrupted === 0; i++) await new Promise((done) => setTimeout(done, 20)); assert.ok(interrupted > 0)
  assert.equal((await snapshot()).opticalMemory.impressions.length, 4)
  const journalDir = join(data, 'developer', sceneId, 'journals'); const owner = join(journalDir, (await readdir(journalDir))[0]); const texts = await Promise.all((await readdir(owner)).filter((file) => file.endsWith('.jsonl')).map((file) => readFile(join(owner, file), 'utf8')))
  for (const row of texts.join('\n').split(/\r?\n/).filter(Boolean).map(JSON.parse)) if (row.type === 'model/seen') for (const index of row.eligibleIndexes) assert.ok(!row.messages[index].content.includes('OPTICAL_DERIVED_REPLY'))
  assert.ok(!texts.join('\n').includes('PRIVATE_OCR_INJECTED_UNSEEN')); assert.ok(!texts.join('\n').includes(credential))
  const archive = join(data, 'optical.lca-save'); await instance.evaluate(({ dialog }, file) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: file }) }, archive)
  await accept({ type: 'backup.export' }); await waitFor((s) => s.backup.status === 'exported', 'OPTICAL_EXPORT_FAILED')
  const zip = await JSZip.loadAsync(await readFile(archive)); assert.ok(!Object.keys(zip.files).some((name) => name.includes('connections')))
  const allBytes = Buffer.concat(await Promise.all(Object.values(zip.files).filter((file) => !file.dir).map((file) => file.async('nodebuffer')))); assert.ok(!allBytes.includes(Buffer.from(credential))); assert.ok(!allBytes.includes(Buffer.from(endpoint)))
  const count = requests.length; await stop(); await launch(); assert.equal(requests.length, count); assert.equal((await snapshot()).opticalMemory.frames.length, optical.frames.length)
  await stop(); sceneId = randomUUID(); await profile(Date.parse('2026-10-20T12:00:00+08:00')); await launch(); assert.equal((await snapshot()).opticalMemory.frames.length, 0)
  await instance.evaluate(({ dialog, app }, file) => { app.relaunch = () => {}; dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }) }, archive)
  await accept({ type: 'backup.import' }); await waitFor((s) => s.backup.status === 'awaiting-confirmation', 'OPTICAL_IMPORT_FAILED'); const restoreId = (await snapshot()).backup.restoreId
  await client.close(); client = undefined; const closed = instance.waitForEvent('close'); await accept({ type: 'backup.restore', restoreId }); await closed; instance = undefined
  await launch(); const restored = await page.evaluate((id) => window.lca.readOpticalMemory(id), frame.id); assert.deepEqual(restored, read)
  const restoredPng = await readFile(join(data, 'developer', sceneId, 'artifacts', restored.imageUrl.split('/').at(-1) + '.png')); assert.equal(createHash('sha256').update(restoredPng).digest('hex'), createHash('sha256').update(png).digest('hex'))
  assert.equal((await snapshot()).opticalMemory.source, 'none'); assert.equal((await snapshot()).opticalMemory.status, 'unconfigured'); assert.equal(requests.length, count)
  console.log('Optical Electron PASS: actual 1280px print-page PNG, scoped witnessed dialogue only, four image-only HTTP tiers, altered-name/negation rejection, user-only page read, no OCR-derived memory echo, live network cancellation, no restart replay, exact private PNG/impression restore and no endpoint/credential export; synthetic HTTP and fake chat, no real OCR quality claim.')
} finally { await stop(); server.closeAllConnections(); await new Promise((done) => server.close(done)) }
