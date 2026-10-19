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
 * D4 handoff scenario (developer scripted model; no network or real provider):
 * approved task + desk evidence -> short focus ends -> model submits task_handoff -> code evidence and
 * B segment visible on the task card -> next-day relaunch carries the checkpoint as a fresh proposal
 * (old approval not revived) -> user re-approves.
 */
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const data = join(root, '.local-data', 'handoff-flow-' + randomUUID())
const sceneId = randomUUID()
const profile = join(data, 'developer', sceneId)
const reportPath = process.env.LCA_HANDOFF_REPORT ?? join(root, 'test-results', 'd4-handoff', 'scenario.json')
const env = { ...runtimeEnv(root), LCA_DATA_DIR: data, LCA_PROVIDERS_FILE: join(data, 'absent.json'), LCA_MCP_PORT: '0', LCA_CDP_PORT: '0', LCA_TEST_SILENT: '1' }
const sleep = (ms) => new Promise((done) => setTimeout(done, ms))
let instance
let page
let client
const report = { ok: false, probe: 'd4-handoff', syntheticModel: true, scenario: 'D4-S0: task evidence -> focus end handoff -> B segment card -> next-day carry without approval -> re-approve' }
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
  for (const file of found) for (const line of (await readFile(file, 'utf8')).split(/\r?\n/)) if (line.trim()) { try { rows.push(JSON.parse(line)) } catch { /* torn tail */ } }
  return rows.sort((a, b) => a.atMs - b.atMs || a.seq - b.seq)
}
async function launch() {
  instance = await _electron.launch({ ...electronLaunchTarget(root, electronPath), env, timeout: 30_000 })
  page = await instance.firstWindow()
  await initializeTestBook(page)
  await page.locator('[data-mode][data-pose]').waitFor()
}
async function connect() {
  const path = join(profile, 'debug-connection.json')
  let connection
  for (let index = 0; index < 100 && !connection; index++) { try { connection = JSON.parse(await readFile(path, 'utf8')) } catch { await sleep(100) } }
  assert.ok(connection, 'DEBUG_CONNECTION_MISSING')
  client = new Client({ name: 'handoff-flow', version: '1.0.0' })
  await client.connect(new StreamableHTTPClientTransport(new URL(connection.url), { requestInit: { headers: { Authorization: 'Bearer ' + connection.token } } }))
}
const setScript = async (script) => { await client.callTool({ name: 'set_fake_model', arguments: { script } }) }
const send = async (text) => { assert.equal((await dispatch({ type: 'message.send', text })).status, 'accepted'); await waitFor((state) => state.task?.status === 'completed', 'TURN_NOT_SETTLED') }
try {
  await mkdir(profile, { recursive: true })
  await writeFile(join(data, 'settings.json'), JSON.stringify({ version: 1, developer: true, booth: false, plugins: {}, sceneId }))
  await launch(); await connect()
  // Approved task with one real desk write as handoff evidence.
  await setScript([{ text: '', toolCalls: [{ id: 'propose-1', name: 'task_propose', arguments: JSON.stringify({ title: '写完作业二', steps: ['写 answer.js', '检查'] }) }], delayMs: 0 }, { text: '计划拟好了。', toolCalls: [], delayMs: 0 }])
  await send('帮我计划写完作业二')
  const task = (await snapshot()).tasks[0]
  assert.equal((await dispatch({ type: 'task.approve', taskId: task.id, planVersion: 1 })).status, 'accepted')
  await waitFor((state) => state.tasks?.[0]?.status === 'active', 'TASK_NOT_ACTIVE')
  await setScript([{ text: '', toolCalls: [{ id: 'write-1', name: 'desk_write', arguments: JSON.stringify({ path: 'answer.js', text: 'return 42' }) }], delayMs: 0 }, { text: '写好了。', toolCalls: [], delayMs: 0 }])
  await send('开始做吧')
  // Short focus: let the continuation cap finish, then hand the final script step to the focus-end turn.
  assert.equal((await dispatch({ type: 'pomodoro.plan', plan: { label: 'D4 交班', plannedCount: 1, focusDurationMs: 8000, shortBreakDurationMs: 20_000, longBreakDurationMs: 20_000, longBreakEvery: 4, timing: 'custom' } })).status, 'accepted')
  const proposal = (await snapshot()).pomodoro.proposal
  assert.ok(proposal, 'POMODORO_PROPOSAL_MISSING')
  assert.equal((await dispatch({ type: 'pomodoro.confirm', planId: proposal.id })).status, 'accepted')
  assert.equal((await dispatch({ type: 'pomodoro.start', planId: proposal.id })).status, 'accepted')
  await waitFor(async () => (await journalRows()).filter((row) => row.type === 'turn/start' && row.trigger === 'autonomous').length >= 4, 'CONTINUATION_MISSING', 100)
  await waitFor((state) => state.task?.status !== 'running' && state.pomodoro?.status === 'running', 'CONTINUATION_NOT_SETTLED')
  await sleep(300)
  await setScript([
    { text: '', toolCalls: [{ id: 'handoff-1', name: 'task_handoff', arguments: JSON.stringify({ completed: ['写出 answer.js'], decisions: [], unresolved: ['还没检查'], next: ['检查'] }) }], delayMs: 0 },
    { text: '交班写好了。', toolCalls: [], delayMs: 0 },
  ])
  try {
    await waitFor(async () => (await journalRows()).some((row) => row.type === 'task/handoff' && row.source === 'model'), 'MODEL_HANDOFF_MISSING', 150)
  } catch (failure) {
    const rows = await journalRows()
    const lastStart = rows.filter((row) => row.type === 'turn/start').at(-1)
    const lastTurnRows = rows.filter((row) => row.turnId === lastStart?.turnId || row.type === 'turn/end' && row.turnId === lastStart?.turnId)
    const debug = { turns: rows.filter((row) => row.type === 'turn/start').map((row) => row.trigger).slice(-8),
      handoffs: rows.filter((row) => row.type === 'task/handoff').map((row) => ({ source: row.source, turnId: row.turnId, atMs: row.atMs })),
      ends: rows.filter((row) => row.type === 'turn/end').map((row) => ({ reason: row.reason, error: row.error ?? null })).slice(-4),
      lastTurn: lastTurnRows.map((row) => ({ type: row.type, ...('error' in row ? { error: row.error } : {}), ...('reason' in row ? { reason: row.reason } : {}), ...('status' in row ? { status: row.status } : {}), ...('text' in row ? { text: String(row.text).slice(0, 120) } : {}) })),
      state: await snapshot().then((state) => ({ task: state.task?.status, tasks: state.tasks?.map((item) => item.status), pomodoro: state.pomodoro?.phase })) }
    throw new Error('MODEL_HANDOFF_MISSING ' + JSON.stringify(debug) + ' ' + failure.message, { cause: failure })
  }
  const rowsAfterHandoff = await journalRows()
  const handoff = rowsAfterHandoff.filter((row) => row.type === 'task/handoff').at(-1)
  report.handoff = { source: handoff.source, taskId: handoff.taskId, completed: handoff.completed, next: handoff.next, evidenceChanges: handoff.evidence.changes.map((change) => change.path), commands: handoff.evidence.commands.length }
  assert.equal(handoff.taskId, task.id)
  assert.deepEqual(handoff.evidence.changes.map((change) => change.path), ['answer.js'])
  await waitFor((state) => !!state.tasks?.[0]?.latestHandoff, 'CARD_HANDOFF_MISSING')
  const card = page.locator(`[data-task-id="${task.id}"]`)
  await card.waitFor()
  assert.ok((await card.innerText()).includes('交班检查点'), 'CARD_HANDOFF_TEXT_MISSING')
  report.card = { handoffVisible: true, text: '交班检查点' }
  // Next-day relaunch: carry from the checkpoint without the old approval.
  const nowMs = Date.now()
  await client.callTool({ name: 'set_clock', arguments: { nowMs: nowMs + 26 * 60 * 60_000, rate: 1, frozen: false } })
  await instance.close(); instance = undefined; await client.close(); client = undefined
  await launch(); await connect()
  await waitFor((state) => (state.tasks?.length ?? 0) === 1, 'CARRIED_TASK_MISSING')
  let state = await snapshot()
  const carried = state.tasks[0]
  report.carried = { id: carried.id, status: carried.status, approval: carried.approval ?? null, handoff: carried.latestHandoff?.source ?? null, activeTaskId: state.activeTaskId }
  assert.equal(carried.id, task.id)
  assert.equal(carried.status, 'proposed')
  assert.equal(carried.approval, undefined)
  assert.equal(carried.latestHandoff?.next?.[0], '检查')
  await page.locator(`[data-task-id="${task.id}"]`).waitFor()
  // Fresh authorization is a new fact; the old approval is never copied forward.
  const rowsBeforeReapprove = (await journalRows()).length
  assert.equal((await dispatch({ type: 'task.approve', taskId: task.id, planVersion: 1 })).status, 'accepted')
  await waitFor((current) => current.tasks?.[0]?.status === 'active', 'REAPPROVE_FAILED')
  state = await snapshot()
  const newApprovals = (await journalRows()).slice(rowsBeforeReapprove).filter((row) => row.type === 'task/approve').length
  report.reapproval = { status: state.tasks[0].status, approvalRowsToday: newApprovals }
  assert.equal(report.reapproval.status, 'active')
  assert.equal(report.reapproval.approvalRowsToday, 1)
  report.ok = report.handoff.source === 'model' && report.carried.status === 'proposed' && report.carried.approval === null && report.reapproval.status === 'active'
  await mkdir(dirname(reportPath), { recursive: true })
  await writeFile(reportPath, JSON.stringify(report, null, 2), { mode: 0o644 })
  console.log(JSON.stringify(report))
} finally {
  await client?.close().catch(() => {})
  await instance?.close().catch(() => {})
  if (data.startsWith(join(root, '.local-data', 'handoff-flow-'))) await rm(data, { recursive: true, force: true }).catch(() => {})
}
