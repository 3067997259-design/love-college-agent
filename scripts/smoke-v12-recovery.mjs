// P6: real book/main/DSH boundaries; isolated profiles and scripted local model only.
import assert from 'node:assert/strict'
import { randomUUID, createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron } from 'playwright'
import electronPath from 'electron'
import JSZip from 'jszip'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { runtimeEnv, initializeTestBook, electronLaunchTarget } from './runtime-env.mjs'

const root = resolve(import.meta.dirname, '..'), id = randomUUID(), scene = randomUUID()
const data = join(root, '.local-data', `p6-smoke-${id}`), profile = join(data, 'developer', scene)
const user = join(data, 'user'), evidence = join(root, 'test-results', `p6-${id}`)
const projects = await mkdtemp(join(tmpdir(), 'lca-p6-projects-')), projectA = join(projects, 'a'), projectB = join(projects, 'b')
const env = { ...runtimeEnv(root), LCA_DATA_DIR: data, LCA_PROVIDERS_FILE: join(data, 'absent.json'), LCA_CDP_PORT: '0', LCA_MCP_PORT: '0', USERPROFILE: user, HOME: user, APPDATA: join(user, 'AppData/Roaming'), LOCALAPPDATA: join(user, 'AppData/Local') }
const checks = [], marker = 'SYNTHETIC_MCP_PUBLIC'
let instance, page, client
const snapshot = () => page.evaluate(() => window.lca.getSnapshot())
const send = (body) => page.evaluate(async (body) => { const s = await window.lca.getSnapshot(); return window.lca.dispatch({ protocolVersion: 1, epoch: s.epoch, requestId: crypto.randomUUID(), ...body }) }, body)
async function until(test, label) { for (let i = 0; i < 600; i++) { if (await test(await snapshot())) return; await new Promise((done) => setTimeout(done, 100)) }; throw new Error(label) }
async function debug(name, args = {}) { const result = await client.callTool({ name, arguments: args }); assert.ok(!result.isError, name); return JSON.parse(result.content[0].text) }
const pass = (name) => { checks.push(name); console.log('P6_PASS', name) }
const textStep = (text = 'P6 synthetic completion', delayMs = 0) => ({ text, delayMs, toolCalls: [] })
const toolStep = (name, args) => ({ text: '', delayMs: 0, toolCalls: [{ id: randomUUID(), name, arguments: JSON.stringify(args) }] })
const target = (member) => ({ address: member.address, expectedRevision: member.revision })
const usageRows = async () => (await readFile(join(profile, 'runtime-resources/usage.jsonl'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line)).filter((row) => row.kind === 'model').length
async function idle() { await until((s) => !['running', 'queued', 'waiting-user', 'cancelling'].includes(s.task?.status) && s.collaboration.members.every((m) => !['starting', 'running', 'waiting', 'stopping'].includes(m.activity)), 'FAMILY_IDLE'); await new Promise((done) => setTimeout(done, 200)) }
async function setScript(script) { await idle(); await debug('set_fake_model', { script }) }
async function turn(label, steps = []) {
  console.log('P6_STAGE', label)
  await setScript([...steps, ...Array.from({ length: 5 }, () => textStep(label + ' completed'))])
  const old = (await snapshot()).task?.id
  assert.equal((await send({ type: 'message.send', text: `P6 ${label}` })).status, 'accepted')
  await until((s) => s.task?.id !== old && s.task?.status === 'completed', 'TURN_' + label); await idle()
}
async function refresh() { assert.equal((await send({ type: 'agent.refresh' })).status, 'accepted'); await until((s) => { if (s.collaboration.operation?.outcome === 'failed') throw new Error('REFRESH_FAILED'); return s.collaboration.status === 'ready' && s.collaboration.operation?.phase === 'settled' }, 'REFRESH') }
async function pick(path) {
  await instance.evaluate(({ dialog }, path) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] }) }, path)
  assert.equal((await send({ type: 'project.pick' })).status, 'accepted')
  await until((s) => s.work.current.path === path, 'PROJECT_PICK')
}
async function launch() {
  instance = await _electron.launch({ ...electronLaunchTarget(root, electronPath), env, timeout: 30_000 }); page = await instance.firstWindow(); await initializeTestBook(page)
  const config = JSON.parse(await readFile(join(profile, 'debug-connection.json'), 'utf8'))
  client = new Client({ name: 'p6-recovery', version: '1' }); await client.connect(new StreamableHTTPClientTransport(new URL(config.url), { requestInit: { headers: { Authorization: `Bearer ${config.token}` } } }))
  await debug('set_clock', { frozen: true }); await send({ type: 'mode.set', mode: 'quiet' })
}
async function close() { await client?.close(); client = null; await instance?.close(); instance = null }
try {
  for (const dir of [data, profile, user, env.APPDATA, env.LOCALAPPDATA, join(user, 'Documents'), join(user, 'Desktop'), join(user, 'Downloads'), evidence, projectA, projectB]) await mkdir(dir, { recursive: true })
  await writeFile(join(data, 'settings.json'), JSON.stringify({ version: 1, developer: true, booth: false, plugins: {}, sceneId: scene }))
  await writeFile(join(profile, 'clock.json'), JSON.stringify({ nowMs: Date.parse('2026-10-24T12:00:00+08:00'), frozen: true, rate: 1 }))
  await launch(); await pick(projectA); await refresh()
  await turn('team', [toolStep('spawn_teammate', { name: 'reviewer', description: 'P6 stable reviewer', prompt: 'Reply briefly to this synthetic task.' })])
  await turn('helper', [toolStep('subagent', { description: 'P6 independent helper', prompt: 'Reply briefly to this synthetic task.' })])
  await turn('board', [toolStep('team_task_create', { subject: 'P6 durable task', description: 'Verify continuity', write_scopes: ['src'] })])
  const a = (await snapshot()).collaboration, member = a.members.find((m) => m.mode === 'teammate')
  assert.ok(member); assert.equal(a.tasks.length, 1)
  await pick(projectB); assert.equal((await snapshot()).collaboration.members.length, 0)
  const stale = { type: 'agent.message', target: target(member), text: 'P6_STALE_MUST_NOT_EXECUTE' }
  assert.equal((await send(stale)).status, 'rejected')
  await turn('project-b'); await refresh()
  assert.ok((await snapshot()).collaboration.members.every((m) => m.mode === 'root')); assert.equal((await snapshot()).collaboration.tasks.length, 0)
  assert.ok(!JSON.stringify(await debug('get_context')).includes('P6 durable task'))
  await pick(projectA); await refresh()
  const returned = (await snapshot()).collaboration
  assert.equal(returned.members.filter((m) => m.mode !== 'root').length, 2); assert.equal(returned.tasks[0].id, a.tasks[0].id)
  pass('cross-project-state-address-isolation-and-return-without-member-execution')
  const coldUsage = await usageRows()
  await close(); await launch(); await refresh()
  const cold = (await snapshot()).collaboration
  assert.notEqual(cold.runtimeId, a.runtimeId); assert.equal(cold.tasks[0].id, a.tasks[0].id)
  assert.ok(cold.members.every((m) => m.activity === 'inactive')); assert.equal((await send(stale)).status, 'rejected')
  assert.ok(!JSON.stringify(await debug('get_context')).includes('choose by coordination needs'))
  assert.equal(await usageRows(), coldUsage, 'COLD_START_EXECUTED_A_MODEL_STEP')
  pass('cold-start-keeps-board-and-roster-but-rejects-old-runtime-address')

  // A real pending risk approval must not survive a member interrupt. The command is never approved.
  const sentinel = join(projectA, 'must-survive.txt'); await writeFile(sentinel, 'P6_SENTINEL')
  await turn('reactivate')
  await setScript([toolStep('pwsh', { command: `Remove-Item -LiteralPath '${sentinel.replaceAll("'", "''")}'` }), textStep()])
  let current = (await snapshot()).collaboration.members.find((m) => m.mode === 'teammate')
  assert.equal((await send({ type: 'agent.message', target: target(current), text: 'P6 synthetic approval cancellation' })).status, 'accepted')
  await until((s) => s.question?.kind === 'approval' && ['waiting', 'queued'].includes(s.question.status), 'MEMBER_APPROVAL')
  const question = (await snapshot()).question
  current = (await snapshot()).collaboration.members.find((m) => m.mode === 'teammate')
  assert.equal((await send({ type: 'agent.interrupt', target: target(current) })).status, 'accepted')
  await idle(); assert.ok(!(await snapshot()).question)
  assert.equal((await snapshot()).collaboration.members.find((m) => m.address.sessionId === current.address.sessionId).outcome, 'aborted')
  assert.equal((await send({ type: 'question.answer', questionId: question.id, answer: '允许这一次' })).status, 'rejected')
  assert.equal(await readFile(sentinel, 'utf8'), 'P6_SENTINEL')
  pass('member-interrupt-cancels-risk-approval-and-preserves-unexecuted-artifact')

  await turn('crash-ready')
  await setScript([textStep('P6_CRASH_REPLY_MUST_NOT_APPEAR', 60_000)])
  current = (await snapshot()).collaboration.members.find((m) => m.mode === 'teammate')
  assert.equal((await send({ type: 'agent.message', target: target(current), text: 'P6 interrupted model request' })).status, 'accepted')
  await until((s) => s.collaboration.members.some((m) => m.mode === 'teammate' && m.activity === 'running'), 'MEMBER_RUNNING')
  const extensionCount = (await snapshot()).extensions.operations.length
  const busyRuntime = (await snapshot()).collaboration.runtimeId
  await send({ type: 'project.select', path: projectB })
  assert.equal((await snapshot()).work.current.path, projectA); assert.equal((await snapshot()).work.error, 'project-busy')
  assert.equal((await send({ type: 'extension.restart' })).status, 'accepted')
  await until((s) => s.extensions.operations.length === extensionCount + 1 && s.extensions.operations.at(-1).outcome === 'failed', 'BUSY_EXTENSION_RESTART_NOT_REFUSED')
  assert.equal((await snapshot()).collaboration.runtimeId, busyRuntime)
  assert.ok(!(await snapshot()).question)
  assert.equal((await send({ type: 'backup.export' })).status, 'rejected')
  pass('idle-lead-active-member-blocks-project-switch-extension-restart-and-save')
  assert.equal(await instance.evaluate(() => {
    const children = process._getActiveHandles().filter((h) => h.connected && h.spawnargs?.some((arg) => /[\\/]dsh[\\/]lib[\\/]bin\.js$/.test(arg)))
    for (const child of children) child.kill()
    return children.length
  }), 1)
  await until((s) => s.collaboration.status === 'failed', 'HOST_EXIT')
  await refresh(); await idle()
  assert.notEqual((await snapshot()).collaboration.members.find((m) => m.address.sessionId === current.address.sessionId).outcome, 'completed')
  assert.ok(!(await snapshot()).messages.some((m) => m.text.includes('P6_CRASH_REPLY_MUST_NOT_APPEAR')))
  assert.equal(await readFile(sentinel, 'utf8'), 'P6_SENTINEL')
  pass('dsh-exit-during-member-work-and-read-only-reconnect-without-replay')

  await instance.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false }) })
  const server = (await snapshot()).mcp.servers.find((row) => row.id === 'synthetic-public')
  assert.equal((await send({ type: 'mcp.connect', serverId: server.id, fingerprint: server.fingerprint })).status, 'accepted')
  await until((s) => s.mcp.servers.some((row) => row.id === server.id && row.status === 'ready'), 'SOURCE_READY')
  const sourceTool = 'mcp_synthetic-public_' + createHash('sha256').update('synthetic_public').digest('hex').slice(0, 12)
  await turn('source', [toolStep(sourceTool, {}), toolStep('team_task_create', { subject: marker, description: marker, write_scopes: [marker] })])
  assert.ok(JSON.stringify(await debug('get_context')).includes(marker), 'SOURCE_MUST_ACTUALLY_REACH_MODEL')
  assert.ok(!JSON.stringify((await snapshot()).collaboration).includes(marker), 'SOURCE_IN_PUBLIC_BOARD')
  await turn('retire-source', [toolStep('team_task_list', {})])
  assert.ok(!JSON.stringify(await debug('get_context')).includes(marker), 'SOURCE_RETIRED')
  pass('source-derived-board-retires-in-actual-model-request-and-public-view')
  await pick(projectB); await turn('cross-project-source', [toolStep('team_task_list', {})])
  assert.ok(!JSON.stringify(await debug('get_context')).includes(marker), 'SOURCE_CROSSED_PROJECTS')
  await pick(projectA); await refresh()
  assert.ok(!JSON.stringify((await snapshot()).collaboration).includes(marker))
  pass('retired-task-source-cannot-return-through-project-switch-and-resident-reopen')

  const yesterday = (await snapshot()).collaboration
  const previousUsageDay = (await snapshot()).resources.model.dayKey, previousUsageRows = await usageRows()
  await debug('set_clock', { nowMs: Date.parse('2026-10-25T12:00:00+08:00') })
  await until((s) => s.session.dayKey === '2026-10-25', 'DAY_ROLLOVER')
  assert.equal((await snapshot()).collaboration.members.length, 0, 'YESTERDAY_ROSTER_STILL_CURRENT')
  assert.equal((await send({ type: 'agent.message', target: target(yesterday.members.find((m) => m.mode === 'teammate')), text: 'P6_OLD_DAY_MUST_NOT_EXECUTE' })).status, 'rejected')
  await turn('new-day', [toolStep('team_task_list', {})]); await refresh()
  assert.ok(!JSON.stringify(await debug('get_context')).includes(marker))
  assert.equal((await snapshot()).collaboration.tasks.length, 0)
  assert.ok((await snapshot()).collaboration.members.every((m) => m.mode === 'root'))
  assert.notEqual((await snapshot()).resources.model.dayKey, previousUsageDay)
  assert.ok(await usageRows() > previousUsageRows, 'DAY_ROLLOVER_ERASED_USAGE_HISTORY')
  pass('clock-driven-day-rollover-revokes-old-roster-controls-and-source-context')

  await turn('saved-team', [toolStep('spawn_teammate', { name: 'saved-reviewer', description: 'P6 saved day member', prompt: 'Reply briefly.' })])
  const archive = join(data, 'p6.lca-save')
  await instance.evaluate(({ dialog }, file) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: file }) }, archive)
  assert.equal((await send({ type: 'backup.export' })).status, 'accepted')
  await until((s) => s.backup.status === 'exported', 'EXPORT')
  const archiveBytes = await readFile(archive), zip = await JSZip.loadAsync(archiveBytes)
  const manifest = JSON.parse(await zip.file('manifest.json').async('string'))
  assert.ok(manifest.files.every((f) => !/dsh-home|dsh-sessions|dsh-approvals|extensions|connections|settings/.test(f.path)))
  const savedMembers = new Set((await snapshot()).collaboration.members.map((m) => m.address.sessionId))
  await turn('P6_AFTER_SAVE_MUST_BE_REWOUND', [toolStep('spawn_teammate', { name: 'after-save', description: 'P6_AFTER_SAVE_MEMBER', prompt: 'Reply briefly.' })])
  const beforeRestore = (await snapshot()).collaboration
  const after = beforeRestore.members.find((m) => m.mode === 'teammate' && !savedMembers.has(m.address.sessionId))
  assert.ok(after, 'AFTER_SAVE_MEMBER_WAS_NOT_CREATED')
  await instance.evaluate(({ dialog, app }, file) => { app.relaunch = () => {}; dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }) }, archive)
  await send({ type: 'backup.import' }); await until((s) => s.backup.status === 'awaiting-confirmation', 'IMPORT')
  const restoreId = (await snapshot()).backup.restoreId
  await client.close(); client = null
  const ended = instance.waitForEvent('close'); await send({ type: 'backup.restore', restoreId }); await ended; instance = null
  await launch(); assert.equal((await snapshot()).backup.status, 'restored'); assert.ok((await snapshot()).backup.safetyBackupId)
  await refresh()
  assert.ok((await snapshot()).collaboration.members.every((m) => m.mode === 'root')); assert.equal((await snapshot()).collaboration.tasks.length, 0)
  assert.equal((await send({ type: 'agent.message', target: target(after), text: 'P6_RESTORED_STALE_MESSAGE' })).status, 'rejected')
  await turn('after-restore', [toolStep('list_agents', {})])
  const restoredInput = JSON.stringify(await debug('get_context'))
  assert.ok(!/P6_AFTER_SAVE_MUST_BE_REWOUND|P6_AFTER_SAVE_MEMBER|SYNTHETIC_MCP_PUBLIC/.test(restoredInput))
  assert.ok(!JSON.stringify((await snapshot()).messages).includes('P6_AFTER_SAVE_MUST_BE_REWOUND'))
  pass('private-save-rewinds-journal-starts-new-family-and-never-replays-old-members')
  const restoredUsage = await usageRows()
  await close(); await launch(); await refresh()
  assert.ok((await snapshot()).collaboration.members.every((m) => m.mode === 'root')); assert.ok(!JSON.stringify(await debug('get_context')).includes('choose by coordination needs'))
  assert.equal(await usageRows(), restoredUsage, 'RESTORE_RESTART_EXECUTED_A_MODEL_STEP')
  pass('second-cold-start-after-restore-has-no-background-resurrection')
  await writeFile(join(evidence, 'evidence.json'), JSON.stringify({ checks, syntheticOnly: true, simulatedDay: true, executable: process.env.LCA_TEST_EXECUTABLE ?? electronPath, data, projects, archiveSha256: createHash('sha256').update(archiveBytes).digest('hex'), canceledQuestionId: question.id }, null, 2))
  console.log('P6_EVIDENCE', evidence)
} catch (error) {
  if (page && !page.isClosed()) await writeFile(join(evidence, 'failure.json'), JSON.stringify({ error: String(error), checks, snapshot: await snapshot() }, null, 2))
  throw error
} finally { await close() }
