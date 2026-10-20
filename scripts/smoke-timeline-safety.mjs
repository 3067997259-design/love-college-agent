import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron } from 'playwright'
import electronPath from 'electron'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { runtimeEnv, initializeTestBook, electronLaunchTarget, openSettings } from './runtime-env.mjs'

/**
 * D2 safety scenario (developer scripted model; no network, no real provider):
 * 1) a workspace write is refused before the task plan is approved;
 * 2) after approval the same write runs without any heart flow, and the request tool list is unchanged;
 * 3) a user reveal of one original marks the next turn degraded, refuses writes in it, and attaches once;
 * 4) the following turn is not degraded. Reports counts, tool names and booleans only.
 */
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const data = join(root, '.local-data', 'timeline-safety-' + randomUUID())
const sceneId = randomUUID()
const profile = join(data, 'developer', sceneId)
const reportPath = process.env.LCA_TIMELINE_SAFETY_REPORT ?? join(root, 'test-results', 'd2-timeline-safety', 'scenario.json')
const env = { ...runtimeEnv(root), LCA_DATA_DIR: data, LCA_PROVIDERS_FILE: join(data, 'absent.json'), LCA_MCP_PORT: '0', LCA_CDP_PORT: '0', LCA_TEST_SILENT: '1' }
const sleep = (ms) => new Promise((done) => setTimeout(done, ms))
let instance
let page
let client
const report = { ok: false, probe: 'd2-timeline-safety', syntheticModel: true, scenario: 'D2-S0: unapproved write refused -> plan approval -> flowless write allowed -> one-shot reveal/degraded turn -> write refused -> next turn clean' }
const snapshot = () => page.evaluate(() => window.lca.getSnapshot())
const dispatch = async (body) => page.evaluate(async (body) => {
  const state = await window.lca.getSnapshot()
  return window.lca.dispatch({ protocolVersion: 1, epoch: state.epoch, requestId: crypto.randomUUID(), ...body })
}, body)
async function waitFor(test, message, attempts = 300) {
  for (let index = 0; index < attempts; index++) {
    if (await test(await snapshot())) return
    await sleep(100)
  }
  throw new Error(message)
}
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
  await walk(profile)
  const rows = []
  for (const file of found) for (const line of (await readFile(file, 'utf8')).split(/\r?\n/)) if (line.trim()) { try { rows.push(JSON.parse(line)) } catch { /* torn tail is not evidence */ } }
  return rows
}
async function setScript(script) { await client.callTool({ name: 'set_fake_model', arguments: { script } }) }
async function reply(text = 'OK') { await setScript([{ text, toolCalls: [], delayMs: 0 }]) }
async function send(text) { assert.equal((await dispatch({ type: 'message.send', text })).status, 'accepted'); await waitFor((state) => state.task?.status === 'completed' || state.task?.status === 'failed', 'TURN_NOT_SETTLED') }
const seenTools = (rows) => rows.filter((row) => row.type === 'model/seen').map((row) => [...(row.tools ?? [])].sort())
try {
  await mkdir(profile, { recursive: true })
  await writeFile(join(data, 'settings.json'), JSON.stringify({ version: 1, developer: true, booth: false, plugins: {}, sceneId }))
  instance = await _electron.launch({ ...electronLaunchTarget(root, electronPath), env, timeout: 30_000 })
  page = await instance.firstWindow()
  await initializeTestBook(page)
  await page.locator('[data-mode][data-pose]').waitFor()
  const connectionPath = join(profile, 'debug-connection.json')
  let connection
  for (let index = 0; index < 100 && !connection; index++) { try { connection = JSON.parse(await readFile(connectionPath, 'utf8')) } catch { await sleep(100) } }
  assert.ok(connection, 'DEBUG_CONNECTION_MISSING')
  client = new Client({ name: 'timeline-safety', version: '1.0.0' })
  await client.connect(new StreamableHTTPClientTransport(new URL(connection.url), { requestInit: { headers: { Authorization: 'Bearer ' + connection.token } } }))
  // Baseline turn: fixed tool list captured from the journal.
  await reply('基准回复')
  await send('普通聊天基准')
  let rows = await journalRows()
  const toolsBaseline = seenTools(rows).at(-1)
  assert.ok(toolsBaseline?.includes('desk_write') && toolsBaseline.includes('task_propose'), 'FIXED_TOOL_LIST_INCOMPLETE')
  assert.ok(!toolsBaseline.includes('update_plan') && !toolsBaseline.includes('run_javascript') && !toolsBaseline.includes('run_command'), 'LEGACY_FLOW_TOOLS_VISIBLE')
  report.legacyToolsHidden = true
  // Unapproved write is refused and leaves no desk change.
  await setScript([{ text: '', toolCalls: [{ id: 'write-1', name: 'desk_write', arguments: JSON.stringify({ path: 'answer.js', text: 'return 42' }) }], delayMs: 0 }, { text: '先需要批准。', toolCalls: [], delayMs: 0 }])
  await send('先写写看')
  rows = await journalRows()
  const refused = rows.filter((row) => row.type === 'tool/result').at(-1)
  report.unapprovedWrite = refused?.visible?.error ?? null
  assert.equal(report.unapprovedWrite, 'TASK_NOT_APPROVED')
  assert.equal(rows.filter((row) => row.type === 'desk/change').length, 0)
  // Propose via chat and approve the concrete plan version.
  await setScript([{ text: '', toolCalls: [{ id: 'propose-1', name: 'task_propose', arguments: JSON.stringify({ title: '写完作业二', steps: ['写 answer.js', '检查'] }) }], delayMs: 0 }, { text: '计划拟好了。', toolCalls: [], delayMs: 0 }])
  await send('帮我计划写完作业二')
  await waitFor((state) => (state.tasks?.length ?? 0) === 1, 'TASK_PROPOSAL_MISSING')
  let state = await snapshot()
  const task = state.tasks[0]
  // Approval itself starts one work turn; the model script is installed before the click.
  await setScript([{ text: '', toolCalls: [
    { id: 'write-2', name: 'desk_write', arguments: JSON.stringify({ path: 'answer.js', text: 'return 42' }) },
    { id: 'step-2', name: 'task_step', arguments: JSON.stringify({ stepId: 'step-1', status: 'done' }) },
  ], delayMs: 0 }, { text: '写好了。', toolCalls: [], delayMs: 0 }])
  assert.equal((await dispatch({ type: 'task.approve', taskId: task.id, planVersion: 1 })).status, 'accepted')
  await waitFor((current) => current.tasks?.[0]?.status === 'active', 'TASK_APPROVE_FAILED')
  await waitFor((current) => current.heartFlow?.files.some((file) => file.path === 'answer.js') && current.tasks?.[0]?.plan?.steps[0]?.status === 'done', 'APPROVED_WRITE_FAILED')
  rows = await journalRows()
  const toolsWork = seenTools(rows).at(-1)
  report.flowlessWork = { autoStarted: rows.filter((row) => row.type === 'turn/start' && row.trigger === 'autonomous').length >= 1,
    deskWrite: rows.some((row) => row.type === 'desk/change' && row.path === 'answer.js'), taskId: rows.find((row) => row.type === 'desk/change')?.taskId ?? null,
    flowOpen: rows.filter((row) => row.type === 'flow/open').length, toolsEqual: JSON.stringify(toolsBaseline) === JSON.stringify(toolsWork) }
  assert.equal(report.flowlessWork.autoStarted, true)
  assert.equal(report.flowlessWork.deskWrite, true)
  assert.equal(report.flowlessWork.taskId, task.id)
  assert.equal(report.flowlessWork.flowOpen, 0)
  assert.equal(report.flowlessWork.toolsEqual, true)
  // Synthetic mail material: produce a candidate with a user-only evidence ref, then reveal exactly one original.
  await openSettings(page)
  await page.getByLabel('合成邮件场景').selectOption('initial')
  await waitFor((state) => state.mailbox?.scenarioId === 'initial', 'SCENARIO_NOT_SELECTED')
  await page.getByRole('button', { name: '关闭', exact: true }).click()
  await page.getByRole('button', { name: '日程', exact: true }).click()
  await page.getByRole('button', { name: '扫描合成邮件', exact: true }).click()
  await waitFor((state) => ['ready', 'failed'].includes(state.mailbox?.status), 'SCAN_NOT_FINISHED')
  state = await snapshot()
  assert.ok((state.candidates?.length ?? 0) >= 1, 'CANDIDATES_MISSING')
  const evidenceRef = state.candidates[0].evidenceRef
  await page.locator('.bookmarks').getByRole('button', { name: /^对话/ }).click()
  await setScript([{ text: '', toolCalls: [{ id: 'write-3', name: 'desk_write', arguments: JSON.stringify({ path: 'answer.js', text: 'return 43' }) }], delayMs: 0 }, { text: '降级轮不能直接写。', toolCalls: [], delayMs: 0 }])
  assert.equal((await dispatch({ type: 'context.reveal', source: 'mail', ref: evidenceRef })).status, 'accepted')
  await send('把原文放进这一轮再写')
  rows = await journalRows()
  const degradedTurnId = rows.filter((row) => row.type === 'turn/degraded').at(-1)?.turnId
  const degradedAttempt = rows.filter((row) => row.type === 'tool/result' && row.turnId === degradedTurnId && row.ok === false).at(-1)
  report.reveal = {
    revealRows: rows.filter((row) => row.type === 'context/reveal').length,
    degradedRows: rows.filter((row) => row.type === 'turn/degraded').length,
    degradedSources: rows.filter((row) => row.type === 'turn/degraded').at(-1)?.sources ?? null,
    degradedWriteError: degradedAttempt?.visible?.error ?? null,
    deskChangesInDegradedTurn: rows.filter((row) => row.type === 'desk/change' && row.atMs > (rows.filter((row) => row.type === 'turn/degraded').at(-1)?.atMs ?? 0)).length,
  }
  assert.equal(report.reveal.revealRows, 1)
  assert.equal(report.reveal.degradedRows, 1)
  assert.deepEqual(report.reveal.degradedSources, ['mail'])
  assert.equal(report.reveal.degradedWriteError, 'DEGRADED_SOURCE_REQUIRES_APPROVAL')
  assert.equal(report.reveal.deskChangesInDegradedTurn, 0)
  // Next turn is clean: no new degraded fact and the tool list is still unchanged.
  await reply('好的。')
  await send('谢谢')
  rows = await journalRows()
  report.oneShot = { degradedRowsAfter: rows.filter((row) => row.type === 'turn/degraded').length, toolsEqual: JSON.stringify(toolsBaseline) === JSON.stringify(seenTools(rows).at(-1)) }
  assert.equal(report.oneShot.degradedRowsAfter, 1)
  assert.equal(report.oneShot.toolsEqual, true)
  report.journal = { rows: rows.length, modelSeen: rows.filter((row) => row.type === 'model/seen').length, taskApprove: rows.filter((row) => row.type === 'task/approve').length, deskChanges: rows.filter((row) => row.type === 'desk/change').length }
  const serialized = JSON.stringify(rows.filter((row) => row.type === 'model/seen'))
  assert.ok(!serialized.includes('RAW_ONLY_'), 'ORIGINAL_IN_RECORDED_REQUEST')
  await waitFor((current) => !!current.task && current.task.status === 'completed', 'FINAL_TURN_NOT_SETTLED')
  rows = await journalRows()
  report.lastSeenContentFree = !JSON.stringify(rows.filter((row) => row.type === 'model/seen')).includes('RAW_ONLY_')
  report.ok = true
  await mkdir(dirname(reportPath), { recursive: true })
  await writeFile(reportPath, JSON.stringify(report, null, 2), { mode: 0o644 })
  console.log(JSON.stringify(report))
} finally {
  await client?.close().catch(() => {})
  await instance?.close().catch(() => {})
  if (data.startsWith(join(root, '.local-data', 'timeline-safety-'))) await rm(data, { recursive: true, force: true }).catch(() => {})
}
