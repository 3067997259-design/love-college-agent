import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, writeFile, readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron } from 'playwright'
import electronPath from 'electron'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { runtimeEnv, initializeTestBook } from './runtime-env.mjs'
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..'); const data = join(root, '.local-data', 'flow-smoke-' + randomUUID()); const sceneId = randomUUID()
const env = { ...runtimeEnv(root), LCA_DATA_DIR: data, LCA_PROVIDERS_FILE: join(data, 'absent.json'), LCA_CDP_PORT: '19539', LCA_MCP_PORT: '0' }
let instance; let page; let client
async function launch() { instance = await _electron.launch({ executablePath: electronPath, args: [root], env }); page = await instance.firstWindow(); await initializeTestBook(page) }
const snapshot = () => page.evaluate(() => window.lca.getSnapshot())
const send = (body) => page.evaluate(async (body) => { const s = await window.lca.getSnapshot(); return window.lca.dispatch({ protocolVersion: 1, epoch: s.epoch, requestId: crypto.randomUUID(), ...body }) }, body)
async function waitFor(test, message) { for (let i = 0; i < 100; i++) { if (test(await snapshot())) return; await new Promise((done) => setTimeout(done, 100)) }; throw new Error(message) }
try {
  await mkdir(data, { recursive: true }); await writeFile(join(data, 'settings.json'), JSON.stringify({ version: 1, developer: true, booth: false, plugins: {}, sceneId }))
  await launch(); await page.getByRole('button', { name: '工具与设置', exact: true }).click()
  await page.getByLabel('工作长期目标', { exact: true }).fill('完成合成书桌项目'); await page.getByRole('button', { name: '新建工作目标', exact: true }).click()
  const goalId = (await snapshot()).heartFlow.goalId; assert.ok(goalId)
  await page.getByRole('button', { name: '进入心流', exact: true }).click(); await waitFor((s) => s.heartFlow.activeId, 'FLOW_ENTER_FAILED')
  await page.getByRole('button', { name: '批准计划并允许书桌写入' }).click()
  const connection = JSON.parse(await readFile(join(data, 'developer', sceneId, 'debug-connection.json'), 'utf8')); client = new Client({ name: 'flow-smoke', version: '1.0.0' }); await client.connect(new StreamableHTTPClientTransport(new URL(connection.url), { requestInit: { headers: { Authorization: 'Bearer ' + connection.token } } }))
  await client.callTool({ name: 'set_fake_model', arguments: { script: [{ text: '', toolCalls: [{ id: 'write-code', name: 'desk_write', arguments: JSON.stringify({ path: 'answer.js', text: 'return 42' }) }], delayMs: 0 }, { text: 'SYNTHETIC_WORK_DONE', toolCalls: [], delayMs: 0 }] } })
  assert.equal((await send({ type: 'message.send', text: '合成心流：在书桌写 answer.js。' })).status, 'accepted'); await waitFor((s) => s.heartFlow.files.some((file) => file.path === 'answer.js'), 'DESK_WRITE_FAILED'); await waitFor((s) => s.task?.status === 'completed', 'FLOW_TURN_NOT_DONE')
  const flowId = (await snapshot()).heartFlow.activeId; const taskId = (await snapshot()).task.id
  assert.deepEqual((await snapshot()).heartFlow.goals[0].flowIds, [flowId])
  const diff = await page.evaluate(() => window.lca.readHeartFlow({ section: 'diff' })); assert.ok(diff.changes.some((change) => change.path === 'answer.js' && change.after === 'return 42' && change.current))
  for (const command of ['/status', '/permissions', '/diff']) {
    const created = instance.waitForEvent('window'); assert.equal((await send({ type: 'message.send', text: command })).status, 'accepted'); const inspection = await created; await inspection.waitForLoadState()
    const view = JSON.parse(await inspection.locator('pre').innerText()); assert.equal(view.scope, 'desk-only'); assert.equal(view.approval, 'each-run'); assert.equal(view.cost, null); assert.equal(await inspection.evaluate(() => typeof window.lca), 'undefined'); await inspection.close()
  }
  assert.equal((await snapshot()).task.id, taskId)
  const miniCreated = instance.waitForEvent('window'); await send({ type: 'window.mini' }); const mini = await miniCreated; await mini.waitForFunction(() => !!window.lca)
  assert.equal(await mini.evaluate(async () => { try { await window.lca.readHeartFlow({ section: 'diff' }); return false } catch { return true } }), true); await send({ type: 'window.expand' })
  await page.getByRole('button', { name: '申请执行', exact: true }).click(); assert.ok((await snapshot()).heartFlow.pending); assert.equal((await snapshot()).heartFlow.lastRun, undefined)
  await page.getByRole('button', { name: '仅批准这一次', exact: true }).click(); await waitFor((s) => s.heartFlow.lastRun?.output === '42', 'FLOW_RUN_FAILED')
  await page.getByRole('button', { name: '撤回此版本', exact: true }).click(); await waitFor((s) => !s.heartFlow.files.some((file) => file.path === 'answer.js'), 'FLOW_UNDO_FAILED')
  await page.getByRole('button', { name: '申请执行', exact: true }).click(); await client.close(); client = undefined; await instance.close(); await launch(); assert.equal((await snapshot()).heartFlow.pending, undefined); assert.equal((await snapshot()).heartFlow.goalId, goalId)
  await send({ type: 'flow.exit' }); await waitFor((s) => !s.heartFlow.activeId, 'FLOW_EXIT_FAILED')
  const history = await page.evaluate((id) => window.lca.readHeartFlow({ section: 'diff', flowId: id }), flowId); assert.ok(history.changes[0].undone)
  assert.equal((await send({ type: 'flow.resume', flowId })).status, 'accepted'); await waitFor((s) => s.heartFlow.activeId && s.heartFlow.activeId !== flowId, 'FLOW_RESUME_FAILED'); assert.equal((await snapshot()).heartFlow.mode, 'plan'); assert.equal((await snapshot()).heartFlow.pending, undefined)
  assert.equal((await snapshot()).heartFlow.goals[0].flowIds.length, 2)
  assert.equal((await send({ type: 'message.send', text: '/compact 保留旧文件版本与待确认的计划' })).status, 'accepted')
  await send({ type: 'flow.exit' }); await waitFor((s) => !s.heartFlow.activeId, 'RESUMED_FLOW_EXIT_FAILED')
  await page.getByRole('button', { name: '工具与设置', exact: true }).click(); await page.locator(`[data-goal-id="${goalId}"]`).getByRole('button', { name: '标记目标完成', exact: true }).click()
  assert.equal((await snapshot()).heartFlow.goals[0].confirmedBy, 'user'); assert.equal((await snapshot()).heartFlow.goals[0].status, 'completed')
  await instance.close(); await launch(); assert.equal((await snapshot()).heartFlow.goals[0].status, 'completed')
  console.log('Heart-flow Electron: model-tool desk write, per-run approval, sandbox return/undo, restart drops pending, native slash inspections with real scope/unknown cost, book-only diff read, historical lookup and fresh plan-only resume/compact verified; fake chat model.')
} finally { await client?.close(); await instance?.close() }
