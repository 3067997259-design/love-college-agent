import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron } from 'playwright'
import electronPath from 'electron'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { runtimeEnv, testDataRoot, electronLaunchTarget, initializeTestBook, openSettings } from './runtime-env.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const data = join(testDataRoot(root), 'memory-smoke-' + randomUUID()); const sceneId = randomUUID()
const profile = join(data, 'developer', sceneId)
let vectorCalls = 0
const vectors = createServer((request, response) => {
  let body = ''; request.on('data', chunk => { body += chunk }); request.on('end', () => {
    const input = JSON.parse(body)
    if (request.url !== '/v1/embeddings' || input.model !== 'fixture-vector') { response.writeHead(400); response.end(); return }
    vectorCalls++; response.setHeader('Content-Type', 'application/json')
    response.end(JSON.stringify({ object: 'list', model: input.model, data: [{ object: 'embedding', index: 0, embedding: Array.from({ length: 768 }, (_, i) => i === 0 ? 1 : 0) }], usage: { prompt_tokens: 8, total_tokens: 8 } }))
  })
})
await new Promise(done => vectors.listen(0, '127.0.0.1', done))
const env = { ...runtimeEnv(root), LCA_DATA_DIR: data, LCA_PROVIDERS_FILE: join(data, 'absent-test-providers.json'), LCA_MCP_PORT: '0', LCA_CDP_PORT: '0' }
let instance; let page; let client
async function launch() { instance = await _electron.launch({ ...electronLaunchTarget(root, electronPath), env, timeout: 30_000 }); page = await instance.firstWindow(); await initializeTestBook(page); await page.locator('[data-mode][data-pose]').waitFor() }
const snapshot = () => page.evaluate(() => window.lca.getSnapshot())
async function waitFor(predicate, error) { for (let i = 0; i < 150; i++) { if (await predicate(await snapshot())) return; await new Promise((done) => setTimeout(done, 100)) } throw new Error(error) }
const send = (body) => page.evaluate(async (body) => { const s = await window.lca.getSnapshot(); return window.lca.dispatch({ ...body, epoch: s.epoch, protocolVersion: 1, requestId: crypto.randomUUID() }) }, body)
const tools = () => openSettings(page)
const closeTools = () => page.getByRole('button', { name: '关闭', exact: true }).click()
const safe = (value) => { const text = JSON.stringify(value); for (const marker of ['RAW_ONLY_', 'USER_ONLY_DOCUMENT_RESULT', 'sk-synthetic']) assert.ok(!text.includes(marker), 'PRIVATE_MEMORY_LEAK') }
const mcp = async (name, args = {}) => { const result = await client.callTool({ name, arguments: args }); assert.ok(!result.isError, 'MCP_OPERATION_FAILED'); return JSON.parse(result.content[0].text) }
const setReply = (text = 'SYNTHETIC_MEMORY_REPLY', delayMs = 0) => mcp('set_fake_model', { script: [{ text, toolCalls: [], delayMs }] })
const setClock = (iso) => mcp('set_clock', { nowMs: Date.parse(iso), frozen: true })
// Her turns run on DSH: a model call reaches the scripted model a moment after her turn starts. get_context is that call.
const textOf = (content) => typeof content === 'string' ? content : (content ?? []).map((part) => part?.text ?? '').join('\n')
async function modelCalled(marker, error) { for (let i = 0; i < 150; i++) { if (JSON.stringify(await mcp('get_context')).includes(marker)) return; await new Promise((done) => setTimeout(done, 100)) } throw new Error(error) }
async function chat(text) {
  const before = await snapshot(), count = before.messages.length
  assert.equal((await send({ type: 'message.send', text })).status, 'accepted')
  let approved = false
  await waitFor(async (s) => {
    if (text === '核对饮料和资料处理状态' && s.question?.status === 'queued') await send({ type: 'mode.set', mode: 'rest' })
    if (text === '核对饮料和资料处理状态' && !approved && s.question?.status === 'waiting' && s.question.kind === 'approval') {
      assert.ok(s.question.question.includes('读过附件原文')); assert.ok(s.question.choices.includes('允许这一次'))
      approved = true
      assert.equal((await send({ type: 'question.answer', questionId: s.question.id, answer: '允许这一次' })).status, 'accepted')
      await send({ type: 'mode.set', mode: 'quiet' })
    }
    return s.task?.id !== before.task?.id && s.task?.status === 'completed' && s.messages.length >= count + 2
  }, 'SYNTHETIC_CHAT_FAILED')
  if (text === '核对饮料和资料处理状态') assert.ok(approved, 'MEMORY_SOURCE_APPROVAL_MISSING')
}
async function memoryAction(type) {
  assert.equal((await send({ type })).status, 'accepted')
  await waitFor((s) => !['extracting', 'compacting'].includes(s.memory.status), 'MEMORY_OPERATION_NOT_SETTLED')
}
try {
  await mkdir(data, { recursive: true }); await launch()
  assert.equal((await snapshot()).memory.status, 'unconfigured')
  assert.equal((await send({ type: 'message.send', text: '/compact' })).status, 'accepted')
  await waitFor(s => s.memory.compaction?.outcome === 'no_range', 'EMPTY_ROOT_COMPACT_NOT_REPORTED')
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
  await waitFor((s) => s.memory.facts?.length === 3 && s.memory.status === 'idle', 'VISIBLE_EXPERIENCE_NOT_EXTRACTED')
  const facts = page.getByRole('region', { name: '事实记忆', exact: true })
  const pendingTea = facts.locator('.memory-item').filter({ hasText: '我喜欢的饮料现在改为红茶' })
  await pendingTea.getByRole('button', { name: '拒绝这条建议', exact: true }).click()
  await waitFor(s => s.memory.facts.some(fact => fact.content.includes('改为红茶') && fact.reviewStatus === 'rejected'), 'REJECT_PENDING_FACT_FAILED')
  for (const text of ['周五桥', '我喜欢的饮料是咖啡。']) {
    await facts.locator('.memory-item').filter({ hasText: text }).getByRole('button', { name: '确认这条建议', exact: true }).click()
    await waitFor(s => s.memory.facts.some(fact => fact.content.includes(text) && fact.reviewStatus === 'approved'), 'FACT_REVIEW_FAILED')
  }
  await facts.locator('.memory-item').filter({ hasText: '我喜欢的饮料是咖啡。' }).getByRole('button', { name: '纠正', exact: true }).click()
  await facts.getByRole('button', { name: '提出更正', exact: true }).waitFor()
  await facts.getByRole('textbox').fill('我喜欢的饮料现在改为红茶，不再喝咖啡。')
  await page.getByRole('button', { name: '提出更正', exact: true }).click()
  await facts.getByRole('button', { name: '确认保存', exact: true }).click()
  await waitFor(s => s.memory.facts.some(fact => fact.factStatus === 'superseded') && s.memory.facts.some(fact => fact.content.includes('改为红茶') && fact.reviewStatus === 'approved' && fact.factStatus === 'active'), 'REVIEWED_CORRECTION_FAILED')
  assert.equal(await page.locator('.memory-item[data-superseded="true"]').count(), 1)
  await page.getByLabel('向量服务地址', { exact: true }).fill(`http://127.0.0.1:${vectors.address().port}/v1`)
  await page.getByLabel('向量模型', { exact: true }).fill('fixture-vector')
  await page.getByLabel('向量密钥', { exact: true }).fill('sk-synthetic-embedding')
  await page.getByRole('button', { name: '保存并迁移向量', exact: true }).click()
  await waitFor(s => s.memorySettings.status === 'idle' && s.memory.engine.embedding.state === 'ready', 'UI_VECTOR_MIGRATION_FAILED')
  assert.ok(vectorCalls > 0); assert.equal(await page.getByLabel('向量密钥', { exact: true }).inputValue(), '')
  await closeTools()
  await send({ type: 'mail.scan' }) // 书页上没有扫描按钮：平时是她用邮件工具去看
  await waitFor((s) => s.mailbox.status === 'ready', 'SYNTHETIC_MAIL_NOT_READY')
  await send({ type: 'privacy.set', enabled: true }); await send({ type: 'developer.document.import', fixtureId: 'notes-text' })
  await waitFor((s) => s.documents.jobs.at(-1)?.status === 'ready', 'SYNTHETIC_DOCUMENT_NOT_READY')
  await mcp('set_fake_model', { script: [
    { text: '', toolCalls: [{ id: 'files', name: 'get_processed_files', arguments: '{}' }, { id: 'memory', name: 'search_memory', arguments: '{"query":"饮料"}' }], delayMs: 0 },
    { text: 'SYNTHETIC_METADATA_RECALL_COMPLETE', toolCalls: [], delayMs: 0 },
  ] })
  await chat('核对饮料和资料处理状态')
  const recalled = await mcp('get_context'); safe(recalled)
  const result = recalled.map((message) => message.role === 'tool' ? textOf(message.content) : '').find((text) => text.includes('我喜欢的饮料现在改为红茶'))
  assert.ok(result, 'MEMORY_TOOL_NOT_RUN'); assert.ok(!result.includes('我喜欢的饮料是咖啡。'), 'SUPERSEDED_MEMORY_RECALLED')
  // Exercise a partial day without exhausting the unchanged 240 KB daily maintenance budget.
  for (let i = 0; i < 4; i++) { await setReply(); await chat('合成旧回合 ' + i + ' 这是可见对话压缩验收。'.repeat(250)) }
  const before = await snapshot(); const originalCount = before.messages.length
  const beforeRequest = JSON.stringify(await mcp('get_context')).length
  await tools(); await page.getByLabel('记忆模型场景').selectOption('invalid')
  await closeTools(); await setReply('Earlier conversation is summarized. Read current memory revisions for the drink preference.')
  // DSH owns compaction; an invalid background-memory fixture cannot replace
  // that history compressor. The original book remains append-only.
  assert.equal((await send({ type: 'message.send', text: '/compact' })).status, 'accepted')
  await waitFor((s) => s.memory.compaction?.outcome === 'compacted' && s.memory.status === 'idle', 'LOCAL_COMPACT_FAILED')
  assert.equal((await snapshot()).messages.length, originalCount)
  await tools(); await page.getByLabel('记忆模型场景').selectOption('ready'); await closeTools()
  await setReply('Current reviewed preference remains red tea.'); await chat('压缩以后，确认当前饮料偏好。')
  assert.ok(JSON.stringify(await mcp('get_context')).length < beforeRequest, 'NATIVE_MODEL_CONTEXT_NOT_SHORTER')
  await tools(); const oldSession = (await snapshot()).scope.sessionId
  await page.getByLabel('历史会话', { exact: true }).selectOption(oldSession)
  await page.getByRole('region', { name: '历史聊天', exact: true }).getByText('我把纸桥放在书桌上，给它取名叫周五桥。', { exact: true }).waitFor()
  await page.getByRole('button', { name: '收起旧页', exact: true }).click(); await closeTools()
  await setClock('2026-10-17T03:59:50+08:00')
  await waitFor((s) => !['extracting', 'compacting'].includes(s.memory.status), 'BACKGROUND_NOT_IDLE')
  await setReply('SYNTHETIC_HELD_REPLY', 60_000)
  assert.equal((await send({ type: 'message.send', text: 'SYNTHETIC_HOLD_TURN' })).status, 'accepted')
  await waitFor((s) => s.task?.status === 'running', 'HELD_TURN_NOT_STARTED'); await modelCalled('SYNTHETIC_HOLD_TURN', 'HELD_TURN_NOT_SENT')
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
  // Long days may need another bounded coverage pass. A partial day must not
  // be reported complete merely because the first summary exists.
  if (!next.session.pages.some(item => item.sessionId === oldSession && item.summarized)) {
    const coverage = async () => {
      let count = 0
      for (const owner of await readdir(join(profile, 'journals'))) for (const name of await readdir(join(profile, 'journals', owner))) if (name.endsWith('.jsonl')) {
        const rows = (await readFile(join(profile, 'journals', owner, name), 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse)
        for (const row of rows) if (row.type === 'memory/summary' && row.summary.level === 'day' && row.summary.sourceSessionIds.includes(oldSession)) count = Math.max(count, row.summary.coverage?.count ?? 0)
      }
      return count
    }
    for (let i = 0; i < 8 && !(await snapshot()).session.pages.some(item => item.sessionId === oldSession && item.summarized); i++) {
      await waitFor(s => s.memory.status === 'idle', 'DAY_MAINTENANCE_NOT_IDLE')
      const beforeCoverage = await coverage()
      await mcp('set_clock', { nowMs: (await snapshot()).clock.nowMs + 31_000, frozen: true })
      await waitFor(async s => s.session.pages.some(item => item.sessionId === oldSession && item.summarized) || await coverage() > beforeCoverage, 'DAY_COVERAGE_DID_NOT_ADVANCE')
      await waitFor(s => s.memory.status === 'idle', 'DAY_MAINTENANCE_NOT_FINISHED')
    }
    assert.ok((await snapshot()).session.pages.some(item => item.sessionId === oldSession && item.summarized), 'DAY_COVERAGE_NOT_COMPLETED')
  }
  await setReply(); await chat('纸桥')
  const prepared = await mcp('get_context'); safe(prepared)
  // The new day's first message brings the earlier day's summary and matching memories beside your words, before them.
  const opening = prepared.map((message) => message.role === 'user' ? textOf(message.content) : '').findLast((text) => text.includes('previousDaysReference')) ?? ''
  assert.ok(opening.includes('previousDaysReference') && (opening.includes('memoryReference') || opening.includes('memoryDirectory')) && opening.endsWith('\n\n纸桥'), 'NEXT_DAY_CONTEXT_ORDER_FAILED')
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
  const restored = await snapshot(); assert.deepEqual(restored.memory.items, persisted.memory.items); assert.deepEqual(restored.memory.facts, persisted.memory.facts); assert.equal(restored.session.pages.length, 2)
  const archive = await page.evaluate((id) => window.lca.readSession(id), oldSession)
  assert.ok(archive.messages.some((message) => message.text.includes('周五桥'))); safe(archive)
  assert.equal(await page.locator('.card-delivery[data-entering="true"]').count(), 0)
  await tools(); await page.getByLabel('历史会话', { exact: true }).selectOption(oldSession)
  await page.getByRole('region', { name: '历史聊天', exact: true }).waitFor()
  await page.getByRole('region', { name: '历史聊天', exact: true }).scrollIntoViewIfNeeded()
  await mkdir(join(root, 'test-results'), { recursive: true }); await page.screenshot({ path: join(root, 'test-results', 'memory.png') })
  console.log('Memory smoke: native seen-only suggestions, explicit review/correction, metadata-only file/mail boundary, actual DSH /compact independent of the background summarizer, shorter model request with complete original archive, idle/lights-safe day rotation, next-day references and native fact restart verified; fake models only.')
} catch (error) {
  await mkdir(join(root, 'test-results/continuity'), { recursive: true })
  const diagnostic = { error: String(error), data, snapshot: await snapshot().catch(() => null), facts: await page?.getByRole('region', { name: '事实记忆', exact: true }).innerText().catch(() => null) }
  await writeFile(join(root, 'test-results/continuity', `memory-failure-${sceneId}.json`), JSON.stringify(diagnostic, null, 2))
  throw error
} finally { await client?.close(); await instance?.close(); vectors.closeAllConnections(); await new Promise(done => vectors.close(done)) }
