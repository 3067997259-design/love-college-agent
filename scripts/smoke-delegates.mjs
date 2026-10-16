import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, writeFile, readFile, readdir } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron } from 'playwright'
import electronPath from 'electron'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { runtimeEnv, initializeTestBook, electronLaunchTarget } from './runtime-env.mjs'
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..'); const data = join(root, '.local-data', 'delegates-' + randomUUID()); const sceneId = randomUUID()
const env = { ...runtimeEnv(root), LCA_DATA_DIR: data, LCA_PROVIDERS_FILE: join(data, 'absent.json'), LCA_CDP_PORT: '19561', LCA_MCP_PORT: '0' }
let instance; let page; let client
const snapshot = () => page.evaluate(() => window.lca.getSnapshot())
const send = (body) => page.evaluate(async (body) => { const s = await window.lca.getSnapshot(); return window.lca.dispatch({ protocolVersion: 1, epoch: s.epoch, requestId: crypto.randomUUID(), ...body }) }, body)
async function waitFor(test, message) { for (let i = 0; i < 100; i++) { if (test(await snapshot())) return; await new Promise((done) => setTimeout(done, 100)) }; throw new Error(message) }
async function debug(name, args = {}) { const result = await client.callTool({ name, arguments: args }); assert.ok(!result.isError); return JSON.parse(result.content[0].text) }
async function scripted(calls) { await debug('set_fake_model', { script: [{ text: '', toolCalls: calls.map((call) => ({ id: randomUUID(), name: call.name, arguments: JSON.stringify(call.args) })), delayMs: 0 }, { text: 'SYNTHETIC_PARENT_REPORT', toolCalls: [], delayMs: 0 }] }) }
async function message(text) { assert.equal((await send({ type: 'message.send', text })).status, 'accepted'); await waitFor((s) => s.task?.status === 'completed', 'PARENT_TURN_FAILED') }
try {
  await mkdir(data, { recursive: true }); await writeFile(join(data, 'settings.json'), JSON.stringify({ version: 1, developer: true, booth: false, plugins: {}, sceneId }))
  instance = await _electron.launch({ ...electronLaunchTarget(root, electronPath), env }); page = await instance.firstWindow(); await initializeTestBook(page)
  const config = JSON.parse(await readFile(join(data, 'developer', sceneId, 'debug-connection.json'), 'utf8')); client = new Client({ name: 'delegates-smoke', version: '1.0.0' }); await client.connect(new StreamableHTTPClientTransport(new URL(config.url), { requestInit: { headers: { Authorization: 'Bearer ' + config.token } } }))
  await send({ type: 'flow.enter' }); await waitFor((s) => !!s.heartFlow.activeId, 'FLOW_ENTER_FAILED'); await send({ type: 'flow.mode', mode: 'execute' })
  const canary = 'SYNTHETIC_PRIVATE_SUBTASK_SOURCE'
  await scripted([{ name: 'desk_write', args: { path: '只读材料.md', text: canary } }]); await message('准备这次心流的合成阅读文件。')
  await send({ type: 'flow.mode', mode: 'plan' })
  await scripted([1, 2, 3].map((n) => ({ name: 'delegate_readonly', args: { task: '独立核对合成材料 ' + n, paths: ['只读材料.md'] } }))); await message('把三份只读核对任务交给分身。')
  await waitFor((s) => s.heartFlow.delegates?.filter((job) => job.status === 'completed').length === 3, 'DELEGATES_NOT_COMPLETED')
  const jobs = (await snapshot()).heartFlow.delegates; assert.ok(!JSON.stringify(jobs).includes(canary))
  await scripted(jobs.map((job) => ({ name: 'delegate_result', args: { delegateId: job.id, wait: true } }))); await message('收回三个结果，由本体核对。')
  assert.ok(JSON.stringify(await debug('get_context')).includes(canary)); assert.ok(JSON.stringify(await debug('get_context')).includes('unreviewed'))
  const rooms = join(data, 'developer', sceneId, 'rooms'); const desk = join(rooms, (await readdir(rooms))[0], '书桌'); assert.equal(await readFile(join(desk, '只读材料.md'), 'utf8'), canary)
  assert.equal((await snapshot()).heartFlow.mode, 'plan'); assert.equal((await snapshot()).heartFlow.changes.length, 1)
  await send({ type: 'flow.exit' }); await waitFor((s) => !s.heartFlow.activeId, 'FLOW_EXIT_FAILED')
  const summary = (await snapshot()).heartFlow.sessions.at(-1).summary; assert.equal(JSON.parse(summary).delegateCount, 3); assert.ok(!summary.includes(canary))
  await debug('set_fake_model', { script: [{ text: 'SYNTHETIC_NORMAL_REPLY', toolCalls: [], delayMs: 0 }] }); await message('继续普通对话，只核对任务记录。')
  assert.ok(!JSON.stringify(await debug('get_context')).includes(canary))
  const folders = join(data, 'developer', sceneId, 'journals'); const journalOwner = join(folders, (await readdir(folders))[0]); const records = (await Promise.all((await readdir(journalOwner)).filter((name) => name.endsWith('.jsonl')).map((name) => readFile(join(journalOwner, name), 'utf8')))).join('\n').split(/\r?\n/).filter(Boolean).map(JSON.parse)
  const seen = records.filter((row) => row.type === 'model/seen')
  for (const row of seen) for (const index of row.eligibleIndexes) assert.ok(!row.messages[index].content.includes(canary))
  assert.equal(records.filter((row) => row.type === 'delegate/result').length, 3)
  console.log('Delegates Electron PASS: three independent read-only desk subtasks, model tools and referenced unreviewed results delivered to parent, metadata-only UI, unchanged source file, exit evidence index and no private child/source prose in normal context or eligible memories; fake parent/child models.')
} finally { await client?.close(); await instance?.close() }
