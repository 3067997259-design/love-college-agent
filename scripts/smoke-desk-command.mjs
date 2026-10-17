import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron } from 'playwright'
import electronPath from 'electron'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { runtimeEnv, initializeTestBook, electronLaunchTarget } from './runtime-env.mjs'
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..'); const data = join(root, '.local-data', 'desk-command-smoke-' + randomUUID()); const sceneId = randomUUID(); const profile = join(data, 'developer', sceneId)
const env = { ...runtimeEnv(root), LCA_DATA_DIR: data, LCA_PROVIDERS_FILE: join(data, 'absent.json'), LCA_CDP_PORT: '19568', LCA_MCP_PORT: '0' }
let instance; let page; let client; let desk
const snapshot = () => page.evaluate(() => window.lca.getSnapshot())
const send = (body) => page.evaluate(async (body) => { const s = await window.lca.getSnapshot(); return window.lca.dispatch({ protocolVersion: 1, epoch: s.epoch, requestId: crypto.randomUUID(), ...body }) }, body)
async function waitFor(test, message) { for (let i = 0; i < 300; i++) { if (test(await snapshot())) return; await new Promise((done) => setTimeout(done, 100)) }; throw new Error(message + ': ' + JSON.stringify((await snapshot()).heartFlow?.command)) }
async function launch() {
  instance = await _electron.launch({ ...electronLaunchTarget(root, electronPath), env }); page = await instance.firstWindow(); await initializeTestBook(page)
  instance.process().stderr.on('data', (chunk) => { for (const line of chunk.toString('utf8').split('\n')) if (/COMMAND_SANDBOX_FAILURE [a-z-]+ -?\d+/.test(line)) console.log(line.match(/COMMAND_SANDBOX_FAILURE [a-z-]+ -?\d+/)[0]) })
  const config = JSON.parse(await readFile(join(profile, 'debug-connection.json'), 'utf8')); client = new Client({ name: 'command-smoke', version: '1.0.0' })
  await client.connect(new StreamableHTTPClientTransport(new URL(config.url), { requestInit: { headers: { Authorization: 'Bearer ' + config.token } } }))
  const rooms = await readdir(join(profile, 'rooms')); assert.equal(rooms.length, 1); desk = join(profile, 'rooms', rooms[0], '书桌')
}
const debug = async (name, args = {}) => { const result = await client.callTool({ name, arguments: args }); assert.ok(!result.isError, 'DEBUG_FAILED'); return JSON.parse(result.content[0].text) }
const call = (name, args) => ({ id: randomUUID(), name, arguments: JSON.stringify(args) })
const step = (tools = [], text = '') => ({ text, toolCalls: tools, delayMs: 0 })
async function close() { await client?.close(); client = undefined; await instance?.close(); instance = undefined }
async function records() {
  const rows = []; const journals = join(profile, 'journals')
  for (const owner of await readdir(journals)) for (const file of await readdir(join(journals, owner))) if (file.endsWith('.jsonl')) for (const line of (await readFile(join(journals, owner, file), 'utf8')).trim().split('\n')) rows.push(JSON.parse(line))
  return rows
}
async function request(command) { assert.equal((await send({ type: 'flow.command.run', command })).status, 'accepted'); await waitFor((s) => s.heartFlow.command?.status === 'awaiting-approval', 'COMMAND_APPROVAL_MISSING'); return (await snapshot()).heartFlow.command.id }
async function terminal(id, status) { await waitFor((s) => s.heartFlow.command?.id === id && s.heartFlow.command.status === status, 'COMMAND_NOT_' + status) }
try {
  await mkdir(data, { recursive: true }); await writeFile(join(data, 'settings.json'), JSON.stringify({ version: 1, developer: true, booth: false, plugins: {}, sceneId }))
  await launch(); await debug('set_clock', { frozen: true }); await send({ type: 'mode.set', mode: 'quiet' }); await send({ type: 'flow.enter' }); await waitFor((s) => s.heartFlow?.activeId, 'FLOW_MISSING'); await send({ type: 'flow.mode', mode: 'execute' })
  assert.equal((await snapshot()).heartFlow.commandExecution, 'windows-appcontainer')
  const command = 'echo NATIVE_PRODUCT>native.txt & echo SAVED>delivered.txt & echo NATIVE_OUTPUT'
  await debug('set_fake_model', { script: [step([call('run_command', { command, timeoutMs: 5000 })]), step([], 'SYNTHETIC_COMMAND_FINISHED')] })
  await send({ type: 'message.send', text: 'Run the synthetic desk command after my approval.' }); await waitFor((s) => s.heartFlow.command?.status === 'awaiting-approval', 'TOOL_COMMAND_MISSING')
  const first = (await snapshot()).heartFlow.command; const workTurn = (await snapshot()).task.id
  await assert.rejects(readFile(join(desk, 'native.txt'))); assert.equal((await snapshot()).task.status, 'waiting-user')
  await page.locator('[data-desk-command="awaiting-approval"]').getByRole('button', { name: '运行这条命令', exact: true }).click()
  await terminal(first.id, 'completed'); await waitFor((s) => s.task?.id === workTurn && s.task.status === 'completed', 'COMMAND_TOOL_NOT_SETTLED')
  let state = await snapshot(); assert.equal(state.heartFlow.command.outcome.exitCode, 0); assert.equal(state.heartFlow.command.outcome.publication, 'applied'); assert.equal(state.heartFlow.command.outcome.appliedFiles, 2)
  assert.equal((await readFile(join(desk, 'native.txt'), 'utf8')).trim(), 'NATIVE_PRODUCT'); assert.equal((await readFile(join(desk, 'delivered.txt'), 'utf8')).trim(), 'SAVED')
  assert.equal('stdout' in state.heartFlow.command, false); assert.equal('stderr' in state.heartFlow.command, false)
  const window = instance.waitForEvent('window'); await page.getByRole('button', { name: '查看命令输出', exact: true }).click(); const preview = await window; await preview.waitForLoadState(); assert.ok((await preview.locator('pre').innerText()).includes('NATIVE_OUTPUT')); assert.equal(await preview.evaluate(() => typeof window.lca), 'undefined'); await preview.close()
  let rows = await records(); assert.ok(rows.some((r) => r.type === 'desk/change' && r.commandId === first.id)); assert.ok(!JSON.stringify(rows.filter((r) => r.type === 'flow/command')).includes('NATIVE_OUTPUT'))
  const input = rows.filter((r) => r.type === 'model/seen' && r.turnId === workTurn).at(-1); assert.deepEqual(input.eligibleIndexes, []); assert.ok(JSON.stringify(input).includes('NATIVE_OUTPUT'))
  assert.equal((await send({ type: 'flow.command.approve', commandId: first.id, allow: true })).status, 'rejected')

  const denied = await request('echo DENIED>denied.txt'); await page.getByRole('button', { name: '这次不运行', exact: true }).click(); await terminal(denied, 'cancelled'); await assert.rejects(readFile(join(desk, 'denied.txt')))
  const conflict = await request('echo REPLACED>native.txt'); await writeFile(join(desk, 'native.txt'), 'USER_CHANGED'); await send({ type: 'flow.command.approve', commandId: conflict, allow: true }); await terminal(conflict, 'failed'); assert.equal(await readFile(join(desk, 'native.txt'), 'utf8'), 'USER_CHANGED'); assert.ok(!(await records()).some((r) => r.type === 'flow/command' && r.id === conflict && r.status === 'running'))
  const nonzero = await request('echo PARTIAL>failed.txt & exit /b 7'); await send({ type: 'flow.command.approve', commandId: nonzero, allow: true }); await terminal(nonzero, 'failed'); assert.equal((await snapshot()).heartFlow.command.outcome.exitCode, 7); await assert.rejects(readFile(join(desk, 'failed.txt')))
  const invalidScript = '$stream=[Console]::OpenStandardOutput(); $stream.WriteByte(255)'; const invalid = await request('powershell.exe -NoProfile -NonInteractive -EncodedCommand ' + Buffer.from(invalidScript, 'utf16le').toString('base64'))
  assert.ok((await page.locator('[data-desk-command="awaiting-approval"] details pre').innerText()).includes('WriteByte(255)')); await page.getByRole('button', { name: '运行这条命令', exact: true }).click(); await terminal(invalid, 'failed'); assert.equal((await snapshot()).heartFlow.command.error.code, 'command-encoding-unsupported')
  const cancelled = await request('powershell.exe -NoProfile -NonInteractive -Command "Start-Sleep -Seconds 20"'); await send({ type: 'flow.command.approve', commandId: cancelled, allow: true }); await waitFor((s) => s.heartFlow.command?.status === 'running', 'COMMAND_NOT_RUNNING'); await send({ type: 'flow.command.cancel', commandId: cancelled }); await terminal(cancelled, 'cancelled')

  await debug('set_fake_model', { script: [step([call('run_command', { command: 'echo STOPPED>stopped.txt' })]), step([], 'SHOULD_NOT_ADVANCE')] }); await send({ type: 'message.send', text: 'stop this model-owned command before approval' }); await waitFor((s) => s.heartFlow.command?.status === 'awaiting-approval', 'STOP_APPROVAL_MISSING'); const stopTask = (await snapshot()).task.id
  await send({ type: 'turn.stop', taskId: stopTask }); await waitFor((s) => s.task?.status === 'aborted' && s.heartFlow.command?.status === 'cancelled', 'MODEL_COMMAND_NOT_STOPPED'); await assert.rejects(readFile(join(desk, 'stopped.txt')))
  await request('echo REPLAYED>replay.txt'); const runs = (await records()).filter((r) => r.type === 'flow/command' && r.status === 'running').length; await close(); await launch()
  assert.ok(!(await snapshot()).heartFlow.command); assert.equal((await records()).filter((r) => r.type === 'flow/command' && r.status === 'running').length, runs); await assert.rejects(readFile(join(desk, 'replay.txt')))

  await send({ type: 'flow.exit' }); const summary = JSON.parse((await records()).findLast((r) => r.type === 'flow/close').summary); assert.equal(summary.commandRequestCount, 8); assert.ok(summary.commandEvidence.length > 0); assert.ok(!JSON.stringify(summary).includes('NATIVE_OUTPUT'))
  await debug('set_fake_model', { script: [step([], 'ordinary response')] }); await send({ type: 'message.send', text: 'ordinary conversation after work' }); await waitFor((s) => s.task?.status === 'completed', 'ORDINARY_NOT_SETTLED')
  rows = await records(); const ordinary = rows.filter((r) => r.type === 'model/seen').at(-1); assert.ok(!JSON.stringify(ordinary).includes('NATIVE_PRODUCT')); assert.ok(!JSON.stringify(ordinary).includes('NATIVE_OUTPUT'))
  const archive = join(data, 'commands.lca-save'); await instance.evaluate(({ dialog }, file) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: file }) }, archive); await send({ type: 'backup.export' }); await waitFor((s) => s.backup.status === 'exported', 'COMMAND_EXPORT_FAILED')
  await instance.evaluate(({ dialog, app }, file) => { app.relaunch = () => {}; dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }) }, archive); await send({ type: 'backup.import' }); await waitFor((s) => s.backup.status === 'awaiting-confirmation', 'COMMAND_IMPORT_FAILED')
  const restoreId = (await snapshot()).backup.restoreId; await client.close(); client = undefined; const closed = instance.waitForEvent('close'); await send({ type: 'backup.restore', restoreId }); await closed; instance = undefined; await launch()
  assert.equal((await readFile(join(desk, 'delivered.txt'), 'utf8')).trim(), 'SAVED'); assert.ok(!(await snapshot()).heartFlow.command)
  await close(); instance = await _electron.launch({ ...electronLaunchTarget(root, electronPath), env: { ...runtimeEnv(root), LCA_DATA_DIR: join(data, 'booth'), LCA_PROVIDERS_FILE: join(data, 'absent.json'), LCA_BOOTH: '1' } }); page = await instance.firstWindow(); await initializeTestBook(page)
  await send({ type: 'flow.enter' }); await waitFor((s) => s.heartFlow.activeId, 'BOOTH_FLOW_MISSING'); await send({ type: 'flow.mode', mode: 'execute' }); assert.equal((await snapshot()).heartFlow.commandExecution, 'disabled'); assert.equal((await send({ type: 'flow.command.run', command: 'echo MUST_NOT_RUN' })).error.code, 'permission-denied')
  console.log(JSON.stringify({ ok: true, probe: 'desk-command-electron', source: 'fake-model-real-command', appContainer: true, uiApproval: true, decodedScriptReview: true, durablePublication: true, privateOutputPreview: true, denied: true, conflictBeforeExecution: true, nonzeroNoPublication: true, invalidEncodingRejected: true, cancel: true, taskStop: true, restartNoReplay: true, ordinaryContextIsolation: true, privateRestore: true, boothDisabled: true }))
} finally { await close() }
