import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron } from 'playwright'
import electronPath from 'electron'
import Database from 'better-sqlite3'
import { runtimeEnv, initializeTestBook, electronLaunchTarget, openSettings } from './runtime-env.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const data = join(root, '.local-data', 'routing-smoke-' + randomUUID())
const calls = []; let denyPrivacy = false; let holdOrganization = false; let releaseOrganization
const hub = join(data, 'hub'); const dbPath = join(hub, 'var', 'student_hub.sqlite3')
const server = createServer((request, response) => { void (async () => {
  let text = ''; for await (const chunk of request) text += chunk
  const body = JSON.parse(text); calls.push(body)
  if (denyPrivacy && body.model === 'synthetic-privacy') { response.writeHead(401).end(); return }
  const prompt = body.messages[0].content
  const actualUser = body.messages.findLastIndex((message) => message.role === 'user' && !String(message.content).startsWith('{'))
  const latestText = body.messages[actualUser]?.content ?? ''
  const hasTool = body.messages.slice(actualUser + 1).some((message) => message.role === 'tool')
  let nextTool
  if (body.tools?.length && !hasTool && latestText.startsWith('校园助手测试：')) nextTool = { name: 'campus_assistant', arguments: JSON.stringify({ action: latestText.split('：')[1], ...(!['health', 'scan', 'import'].includes(latestText.split('：')[1]) ? { jobId: 'scan_fixture' } : {}) }) }
  if (body.tools?.length && !hasTool && /切换后|重启后/.test(latestText)) {
    const state = body.messages.map((message) => { try { return JSON.parse(message.content) } catch { return {} } }).findLast((message) => message.files)
    const file = state?.files.find((file) => file.readableByMain)
    if (file) nextTool = { name: 'read_uploaded_file', arguments: JSON.stringify({ documentId: file.documentId }) }
  }
  if (nextTool) { response.writeHead(200, { 'Content-Type': 'text/event-stream' }).end('data: ' + JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call-' + randomUUID(), type: 'function', function: nextTool }] }, finish_reason: 'tool_calls' }] }) + '\n\ndata: [DONE]\n\n'); return }
  if (holdOrganization && prompt.includes('Organize the provided document')) await new Promise((resolve) => { releaseOrganization = resolve })
  const readIndex = body.messages.findLastIndex((message) => message.content === '立即读这份刚上传的文件。')
  if (body.tools?.length && readIndex >= 0 && !body.messages.slice(readIndex + 1).some((message) => message.role === 'tool')) {
    response.writeHead(200, { 'Content-Type': 'text/event-stream' }).end('data: ' + JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'ignored-mail-read', type: 'function', function: { name: 'get_campus_items', arguments: '{}' } }] }, finish_reason: 'tool_calls' }] }) + '\n\ndata: [DONE]\n\n'); return
  }
  const output = prompt.includes('Return only JSON. If no concrete user action') ? JSON.stringify({ kind: 'deadline', task: '活动报名', titleQuote: '校园助手活动报名', sourceRole: 'other', deadline: { iso: '2026-11-03T23:00:00+08:00', quote: '2026-11-03 23:00' } })
    : prompt.includes('Organize the provided document') ? JSON.stringify({ markdown: '# 已整理\n\n合成资料产物。', deadline: null })
    : prompt.includes('sourceId,quote,kind') ? JSON.stringify({ items: [] }) : '合成回复已收到。'
  response.writeHead(200, { 'Content-Type': 'text/event-stream' }).end('data: ' + JSON.stringify({ choices: [{ index: 0, delta: { content: output }, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n')
})().catch(() => { response.writeHead(500).end() }) })
await new Promise((done) => server.listen(0, '127.0.0.1', done))
const env = { ...runtimeEnv(root), LCA_DATA_DIR: data, LCA_PROVIDERS_FILE: join(data, 'absent.json'), LCA_STUDENT_HUB_ROOT: hub, LCA_STUDENT_HUB_DB: dbPath }
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
  await mkdir(join(hub, 'var'), { recursive: true }); await mkdir(join(hub, 'config'), { recursive: true })
  await writeFile(join(hub, 'config', 'sources.toml'), '[database]\npath = "var/student_hub.sqlite3"\n')
  await mkdir(join(hub, 'src', 'student_hub'), { recursive: true })
  await writeFile(join(hub, 'src', 'student_hub', '__init__.py'), '')
  await writeFile(join(hub, 'src', 'student_hub', 'assistant.py'), `class Store:
 def list_items_for_artifact(self, artifact_id): return []
 def list_unreviewed_artifacts(self, limit):
  return [{"id": 91, "version": 1, "source_id": "synthetic", "subject": "校园助手活动报名", "payload": {"text":"校园助手活动报名截止：2026-11-03 23:00 UNIFIED_SOURCE_ONLY"}, "occurred_at":"2026-10-18T00:00:00+08:00"}]
class StudentHubAssistant:
 def __init__(self, *args, **kwargs): self.store=Store()
 def scan_school_updates(self, **kwargs): return {"id":"scan_fixture","status":"running"}
 def get_school_update_scan(self, job_id): return {"id":job_id,"status":"succeeded"}
 def cancel_school_update_scan(self, job_id): return {"id":job_id,"status":"cancelled"}
`)
  const db = new Database(dbPath)
  db.exec(`CREATE TABLE items (id TEXT PRIMARY KEY, item_type TEXT NOT NULL, title TEXT NOT NULL, course TEXT, status TEXT NOT NULL, deadline_at TEXT, event_start TEXT, event_end TEXT, calendar_role TEXT, source_summary TEXT, created_at TEXT NOT NULL);
    CREATE TABLE item_evidence (item_id TEXT NOT NULL, artifact_id INTEGER NOT NULL); CREATE TABLE raw_artifacts (id INTEGER PRIMARY KEY, subject TEXT, payload_json TEXT NOT NULL);`)
  for (let i = 0; i < 3; i++) db.prepare('INSERT INTO items VALUES (?,?,?,?,?,?,?,?,?,?,?)').run('ignored-' + i, 'deadline', '待忽略邮件' + i, '测试课程', 'confirmed', '2027-01-05T23:00:00+08:00', null, null, null, 'IGNORED_MAIL_SOURCE_' + i, '2026-10-18T00:00:00+08:00')
  db.close(); await launch()
  assert.deepEqual((await snapshot()).modelSettings.routing, { background: 'follow-main', privacy: 'follow-main', work: 'follow-main' })
  await configure('chat'); assert.equal((await snapshot()).modelSettings.restartRequired, false)
  await send({ type: 'mode.set', mode: 'quiet' })
  await chat('第一次配置后立即聊天。')
  await page.locator('.bookmarks').getByRole('button', { name: '插件', exact: true }).click()
  const center = page.getByRole('region', { name: '插件', exact: true })
  await center.getByRole('button', { name: '+ 添加插件', exact: true }).click()
  await center.getByRole('menuitem', { name: '安装本地插件', exact: true }).click()
  const dialog = center.getByRole('dialog', { name: '添加插件', exact: true })
  await dialog.getByLabel('安装本地插件', { exact: true }).fill(join(root, 'plugin-packages', 'campus-assistant'))
  await dialog.getByRole('button', { name: '安装', exact: true }).click()
  const row = center.locator('.plugin-row[data-plugin-id="campus-assistant"]')
  await row.getByRole('switch').click()
  await row.getByRole('alertdialog', { name: '确认并启用', exact: true }).getByRole('button', { name: '确认并启用', exact: true }).click()
  await waitFor((s) => s.candidates.length === 3, 'THREE_CANDIDATES_MISSING')
  for (const candidate of (await snapshot()).candidates) assert.equal((await send({ type: 'candidate.ignore', candidateId: candidate.id, expectedRevision: candidate.revision })).status, 'accepted')
  await page.locator('.bookmarks').getByRole('button', { name: /^对话/ }).click()
  for (const action of ['health', 'scan', 'status', 'collect']) {
    const request = await chat('校园助手测试：' + action)
    assert.ok(!JSON.stringify(request).includes('UNIFIED_SOURCE_ONLY'), 'PLUGIN_EVIDENCE_LEAKED_TO_TOOL_CONTEXT')
  }
  await waitFor((s) => s.candidates.some((candidate) => candidate.status === 'candidate'), 'SCANNED_EVIDENCE_NOT_TRIAGED')
  const proposed = (await snapshot()).candidates.find((candidate) => candidate.status === 'candidate')
  assert.equal((await send({ type: 'candidate.confirm', candidateId: proposed.id, expectedRevision: proposed.revision })).status, 'accepted')
  assert.equal((await send({ type: 'campus.export' })).status, 'accepted')
  await waitFor((s) => s.deliveries.some((delivery) => delivery.status === 'ready'), 'UNIFIED_LOCAL_DELIVERY_MISSING')
  holdOrganization = true
  await file('immediate', 'IMMEDIATE_UPLOAD_SOURCE 这份文件介绍图书馆志愿活动。', 'processing')
  await page.locator('.file-notice').filter({ hasText: '正在整理' }).waitFor()
  const immediate = await chat('立即读这份刚上传的文件。')
  assert.ok(JSON.stringify(immediate).includes('IMMEDIATE_UPLOAD_SOURCE'), 'UPLOAD_NOT_READABLE_DURING_ORGANIZATION')
  assert.ok(!JSON.stringify(immediate).includes('IGNORED_MAIL_SOURCE'), 'IGNORED_MAIL_RETURNED')
  const activeItems = JSON.parse(immediate.messages.findLast((message) => message.role === 'tool').content).items
  assert.equal(activeItems.length, 1); assert.equal(activeItems[0].status, 'confirmed'); assert.ok(!JSON.stringify(activeItems).includes('待忽略邮件'))
  assert.equal((await snapshot()).documents.jobs.at(-1).status, 'processing')
  holdOrganization = false; releaseOrganization?.()
  await waitFor((s) => s.documents.jobs.at(-1)?.status === 'ready', 'HELD_ORGANIZATION_NOT_FINISHED')
  await page.locator('.file-notice').filter({ hasText: '已整理' }).waitFor()
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
  await openSettings(page)
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
    for (const marker of ['UNIFIED_SOURCE_ONLY', 'IMMEDIATE_UPLOAD_SOURCE', 'IGNORED_MAIL_SOURCE', 'FOLLOW_MAIN_SOURCE', 'ISOLATED_SOURCE', 'FAILED_PRIVATE_SOURCE', 'synthetic-routing-secret']) assert.ok(!journal.includes(marker), 'RAW_SOURCE_IN_JOURNAL')
  }
  console.log(JSON.stringify({ ok: true, probe: 'model-routing', unifiedCampusPlugin: true, scanToCandidateAndLocalDelivery: true, ignoredMailThenImmediateUpload: true, processingSourceReadable: true, progressVisible: true, hotChat: true, followsMainRaw: true, isolatedNoRaw: true, failedClosed: true, historicalIsolation: true, restart: true, noRawSourceJournal: true, syntheticOnly: true }))
} finally { releaseOrganization?.(); await instance?.close().catch(() => {}); server.closeAllConnections(); await new Promise((done) => server.close(done)) }
