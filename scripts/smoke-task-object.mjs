import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron } from 'playwright'
import electronPath from 'electron'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { runtimeEnv, initializeTestBook, electronLaunchTarget } from './runtime-env.mjs'

/**
 * D1-C scenario: task object from chat proposal to approval, advancement under the existing
 * heart-flow execute wall, then a user close, restart persistence and journal counts.
 * Uses the scripted developer model only; no network or real provider. Evidence contains counts,
 * booleans and statuses, never assistant text or user data.
 */
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const data = join(root, '.local-data', 'task-object-' + randomUUID())
const sceneId = randomUUID()
const reportPath = process.env.LCA_TASK_OBJECT_REPORT ?? join(root, 'test-results', 'd1-task-object', 'scenario.json')
const env = { ...runtimeEnv(root), LCA_DATA_DIR: data, LCA_PROVIDERS_FILE: join(data, 'absent.json'), LCA_MCP_PORT: '0', LCA_CDP_PORT: '0', LCA_TEST_SILENT: '1' }
const sleep = (ms) => new Promise((done) => setTimeout(done, ms))
let instance
let page
let client
const report = { ok: false, probe: 'd1-task-object', syntheticModel: true, scenario: 'D1-S0: chat proposal -> user approves plan -> heart-flow desk_write + task_step -> user closes task -> restart' }
const snapshot = () => page.evaluate(() => window.lca.getSnapshot())
const dispatch = async (body) => page.evaluate(async (body) => {
  const state = await window.lca.getSnapshot()
  return window.lca.dispatch({ protocolVersion: 1, epoch: state.epoch, requestId: crypto.randomUUID(), ...body })
}, body)
async function waitFor(test, message, attempts = 200) {
  for (let index = 0; index < attempts; index++) {
    if (await test(await snapshot())) return
    await sleep(100)
  }
  throw new Error(message)
}
async function launch() {
  instance = await _electron.launch({ ...electronLaunchTarget(root, electronPath), env, timeout: 30_000 })
  page = await instance.firstWindow()
  await initializeTestBook(page)
  await page.locator('[data-mode][data-pose]').waitFor()
}
async function debugConnection() {
  const path = join(data, 'developer', sceneId, 'debug-connection.json')
  for (let index = 0; index < 100; index++) { try { return JSON.parse(await readFile(path, 'utf8')) } catch { await sleep(100) } }
  throw new Error('DEBUG_CONNECTION_MISSING')
}
async function setScript(script) { await client.callTool({ name: 'set_fake_model', arguments: { script } }) }
async function journalRows() {
  const found = []
  const walk = async (folder) => {
    const entries = await readdir(folder, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      const path = join(folder, entry.name)
      if (entry.isDirectory()) await walk(path)
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) found.push(path)
    }
  }
  await walk(data)
  const rows = []
  for (const file of found) for (const line of (await readFile(file, 'utf8')).split(/\r?\n/)) if (line.trim()) { try { rows.push(JSON.parse(line)) } catch { /* torn tail is not evidence */ } }
  return rows
}
try {
  await mkdir(data, { recursive: true })
  await writeFile(join(data, 'settings.json'), JSON.stringify({ version: 1, developer: true, booth: false, plugins: {}, sceneId }))
  await launch()
  const connection = await debugConnection()
  client = new Client({ name: 'task-object-scenario', version: '1.0.0' })
  await client.connect(new StreamableHTTPClientTransport(new URL(connection.url), { requestInit: { headers: { Authorization: 'Bearer ' + connection.token } } }))
  // 1) The model proposes a task from ordinary chat; the tool only writes a proposal and a plan version.
  await setScript([
    { text: '', toolCalls: [{ id: 'propose-1', name: 'task_propose', arguments: JSON.stringify({ title: '写完作业二', steps: ['读要求', '写 answer.js', '检查'] }) }], delayMs: 0 },
    { text: '计划拟好了，等你批准。', toolCalls: [], delayMs: 0 },
  ])
  assert.equal((await dispatch({ type: 'message.send', text: '帮我写完作业二，先给我计划，不要动手。' })).status, 'accepted')
  await waitFor((state) => state.task?.status === 'completed' && (state.tasks?.length ?? 0) === 1, 'TASK_PROPOSAL_FAILED')
  let state = await snapshot()
  const task = state.tasks[0]
  assert.equal(task.status, 'proposed')
  assert.equal(task.plan?.version, 1)
  assert.deepEqual(task.plan?.steps.map((step) => step.status), ['pending', 'pending', 'pending'])
  report.proposal = { status: task.status, planVersion: task.plan?.version, stepCount: task.plan?.steps.length, approval: task.approval ?? null }
  // The card must be visible in the conversation flow with a user-only approve button.
  const card = page.locator(`[data-task-id="${task.id}"]`)
  await card.waitFor()
  report.uiCardVisible = true
  assert.ok(await card.innerText().then((text) => text.includes('待你批准计划')))
  await card.getByRole('button', { name: '批准这份计划', exact: true }).click()
  await waitFor((current) => current.tasks?.[0]?.status === 'active', 'TASK_APPROVE_FAILED')
  state = await snapshot()
  assert.equal(state.activeTaskId, task.id)
  assert.equal(state.tasks[0].approval?.planVersion, 1)
  report.approved = { status: state.tasks[0].status, planVersion: state.tasks[0].approval?.planVersion, scope: state.tasks[0].approval?.scope }
  // 2) Advance under the existing heart-flow execute wall: desk write plus task_step.
  assert.equal((await dispatch({ type: 'flow.goal.set', text: 'D1 synthetic task goal' })).status, 'accepted')
  assert.equal((await dispatch({ type: 'flow.enter' })).status, 'accepted')
  await waitFor((current) => !!current.heartFlow?.activeId, 'FLOW_ENTER_FAILED')
  assert.equal((await dispatch({ type: 'flow.mode', mode: 'execute' })).status, 'accepted')
  await setScript([
    { text: '', toolCalls: [
      { id: 'write-1', name: 'desk_write', arguments: JSON.stringify({ path: 'answer.js', text: 'return 42' }) },
      { id: 'step-1', name: 'task_step', arguments: JSON.stringify({ stepId: 'step-1', status: 'done' }) },
    ], delayMs: 0 },
    { text: '写好了。', toolCalls: [], delayMs: 0 },
  ])
  assert.equal((await dispatch({ type: 'message.send', text: '开始做吧。' })).status, 'accepted')
  await waitFor((current) => current.task?.status === 'completed' && !!current.heartFlow?.files.some((file) => file.path === 'answer.js')
    && current.tasks?.[0]?.plan?.steps[0]?.status === 'done', 'TASK_ADVANCE_FAILED')
  report.advanced = { deskWrite: true, firstStep: 'done', flowActive: !!(await snapshot()).heartFlow?.activeId }
  assert.equal((await dispatch({ type: 'flow.exit' })).status, 'accepted')
  await waitFor((current) => !current.heartFlow?.activeId, 'FLOW_EXIT_FAILED')
  // 3) The user closes the task from the card; model text cannot do this.
  await card.waitFor()
  await card.getByRole('button', { name: '标记完成', exact: true }).click()
  await waitFor((current) => current.tasks?.[0]?.status === 'completed', 'TASK_CLOSE_FAILED')
  report.closed = { status: (await snapshot()).tasks[0].status, activeTaskId: (await snapshot()).activeTaskId }
  // 4) Restart: replay must keep the completed task, approval and step progress, and the card visible.
  const rows = await journalRows()
  const count = (...types) => rows.filter((row) => types.includes(row.type)).length
  report.journal = {
    rows: rows.length,
    taskOpen: count('task/open'), taskPlan: count('task/plan'), taskApprove: count('task/approve'), taskFocus: count('task/focus'),
    taskStep: count('task/step'), taskClose: count('task/close'),
    flowModeExecute: rows.filter((row) => row.type === 'flow/mode' && row.mode === 'execute').length,
    deskWrite: rows.filter((row) => row.type === 'tool/call' && row.name === 'desk_write').length,
    deskChanges: count('desk/change'), flowOpen: count('flow/open'), flowClose: count('flow/close'),
  }
  await instance.close(); instance = undefined; await client.close(); client = undefined
  await launch()
  await waitFor((current) => (current.tasks?.length ?? 0) === 1, 'TASK_RESTART_MISSING')
  state = await snapshot()
  const restored = state.tasks[0]
  await page.locator(`[data-task-id="${restored.id}"]`).waitFor()
  report.restart = { status: restored.status, approvalPlanVersion: restored.approval?.planVersion ?? null, stepStatuses: restored.plan?.steps.map((step) => step.status), activeTaskId: state.activeTaskId, cardVisible: true }
  report.ok = restored.status === 'completed' && restored.approval?.planVersion === 1 && restored.plan?.steps[0]?.status === 'done'
    && report.journal.taskOpen === 1 && report.journal.taskApprove === 1 && report.journal.taskFocus === 1 && report.journal.taskStep === 1 && report.journal.taskClose === 1
    && report.journal.flowModeExecute === 1 && report.journal.deskWrite === 1 && report.journal.deskChanges === 1
  await mkdir(dirname(reportPath), { recursive: true })
  await writeFile(reportPath, JSON.stringify(report, null, 2), { mode: 0o644 })
  console.log(JSON.stringify({ ok: report.ok, report: reportPath, proposal: report.proposal, approved: report.approved, advanced: report.advanced, restart: report.restart, journal: report.journal }))
  assert.equal(report.ok, true, 'D1_SCENARIO_ASSERTIONS_FAILED')
} finally {
  await client?.close().catch(() => {})
  await instance?.close().catch(() => {})
  if (data.startsWith(join(root, '.local-data', 'task-object-'))) await rm(data, { recursive: true, force: true }).catch(() => {})
}
