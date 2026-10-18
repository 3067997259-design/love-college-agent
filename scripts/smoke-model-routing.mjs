import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron } from 'playwright'
import electronPath from 'electron'
import { runtimeEnv, initializeTestBook, electronLaunchTarget } from './runtime-env.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const data = join(root, '.local-data', 'routing-smoke-' + randomUUID())
const calls = []; let denyPrivacy = false
const server = createServer((request, response) => { void (async () => {
  let text = ''; for await (const chunk of request) text += chunk
  const body = JSON.parse(text); calls.push(body)
  if (denyPrivacy && body.model === 'synthetic-privacy') { response.writeHead(401).end(); return }
  const prompt = body.messages[0].content
  const output = prompt.includes('Organize the provided document') ? JSON.stringify({ markdown: '# 已整理\n\n合成资料产物。', deadline: null })
    : prompt.includes('sourceId,quote,kind') ? JSON.stringify({ items: [] }) : '合成回复已收到。'
  response.writeHead(200, { 'Content-Type': 'text/event-stream' }).end('data: ' + JSON.stringify({ choices: [{ index: 0, delta: { content: output }, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n')
})().catch(() => { response.writeHead(500).end() }) })
await new Promise((done) => server.listen(0, '127.0.0.1', done))
const env = { ...runtimeEnv(root), LCA_DATA_DIR: data, LCA_PROVIDERS_FILE: join(data, 'absent.json') }
let instance; let page
const snapshot = () => page.evaluate(() => window.lca.getSnapshot())
const send = (body) => page.evaluate(async (body) => { const s = await window.lca.getSnapshot(); return window.lca.dispatch({ ...body, epoch: s.epoch, protocolVersion: 1, requestId: crypto.randomUUID() }) }, body)
const waitFor = async (check, label) => { for (let i = 0; i < 200; i++) { if (await check(await snapshot())) return; await new Promise((done) => setTimeout(done, 100)) } throw new Error(label) }
async function launch() { instance = await _electron.launch({ ...electronLaunchTarget(root, electronPath), env }); page = await instance.firstWindow(); page.setDefaultTimeout(15000); await initializeTestBook(page) }
async function configure(slot) {
  assert.equal((await send({ type: 'models.provider.save', slot, baseUrl: `http://127.0.0.1:${server.address().port}/v1`, model: 'synthetic-' + slot, apiKey: 'synthetic-routing-secret' })).status, 'accepted')
  await waitFor((s) => s.modelSettings.status === 'saved' && s.modelSettings.configuredSlots.includes(slot), 'CONFIG_NOT_APPLIED')
}
async function chat(text) {
  const previous = (await snapshot()).task?.id
  assert.equal((await send({ type: 'message.send', text })).status, 'accepted')
  await waitFor((s) => s.task?.id !== previous && s.task?.status === 'completed', 'CHAT_FAILED')
  return calls.filter((call) => call.tools?.length).at(-1)
}
async function file(name, content, status = 'ready') {
  const path = join(data, name + '.txt'); await writeFile(path, content)
  await page.getByLabel('选择资料文件', { exact: true }).setInputFiles(path)
  await waitFor((s) => s.documents.jobs.at(-1)?.status === status, 'DOCUMENT_' + status.toUpperCase())
}
try {
  await mkdir(data, { recursive: true }); await launch()
  assert.deepEqual((await snapshot()).modelSettings.routing, { background: 'follow-main', privacy: 'follow-main' })
  await configure('chat'); assert.equal((await snapshot()).modelSettings.restartRequired, false)
  await send({ type: 'mode.set', mode: 'quiet' })
  await chat('第一次配置后立即聊天。')
  assert.equal((await snapshot()).memory.status, 'idle'); assert.equal((await snapshot()).diary.status, 'idle')
  assert.equal((await send({ type: 'privacy.set', enabled: true })).status, 'rejected')
  await file('public', 'FOLLOW_MAIN_SOURCE student@example.edu 13800138000 API key: sk-syntheticinputcredential12345678')
  const organized = calls.find((call) => JSON.stringify(call).includes('FOLLOW_MAIN_SOURCE'))
  assert.equal(organized.model, 'synthetic-chat'); assert.ok(JSON.stringify(organized).includes('student@example.edu')); assert.ok(!JSON.stringify(organized).includes('sk-syntheticinput'))
  let request = await chat('请按刚导入的资料回答。')
  assert.ok(JSON.stringify(request).includes('FOLLOW_MAIN_SOURCE')); assert.ok(JSON.stringify(request).includes('13800138000'))
  await configure('privacy'); assert.equal((await snapshot()).privacy.mode, 'isolated')
  assert.equal((await send({ type: 'privacy.set', enabled: true })).status, 'accepted')
  await file('private', 'ISOLATED_SOURCE student-private@example.edu')
  const isolated = calls.find((call) => JSON.stringify(call).includes('ISOLATED_SOURCE'))
  assert.equal(isolated.model, 'synthetic-privacy'); assert.ok(!JSON.stringify(isolated).includes('student-private@example.edu'))
  request = await chat('再看一下处理进度。'); assert.ok(!JSON.stringify(request).includes('ISOLATED_SOURCE')); assert.ok(!JSON.stringify(request).includes('FOLLOW_MAIN_SOURCE'))
  denyPrivacy = true; const before = calls.filter((call) => call.model === 'synthetic-chat').length
  await file('failed-private', 'FAILED_PRIVATE_SOURCE', 'failed')
  assert.equal(calls.filter((call) => call.model === 'synthetic-chat').length, before)
  await page.getByRole('button', { name: '工具与设置', exact: true }).click()
  await page.locator('.provider-card[data-slot="privacy"]').getByLabel('使用方式', { exact: true }).selectOption('follow-main')
  await waitFor((s) => s.modelSettings.status === 'saved' && s.privacy.mode === 'follow-main', 'FOLLOW_MAIN_NOT_APPLIED')
  assert.equal((await snapshot()).privacy.fileFilteringEnabled, false)
  request = await chat('切换后再读之前公开的文件。')
  assert.ok(JSON.stringify(request).includes('FOLLOW_MAIN_SOURCE')); assert.ok(!JSON.stringify(request).includes('ISOLATED_SOURCE')); assert.ok(!JSON.stringify(request).includes('FAILED_PRIVATE_SOURCE'))
  await instance.close(); await launch(); await send({ type: 'mode.set', mode: 'quiet' })
  request = await chat('重启后继续读取公开资料。')
  assert.ok(JSON.stringify(request).includes('FOLLOW_MAIN_SOURCE')); assert.ok(!JSON.stringify(request).includes('ISOLATED_SOURCE'))
  assert.equal((await snapshot()).privacy.mode, 'follow-main')
  for (const folder of await readdir(join(data, 'journals'))) for (const name of await readdir(join(data, 'journals', folder))) if (name.endsWith('.jsonl')) {
    const journal = await readFile(join(data, 'journals', folder, name), 'utf8')
    for (const marker of ['FOLLOW_MAIN_SOURCE', 'ISOLATED_SOURCE', 'FAILED_PRIVATE_SOURCE', 'synthetic-routing-secret']) assert.ok(!journal.includes(marker), 'RAW_SOURCE_IN_JOURNAL')
  }
  console.log(JSON.stringify({ ok: true, probe: 'model-routing', hotChat: true, followsMainRaw: true, isolatedNoRaw: true, failedClosed: true, historicalIsolation: true, restart: true, noRawSourceJournal: true, syntheticOnly: true }))
} finally { await instance?.close().catch(() => {}); server.closeAllConnections(); await new Promise((done) => server.close(done)) }
