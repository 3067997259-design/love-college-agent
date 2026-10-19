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
 * D3 attention scenario (developer scripted models; no network or real provider):
 * a task is waiting for plan approval during a focus, her reading makes progress, then approval makes
 * the task compute and her reading yields; after the per-focus cap her reading resumes. The left-page
 * pose is asserted to follow the attention decision. Rest/hand-off assertions stay in D4.
 */
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const data = join(root, '.local-data', 'attention-flow-' + randomUUID())
const sceneId = randomUUID()
const profile = join(data, 'developer', sceneId)
const reportPath = process.env.LCA_ATTENTION_REPORT ?? join(root, 'test-results', 'd3-attention', 'scenario.json')
const env = { ...runtimeEnv(root), LCA_DATA_DIR: data, LCA_PROVIDERS_FILE: join(data, 'absent.json'), LCA_MCP_PORT: '0', LCA_CDP_PORT: '0', LCA_TEST_SILENT: '1' }
const sleep = (ms) => new Promise((done) => setTimeout(done, ms))
let instance
let page
let client
const report = { ok: false, probe: 'd3-attention', syntheticModel: true, scenario: 'D3-S0: proposed task + focus, her reading progresses, approval starts task continuation, reading yields, cap ends, reading resumes' }
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
  return rows
}
const lifeCommits = (rows) => rows.filter((row) => row.type === 'life/work-commit').length
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
  client = new Client({ name: 'attention-flow', version: '1.0.0' })
  await client.connect(new StreamableHTTPClientTransport(new URL(connection.url), { requestInit: { headers: { Authorization: 'Bearer ' + connection.token } } }))
  const setScript = async (script) => { await client.callTool({ name: 'set_fake_model', arguments: { script } }) }
  // A pending proposal and a running focus: her own reading should make progress while the task waits.
  await setScript([{ text: '', toolCalls: [{ id: 'propose-1', name: 'task_propose', arguments: JSON.stringify({ title: '写完作业二', steps: ['写 answer.js', '检查'] }) }], delayMs: 0 }, { text: '计划拟好了，等你批准。', toolCalls: [], delayMs: 0 }])
  assert.equal((await dispatch({ type: 'message.send', text: '帮我计划写完作业二' })).status, 'accepted')
  await waitFor((state) => (state.tasks?.length ?? 0) === 1, 'TASK_PROPOSAL_MISSING')
  const task = (await snapshot()).tasks[0]
  assert.equal((await dispatch({ type: 'pomodoro.plan', plan: { label: 'D3 专注', plannedCount: 1, focusDurationMs: 120_000, shortBreakDurationMs: 20_000, longBreakDurationMs: 20_000, longBreakEvery: 4, timing: 'custom' } })).status, 'accepted')
  const proposal = (await snapshot()).pomodoro.proposal
  assert.ok(proposal, 'POMODORO_PROPOSAL_MISSING')
  assert.equal((await dispatch({ type: 'pomodoro.confirm', planId: proposal.id })).status, 'accepted')
  assert.equal((await dispatch({ type: 'pomodoro.start', planId: proposal.id })).status, 'accepted')
  await waitFor((state) => state.pomodoro.phase === 'focus' && state.pomodoro.status === 'running', 'FOCUS_NOT_STARTED')
  // Her reading starts while the task is only proposed (waiting for approval).
  assert.equal((await dispatch({ type: 'developer.life.seed' })).status, 'accepted')
  assert.equal((await dispatch({ type: 'life.work.start', kind: 'read' })).status, 'accepted')
  await waitFor(async () => lifeCommits(await journalRows()) >= 1, 'LIFE_DID_NOT_START', 200)
  const commitsWhileWaiting = lifeCommits(await journalRows())
  report.waiting = { commitsWhileWaiting, taskStatus: task.status }
  // Approve while focused; continuation must start and her reading must yield (no new commit in its window).
  await setScript(Array.from({ length: 8 }, (_, index) => ({ text: '继续推进。' + index, toolCalls: [], delayMs: 1500 })))
  const beforeApprove = await journalRows()
  const commitSeqsBefore = new Set(beforeApprove.filter((row) => row.type === 'life/work-commit').map((row) => row.seq))
  assert.equal((await dispatch({ type: 'task.approve', taskId: task.id, planVersion: 1 })).status, 'accepted')
  let taskPose
  for (let index = 0; index < 200; index++) {
    const state = await snapshot()
    if (state.attention?.kind === 'task' && state.companion.pose === 'desk-computer') { taskPose = state.attention; break }
    await sleep(50)
  }
  assert.ok(taskPose, 'TASK_ATTENTION_POSE_NOT_OBSERVED')
  report.taskAttention = taskPose
  await waitFor(async () => (await journalRows()).filter((row) => row.type === 'turn/start' && row.trigger === 'autonomous').length >= 4, 'CONTINUATION_TURNS_MISSING', 300)
  const rowsAfter = await journalRows()
  const autonomous = rowsAfter.flatMap((row, index) => row.type === 'turn/start' && row.trigger === 'autonomous' ? [{ index, row }] : [])
  const ends = rowsAfter.flatMap((row, index) => row.type === 'turn/end' ? [{ index, row }] : []).filter((end) => autonomous.some((start) => start.row.turnId === end.row.turnId))
  const firstAutonomous = autonomous[0]?.index ?? -1
  const lastAutonomousEnd = Math.max(...ends.map((end) => end.index), -1)
  const commitsDuringTask = rowsAfter.filter((row, index) => row.type === 'life/work-commit' && index > firstAutonomous && index < lastAutonomousEnd && !commitSeqsBefore.has(row.seq)).length
  report.yield = { autonomousTurns: autonomous.length, commitsDuringTask, firstAutonomous, lastAutonomousEnd }
  assert.equal(commitsDuringTask, 0)
  // After the cap, her reading resumes from its bookmark.
  await waitFor(async () => lifeCommits(await journalRows()) > commitsWhileWaiting, 'LIFE_DID_NOT_RESUME', 400)
  const finalRows = await journalRows()
  report.resumed = { commitsAfter: lifeCommits(finalRows), expectedMoreThan: commitsWhileWaiting }
  report.ok = report.waiting.commitsWhileWaiting >= 1 && report.yield.autonomousTurns >= 4 && report.yield.commitsDuringTask === 0 && report.resumed.commitsAfter > commitsWhileWaiting
  await mkdir(dirname(reportPath), { recursive: true })
  await writeFile(reportPath, JSON.stringify(report, null, 2), { mode: 0o644 })
  console.log(JSON.stringify(report))
} finally {
  await client?.close().catch(() => {})
  await instance?.close().catch(() => {})
  if (data.startsWith(join(root, '.local-data', 'attention-flow-'))) await rm(data, { recursive: true, force: true }).catch(() => {})
}
