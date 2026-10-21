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
import { runtimeEnv, initializeTestBook, electronLaunchTarget } from './runtime-env.mjs'
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..'); const data = join(root, '.local-data', 'questions-smoke-' + randomUUID()); const sceneId = randomUUID(); const profile = join(data, 'developer', sceneId)
const env = { ...runtimeEnv(root), LCA_DATA_DIR: data, LCA_PROVIDERS_FILE: join(data, 'absent.json'), LCA_CDP_PORT: '19558', LCA_MCP_PORT: '0' }
let instance; let page; let client
const snapshot = () => page.evaluate(() => window.lca.getSnapshot())
const send = (body) => page.evaluate(async (body) => { const s = await window.lca.getSnapshot(); return window.lca.dispatch({ protocolVersion: 1, epoch: s.epoch, requestId: crypto.randomUUID(), ...body }) }, body)
async function waitFor(test, message) { for (let i = 0; i < 200; i++) { if (test(await snapshot())) return; await new Promise((done) => setTimeout(done, 100)) }; throw new Error(message) }
async function launch() {
  instance = await _electron.launch({ ...electronLaunchTarget(root, electronPath), env }); page = await instance.firstWindow(); await initializeTestBook(page)
  const config = JSON.parse(await readFile(join(profile, 'debug-connection.json'), 'utf8')); client = new Client({ name: 'questions-smoke', version: '1.0.0' })
  await client.connect(new StreamableHTTPClientTransport(new URL(config.url), { requestInit: { headers: { Authorization: 'Bearer ' + config.token } } }))
}
const debug = async (name, args = {}) => { const result = await client.callTool({ name, arguments: args }); assert.ok(!result.isError, 'DEBUG_FAILED'); return JSON.parse(result.content[0].text) }
const call = (name, args) => ({ id: randomUUID(), name, arguments: JSON.stringify(args) })
const step = (tools = [], text = '') => ({ text, toolCalls: tools, delayMs: 0 })
async function script(question) { await debug('set_fake_model', { script: [step([call('ask_user', { question, choices: ['Markdown', 'Text'] }), call('get_clock', {})]), step([], 'SYNTHETIC_ANSWER_RECEIVED')] }) }
async function close() { await client?.close(); client = undefined; await instance?.close(); instance = undefined }
async function records() {
  const rows = []; const journals = join(profile, 'journals')
  for (const owner of await readdir(journals)) for (const file of await readdir(join(journals, owner))) if (file.endsWith('.jsonl')) for (const line of (await readFile(join(journals, owner, file), 'utf8')).trim().split('\n')) rows.push(JSON.parse(line))
  return rows
}
try {
  await mkdir(data, { recursive: true }); await writeFile(join(data, 'settings.json'), JSON.stringify({ version: 1, developer: true, booth: false, plugins: {}, sceneId }))
  await launch(); await debug('set_clock', { frozen: true })
  await script('SYNTHETIC_FORMAT_QUESTION'); await send({ type: 'message.send', text: 'synthetic task needing format' })
  await waitFor((s) => s.question?.status === 'waiting', 'QUESTION_MISSING'); const turn = (await snapshot()).task.id
  await page.getByRole('textbox', { name: '你的回答', exact: true }).fill('Markdown\nHUMAN_INFORMATION_CANARY')
  await page.getByRole('button', { name: '回答', exact: true }).click()
  await waitFor((s) => s.task?.id === turn && s.task.status === 'completed' && !s.question, 'ANSWER_NOT_COMPLETED')
  let rows = await records(); const seen = rows.filter((row) => row.type === 'model/seen' && row.turnId === turn).at(-1)
  const answerIndex = seen.messages.findIndex((m) => m.role === 'user' && m.content === 'Markdown\nHUMAN_INFORMATION_CANARY')
  // On DSH your answer is the result of her question; what memory keeps of the turn has it as your words, no tool traffic.
  assert.ok(answerIndex >= 0 && seen.eligibleIndexes.includes(answerIndex)); assert.ok(seen.messages.every((m) => m.role === 'user' || m.role === 'assistant'))
  const sent = await debug('get_context'); const toolTexts = sent.filter((m) => m.role === 'tool').map((m) => typeof m.content === 'string' ? m.content : JSON.stringify(m.content))
  assert.ok(toolTexts.some((text) => text.includes('HUMAN_INFORMATION_CANARY')), 'ANSWER_NOT_RETURNED')
  assert.ok(!(await snapshot()).question)

  // 点选项就直接回答，不用再点“回答”
  await script('SYNTHETIC_CHIP_QUESTION'); await send({ type: 'message.send', text: 'synthetic one-click choice' })
  await waitFor((s) => s.question?.status === 'waiting', 'CHIP_QUESTION_MISSING'); const chipTurn = (await snapshot()).task.id
  await page.locator('[data-question="waiting"]').getByRole('button', { name: 'Text', exact: true }).click()
  await waitFor((s) => s.task?.id === chipTurn && s.task.status === 'completed' && !s.question, 'CHIP_ANSWER_NOT_COMPLETED')
  rows = await records()
  assert.ok(rows.filter((row) => row.type === 'model/seen' && row.turnId === chipTurn).at(-1).messages.some((m) => m.role === 'user' && m.content === 'Text'))

  await script('SYNTHETIC_LENGTH_QUESTION'); await send({ type: 'message.send', text: 'synthetic answer length check' })
  await waitFor((s) => s.question?.status === 'waiting', 'LENGTH_QUESTION_MISSING')
  const input = page.getByRole('textbox', { name: '你的回答', exact: true }); const answerButton = page.getByRole('button', { name: '回答', exact: true })
  for (const char of ['字', '😀']) {
    await input.fill(char.repeat(1000)); assert.equal(await answerButton.isEnabled(), true); assert.ok((await page.locator('[data-answer-length]').innerText()).includes('1000 / 1000'))
    await input.fill(char.repeat(1001)); assert.equal(await input.inputValue(), char.repeat(1001)); assert.equal(await answerButton.isEnabled(), false)
    assert.ok((await page.locator('[data-answer-length]').innerText()).includes('1001 / 1000')); assert.ok((await page.locator('[data-answer-length]').innerText()).includes('请缩短'))
  }
  await input.fill('😀'.repeat(1000)); await answerButton.click(); await waitFor((s) => !s.question && s.task?.status === 'completed', 'THOUSAND_EMOJI_ANSWER_FAILED')
  assert.ok((await records()).some((row) => row.type === 'user/message' && row.text === '😀'.repeat(1000)))

  const plan = { label: 'question queue test', plannedCount: 1, focusDurationMs: 60_000, shortBreakDurationMs: 20_000, longBreakDurationMs: 20_000, longBreakEvery: 4, timing: 'demo' }
  await send({ type: 'pomodoro.plan', plan }); const planId = (await snapshot()).pomodoro.proposal.id
  await send({ type: 'pomodoro.confirm', planId }); await send({ type: 'pomodoro.start', planId })
  await waitFor((s) => s.windows?.mode === 'mini', 'MINI_MISSING'); await script('FOCUS_QUESTION_CANARY'); await send({ type: 'message.send', text: 'synthetic focus clarification' })
  await waitFor((s) => s.question?.status === 'queued', 'QUESTION_NOT_QUEUED')
  let s = await snapshot(); assert.ok(!JSON.stringify(s).includes('FOCUS_QUESTION_CANARY')); assert.equal(s.pomodoro.phase, 'focus')
  await debug('set_clock', { nowMs: s.clock.nowMs + 60_001 }); await waitFor((s) => s.question?.status === 'waiting' && s.pomodoro.phase === 'short-break', 'REST_QUESTION_NOT_RELEASED')
  const mini = instance.windows().find((w) => w.url().includes('view=mini')); assert.ok(mini)
  const denied = await mini.evaluate(async () => { const s = await window.lca.getSnapshot(); return window.lca.dispatch({ protocolVersion: 1, epoch: s.epoch, requestId: crypto.randomUUID(), type: 'question.answer', questionId: s.question.id, answer: 'mini cannot answer' }) }); assert.equal(denied.error.code, 'permission-denied')
  await send({ type: 'window.expand' }); await page.locator('[data-question="waiting"]').waitFor()
  await page.getByRole('button', { name: '这次先跳过', exact: true }).click(); await waitFor((s) => s.task?.status === 'completed' && !s.question, 'DISMISS_NOT_COMPLETED')
  await send({ type: 'pomodoro.stop' }); await send({ type: 'mode.set', mode: 'rest' })


  await script('STOP_QUESTION_CANARY'); await send({ type: 'message.send', text: 'stop pending question' }); await waitFor((s) => s.question?.status === 'waiting', 'STOP_QUESTION_MISSING')
  const stopped = await snapshot(); await send({ type: 'turn.stop', taskId: stopped.task.id }); await waitFor((s) => s.task?.status === 'aborted' && !s.question, 'STOP_NOT_ABORTED')
  assert.equal((await send({ type: 'question.answer', questionId: stopped.question.id, answer: 'stale' })).status, 'rejected')
  await script('RESTART_QUESTION_CANARY'); await send({ type: 'message.send', text: 'restart pending question' }); await waitFor((s) => s.question?.status === 'waiting', 'RESTART_QUESTION_MISSING')
  const attempts = (await records()).filter((r) => r.type === 'model/attempt' && r.status === 'started').length
  await close(); await launch(); s = await snapshot(); assert.ok(!s.question); assert.equal(s.task.status, 'aborted'); assert.equal(s.windows.mode, 'book')
  assert.ok(s.messages.some((m) => m.text === 'Markdown\nHUMAN_INFORMATION_CANARY'))
  assert.equal((await records()).filter((r) => r.type === 'model/attempt' && r.status === 'started').length, attempts)
  const archive = join(data, 'questions.lca-save'); await instance.evaluate(({ dialog }, file) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: file }) }, archive)
  await send({ type: 'backup.export' }); await waitFor((s) => s.backup.status === 'exported', 'QUESTION_EXPORT_FAILED')
  await instance.evaluate(({ dialog, app }, file) => { app.relaunch = () => {}; dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }) }, archive)
  await send({ type: 'backup.import' }); await waitFor((s) => s.backup.status === 'awaiting-confirmation', 'QUESTION_IMPORT_FAILED')
  const restoreId = (await snapshot()).backup.restoreId; await client.close(); client = undefined; const closed = instance.waitForEvent('close'); await send({ type: 'backup.restore', restoreId }); await closed; instance = undefined; await launch()
  s = await snapshot(); assert.ok(!s.question); assert.ok(s.messages.some((m) => m.text === 'Markdown\nHUMAN_INFORMATION_CANARY')); assert.equal((await records()).filter((r) => r.type === 'model/attempt' && r.status === 'started').length, attempts)
  await close(); await normalHttp()
  console.log(JSON.stringify({ ok: true, probe: 'questions', source: 'synthetic', nativeSQLite: true, uiAnswer: true, wholeToolBatchOrdering: true, actualHttpSerialization: true, focusToRest: true, bookOnly: true, workIsolation: true, stop: true, restartNoReplay: true, privateRestore: true }))
} finally { await close() }

// A normal (non-developer) book runs her turns on DSH: LCA's tools carry an lca_ prefix there, and your answer comes back
// as the result of her question.
async function normalHttp() {
  const requests = []; const normalData = join(data, 'normal-http'); await mkdir(normalData, { recursive: true })
  const textOf = (content) => typeof content === 'string' ? content : (content ?? []).map((part) => part?.text ?? '').join('')
  const frame = (delta, finish_reason) => `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason }] })}\n\n`
  const server = createServer(async (req, res) => {
    let input = ''; for await (const chunk of req) input += chunk
    const body = JSON.parse(input); requests.push(body); res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    const toolName = (name) => body.tools?.some((tool) => (tool.function?.name ?? tool.name) === 'lca_' + name) ? 'lca_' + name : name
    const delta = requests.length === 1 ? { tool_calls: [
      { index: 0, id: 'http-ask', type: 'function', function: { name: toolName('ask_user'), arguments: '{"question":"HTTP_QUESTION"}' } },
      { index: 1, id: 'http-clock', type: 'function', function: { name: toolName('get_clock'), arguments: '{}' } },
    ] } : { content: 'HTTP_FINAL' }
    res.end(frame(delta, requests.length === 1 ? 'tool_calls' : 'stop') + 'data: [DONE]\n\n')
  })
  await new Promise((done) => server.listen(0, '127.0.0.1', done)); const fixture = join(normalData, 'providers.json')
  await writeFile(fixture, JSON.stringify({ providers: { chat: { base_url: `http://127.0.0.1:${server.address().port}/v1`, api_key: 'synthetic-question-private-key', model: 'synthetic-question-model' } } }))
  try {
    instance = await _electron.launch({ ...electronLaunchTarget(root, electronPath), env: { ...runtimeEnv(root), LCA_DATA_DIR: normalData, LCA_PROVIDERS_FILE: fixture } }); page = await instance.firstWindow(); await initializeTestBook(page)
    await send({ type: 'message.send', text: 'normal synthetic question' }); await waitFor((s) => s.question?.status === 'waiting', 'HTTP_QUESTION_MISSING')
    await send({ type: 'question.answer', questionId: (await snapshot()).question.id, answer: 'HTTP_USER_ANSWER' }); await waitFor((s) => s.task?.status === 'completed', 'HTTP_ANSWER_FAILED')
    assert.equal(requests.length, 2); const messages = requests[1].messages; const batch = messages.findIndex((m) => m.role === 'assistant' && m.tool_calls?.length === 2)
    assert.ok(batch >= 0); assert.deepEqual(messages.slice(batch, batch + 3).map((m) => m.role), ['assistant', 'tool', 'tool']); assert.deepEqual(messages.slice(batch + 1, batch + 3).map((m) => m.tool_call_id), ['http-ask', 'http-clock'])
    assert.ok(textOf(messages[batch + 1].content).includes('HTTP_USER_ANSWER'), 'HTTP_ANSWER_NOT_RETURNED')
    const s = await snapshot(); assert.ok(!JSON.stringify(s).includes('synthetic-question-private-key')); assert.ok(s.messages.some((m) => m.text === 'HTTP_FINAL'))
  } finally { await close(); server.closeAllConnections(); await new Promise((done) => server.close(done)) }
}
