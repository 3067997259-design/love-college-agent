import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron } from 'playwright'
import electronPath from 'electron'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { runtimeEnv, initializeTestBook } from './runtime-env.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const data = join(root, '.local-data', 'memory-smoke-' + randomUUID()); const sceneId = randomUUID()
const profile = join(data, 'developer', sceneId)
const env = { ...runtimeEnv(root), LCA_DATA_DIR: data, LCA_PROVIDERS_FILE: join(data, 'absent-test-providers.json'), LCA_MCP_PORT: '0', LCA_CDP_PORT: '19531' }
let instance; let page; let client
async function launch() { instance = await _electron.launch({ executablePath: electronPath, args: [root], env, timeout: 30_000 }); page = await instance.firstWindow(); await initializeTestBook(page); await page.locator('[data-mode][data-pose]').waitFor() }
const snapshot = () => page.evaluate(() => window.lca.getSnapshot())
async function waitFor(predicate, error) { for (let i = 0; i < 150; i++) { if (predicate(await snapshot())) return; await new Promise((done) => setTimeout(done, 100)) } throw new Error(error) }
const send = (body) => page.evaluate(async (body) => { const s = await window.lca.getSnapshot(); return window.lca.dispatch({ ...body, epoch: s.epoch, protocolVersion: 1, requestId: crypto.randomUUID() }) }, body)
const tools = () => page.getByRole('button', { name: '工具与设置', exact: true }).click()
const closeTools = () => page.getByRole('button', { name: '关闭', exact: true }).click()
const safe = (value) => { const text = JSON.stringify(value); for (const marker of ['RAW_ONLY_', 'USER_ONLY_DOCUMENT_RESULT', 'sk-synthetic']) assert.ok(!text.includes(marker), 'PRIVATE_MEMORY_LEAK') }
const mcp = async (name, args = {}) => { const result = await client.callTool({ name, arguments: args }); assert.ok(!result.isError, 'MCP_OPERATION_FAILED'); return JSON.parse(result.content[0].text) }
const setReply = (text = 'SYNTHETIC_MEMORY_REPLY', delayMs = 0) => mcp('set_fake_model', { script: [{ text, toolCalls: [], delayMs }] })
const setClock = (iso) => mcp('set_clock', { nowMs: Date.parse(iso), frozen: true })
async function chat(text) {
  const count = (await snapshot()).messages.length
  assert.equal((await send({ type: 'message.send', text })).status, 'accepted')
  await waitFor((s) => s.task?.status === 'completed' && s.messages.length >= count + 2, 'SYNTHETIC_CHAT_FAILED')
}
async function memoryAction(type) {
  assert.equal((await send({ type })).status, 'accepted')
  await waitFor((s) => !['extracting', 'compacting'].includes(s.memory.status), 'MEMORY_OPERATION_NOT_SETTLED')
}
try {
  await mkdir(data, { recursive: true }); await launch()
  assert.equal((await snapshot()).memory.status, 'unconfigured')
  const denied = await send({ type: 'message.send', text: '/compact' }); assert.equal(denied.error.code, 'not-configured')
  assert.equal(await page.evaluate(() => window.lca.readSession('../private').then(() => false, () => true)), true)
  await instance.close()
  await writeFile(join(data, 'settings.json'), JSON.stringify({ version: 1, developer: true, booth: false, plugins: {}, sceneId }))
  // Start before the rollover under test, independent of the machine's current date/hour.
  // Moving from a real 06:00 startup back to 03:59 otherwise leaves future user timestamps.
  await mkdir(profile, { recursive: true })
  await writeFile(join(profile, 'clock.json'), JSON.stringify({ nowMs: Date.parse('2026-10-16T20:00:00+08:00'), rate: 1, frozen: true }))
  await launch(); assert.equal((await snapshot()).memory.source, 'fake')
  const discovery = JSON.parse(await readFile(join(profile, 'debug-connection.json'), 'utf8'))
  client = new Client({ name: 'lca-memory-smoke', version: '1.0.0' })
  await client.connect(new StreamableHTTPClientTransport(new URL(discovery.url), { requestInit: { headers: { Authorization: 'Bearer ' + discovery.token } } }))
  await mcp('set_clock', { frozen: true })
  await send({ type: 'mode.set', mode: 'quiet' })
  await setReply(); await chat('我把纸桥放在书桌上，给它取名叫周五桥。')
  await setReply(); await chat('我喜欢的饮料是咖啡。')
  await setReply(); await chat('我喜欢的饮料现在改为红茶，不再喝咖啡。')
  await tools(); await page.getByRole('button', { name: '抽取可见经历', exact: true }).click()
  await waitFor((s) => s.memory.items.length === 3, 'VISIBLE_EXPERIENCE_NOT_EXTRACTED')
  assert.equal((await snapshot()).memory.items.filter((item) => item.supersededBy).length, 1)
  assert.equal(await page.locator('.memory-item[data-superseded="true"]').count(), 1)
  await page.getByRole('button', { name: '扫描合成邮件', exact: true }).click()
  await waitFor((s) => s.mailbox.status === 'ready', 'SYNTHETIC_MAIL_NOT_READY'); await closeTools()
  await send({ type: 'privacy.set', enabled: true }); await send({ type: 'developer.document.import', fixtureId: 'notes-text' })
  await waitFor((s) => s.documents.jobs.at(-1)?.status === 'ready', 'SYNTHETIC_DOCUMENT_NOT_READY')
  await mcp('set_fake_model', { script: [
    { text: '', toolCalls: [{ id: 'files', name: 'get_processed_files', arguments: '{}' }, { id: 'memory', name: 'search_memory', arguments: '{"query":"饮料"}' }], delayMs: 0 },
    { text: 'SYNTHETIC_METADATA_RECALL_COMPLETE', toolCalls: [], delayMs: 0 },
  ] })
  await chat('核对饮料和资料处理状态')
  const recalled = await mcp('get_context'); safe(recalled)
  const result = recalled.find((message) => message.role === 'tool' && message.content.includes('我喜欢的饮料现在改为红茶'))
  assert.ok(result, 'MEMORY_TOOL_NOT_RUN'); assert.ok(!result.content.includes('"text":"我喜欢的饮料是咖啡。"'), 'SUPERSEDED_MEMORY_RECALLED')
  for (let i = 0; i < 4; i++) { await setReply(); await chat('合成旧回合 ' + i + ' 这是可见对话压缩验收。'.repeat(100)) }
  const before = await snapshot(); const originalCount = before.messages.length
  await tools(); await page.getByLabel('记忆模型场景').selectOption('invalid')
  await page.getByRole('button', { name: '压缩旧回合', exact: true }).click()
  await waitFor((s) => s.memory.error?.code === 'memory-invalid-output', 'INVALID_SUMMARY_NOT_REJECTED')
  assert.equal((await snapshot()).memory.contextChars, before.memory.contextChars)
  await page.getByLabel('记忆模型场景').selectOption('ready'); await closeTools()
  // /compact is a local command. It produces no model reply and preserves the full user chat.
  assert.equal((await send({ type: 'message.send', text: '/compact' })).status, 'accepted')
  await waitFor((s) => s.memory.lastCompactedAtMs != null && s.memory.status === 'idle', 'LOCAL_COMPACT_FAILED')
  assert.ok((await snapshot()).memory.contextChars < before.memory.contextChars)
  assert.equal((await snapshot()).messages.length, originalCount)
  await tools(); const oldSession = (await snapshot()).scope.sessionId
  await page.getByLabel('历史会话', { exact: true }).selectOption(oldSession)
  await page.getByRole('region', { name: '历史聊天', exact: true }).getByText('我把纸桥放在书桌上，给它取名叫周五桥。', { exact: true }).waitFor()
  await page.getByRole('button', { name: '收起旧页', exact: true }).click(); await closeTools()
  await setClock('2026-10-17T03:59:50+08:00')
  await waitFor((s) => !['extracting', 'compacting'].includes(s.memory.status), 'BACKGROUND_NOT_IDLE')
  await setReply('SYNTHETIC_HELD_REPLY', 60_000)
  assert.equal((await send({ type: 'message.send', text: 'SYNTHETIC_HOLD_TURN' })).status, 'accepted')
  await waitFor((s) => s.task?.status === 'running', 'HELD_TURN_NOT_STARTED')
  await setClock('2026-10-17T04:00:30+08:00'); assert.equal((await snapshot()).scope.sessionId, oldSession)
  await setClock('2026-10-17T04:00:55+08:00')
  await waitFor((s) => s.task?.status === 'completed', 'HELD_TURN_NOT_COMPLETED')
  await send({ type: 'lights.set', lightsOut: true }); await setClock('2026-10-17T04:03:00+08:00')
  assert.equal((await snapshot()).scope.sessionId, oldSession)
  await send({ type: 'lights.set', lightsOut: false })
  // Scheduler deliberately resumes at its next named deadline after lights-out.
  await setClock('2026-10-17T04:03:31+08:00')
  await waitFor((s) => s.scope.sessionId !== oldSession, 'SAME_PROCESS_DAY_ROLLOVER_FAILED')
  const next = await snapshot(); assert.equal(next.session.dayKey, '2026-10-17'); assert.notEqual(next.epoch, before.epoch)
  assert.ok(next.session.pages.some((item) => item.sessionId === oldSession && item.summarized))
  await setReply(); await chat('纸桥')
  const prepared = await mcp('get_context'); safe(prepared)
  const oldSummary = prepared.findIndex((message) => message.content.includes('previousDaysReference'))
  const recall = prepared.findIndex((message) => message.content.includes('memoryReference'))
  assert.ok(oldSummary >= 0 && recall > oldSummary && recall < prepared.length - 1, 'NEXT_DAY_CONTEXT_ORDER_FAILED')
  await tools(); await page.getByLabel('历史会话', { exact: true }).selectOption(oldSession)
  await page.getByRole('region', { name: '历史聊天', exact: true }).getByText('我把纸桥放在书桌上，给它取名叫周五桥。', { exact: true }).waitFor()
  assert.equal((await snapshot()).messages.some((message) => message.text === '/compact'), false)
  await closeTools(); await memoryAction('memory.extract')
  safe(await snapshot()); safe(await mcp('get_state'))
  const folders = await readdir(join(profile, 'journals'), { withFileTypes: true })
  for (const folder of folders.filter((item) => item.isDirectory())) for (const name of await readdir(join(profile, 'journals', folder.name))) {
    if (name.endsWith('.jsonl')) safe(await readFile(join(profile, 'journals', folder.name, name), 'utf8'))
  }
  const persisted = await snapshot(); await client.close(); client = undefined; await instance.close(); await launch()
  const restored = await snapshot(); assert.deepEqual(restored.memory.items, persisted.memory.items); assert.equal(restored.session.pages.length, 2)
  const archive = await page.evaluate((id) => window.lca.readSession(id), oldSession)
  assert.ok(archive.messages.some((message) => message.text.includes('周五桥'))); safe(archive)
  assert.equal(await page.locator('.card-delivery[data-entering="true"]').count(), 0)
  await tools(); await page.getByLabel('历史会话', { exact: true }).selectOption(oldSession)
  await page.getByRole('region', { name: '历史聊天', exact: true }).waitFor()
  await page.getByRole('region', { name: '历史聊天', exact: true }).scrollIntoViewIfNeeded()
  await mkdir(join(root, 'test-results'), { recursive: true }); await page.screenshot({ path: join(root, 'test-results', 'memory.png') })
  console.log('Memory smoke: seen-only extraction, correction, metadata-only file/mail boundary, explicit memory tool, invalid-summary refusal, local /compact, original archive, idle/lights-safe 04:00 rotation in one process, ordered next-day summary/recall and restart verified; fake models only, real IMAP blocked.')
} finally { await client?.close(); await instance?.close() }
