import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron } from 'playwright'
import electronPath from 'electron'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { runtimeEnv, initializeTestBook, electronLaunchTarget, openSettings } from './runtime-env.mjs'
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..'); const data = join(root, '.local-data', 'drafts-smoke-' + randomUUID()); const sceneId = randomUUID(); const profile = join(data, 'developer', sceneId)
const env = { ...runtimeEnv(root), LCA_DATA_DIR: data, LCA_PROVIDERS_FILE: join(data, 'absent.json'), LCA_CDP_PORT: '19548', LCA_MCP_PORT: '0' }
let instance; let page; let client
const snapshot = () => page.evaluate(() => window.lca.getSnapshot())
const send = (body, requestId = randomUUID()) => page.evaluate(async ({ body, requestId }) => { const s = await window.lca.getSnapshot(); return window.lca.dispatch({ protocolVersion: 1, epoch: s.epoch, requestId, ...body }) }, { body, requestId })
async function waitFor(test, message) { for (let i = 0; i < 200; i++) { if (test(await snapshot())) return; await new Promise((done) => setTimeout(done, 100)) }; throw new Error(message) }
async function launch() {
  instance = await _electron.launch({ ...electronLaunchTarget(root, electronPath), env }); page = await instance.firstWindow(); await initializeTestBook(page)
  const config = JSON.parse(await readFile(join(profile, 'debug-connection.json'), 'utf8')); client = new Client({ name: 'draft-smoke', version: '1.0.0' })
  await client.connect(new StreamableHTTPClientTransport(new URL(config.url), { requestInit: { headers: { Authorization: 'Bearer ' + config.token } } }))
}
const debug = async (name, args = {}) => { const result = await client.callTool({ name, arguments: args }); assert.ok(!result.isError, 'DEBUG_FAILED'); return JSON.parse(result.content[0].text) }
const call = (name, args, id) => ({ id, name, arguments: JSON.stringify(args) })
const step = (tools = [], text = '', delayMs = 0) => ({ text, toolCalls: tools, delayMs })
async function script(steps) { await debug('set_fake_model', { script: steps }) }
async function close() { await client?.close(); client = undefined; await instance?.close(); instance = undefined }
const op = (s, id) => s.heartFlow.operations.find((row) => row.id === id)
try {
  await mkdir(data, { recursive: true }); await writeFile(join(data, 'settings.json'), JSON.stringify({ version: 1, developer: true, booth: false, plugins: {}, sceneId }))
  await launch(); await debug('set_clock', { frozen: true }); await send({ type: 'mode.set', mode: 'quiet' })
  assert.equal((await send({ type: 'flow.enter' })).status, 'accepted'); await waitFor((s) => s.heartFlow.activeId, 'FLOW_MISSING')
  assert.equal((await send({ type: 'flow.init' })).error.code, 'permission-denied'); await send({ type: 'flow.mode', mode: 'execute' })
  await script([step([call('desk_write', { path: 'project.md', text: 'PRIVATE_SYNTHETIC_PROJECT_SOURCE' }, 'source')]), step([], 'source saved')])
  await send({ type: 'message.send', text: 'Write synthetic project.md on the desk.' }); await waitFor((s) => s.task?.status === 'completed' && s.heartFlow.files.some((file) => file.path === 'project.md'), 'SOURCE_NOT_WRITTEN')
  const initId = randomUUID(); const output = `工作草稿/${initId}.md`; const product = '# Synthetic project note\nPRIVATE_DRAFT_PRODUCT\nCoverage: one source, zero omitted. Unreviewed.'
  await script([step([call('desk_read', { path: 'project.md' }, 'read')]), step([call('desk_write', { path: output, text: product }, 'write')]), step([], 'draft written')])
  assert.equal((await send({ type: 'message.send', text: '/init' }, initId)).status, 'accepted'); await waitFor((s) => op(s, initId)?.status === 'ready', 'INIT_NOT_READY')
  const folders = await readdir(join(profile, 'rooms')); assert.equal(folders.length, 1); const desk = join(profile, 'rooms', folders[0], '书桌')
  assert.equal(await readFile(join(desk, output), 'utf8'), product)
  let created = instance.waitForEvent('window'); assert.equal((await send({ type: 'flow.operation.open', operationId: initId })).status, 'accepted'); let preview = await created; await preview.waitForLoadState()
  assert.equal(await preview.locator('pre').innerText(), product); assert.equal(await preview.evaluate(() => typeof window.lca), 'undefined'); await preview.close()
  let state = await snapshot(); assert.ok(!JSON.stringify(state.heartFlow).includes('PRIVATE_DRAFT_PRODUCT')); assert.ok(!JSON.stringify(state.heartFlow).includes('PRIVATE_SYNTHETIC_PROJECT_SOURCE'))
  const reviewId = randomUUID(); const reviewPath = `工作草稿/${reviewId}.md`
  await script([step([call('desk_write', { path: reviewPath, text: '# Draft findings\nScope: applied desk changes only. Tests were not run. PRIVATE_REVIEW_PRODUCT' }, 'review')]), step([], 'review draft saved')])
  assert.equal((await send({ type: 'message.send', text: '/review' }, reviewId)).status, 'accepted'); await waitFor((s) => op(s, reviewId)?.status === 'ready', 'REVIEW_NOT_READY')
  assert.equal(op(await snapshot(), reviewId).sourceCount, 2)
  // Reopened review coverage: two edits on the same file must retain the original deletion even
  // after ordinary tool context is compacted. Observe the actual successful native model inputs.
  const guard = 'if (!user.allowed) throw new Error("deny");\nreturn transfer();'; await writeFile(join(desk, 'transfer.js'), guard)
  for (const text of ['return transfer();', '// comment only in the second edit\nreturn transfer();']) {
    await script([step([call('desk_write', { path: 'transfer.js', text }, 'edit-transfer')]), step([], 'synthetic edit saved')]); await send({ type: 'message.send', text: 'Apply the next synthetic desk edit.' }); await waitFor((s) => s.task?.status === 'completed', 'ITERATED_WRITE_FAILED')
  }
  await send({ type: 'flow.compact' }); const netId = randomUUID(); const netPath = `工作草稿/${netId}.md`
  await script([step([call('desk_write', { path: netPath, text: 'Unreviewed finding: inspect the removed permission check in transfer.js; tests not run.' }, 'net-review')]), step([], 'net-diff draft saved')])
  await send({ type: 'flow.review' }, netId); await waitFor((s) => op(s, netId)?.status === 'ready', 'NET_REVIEW_NOT_READY')
  const records = []; const journals = join(profile, 'journals'); for (const owner of await readdir(journals)) for (const file of await readdir(join(journals, owner))) if (file.endsWith('.jsonl')) for (const line of (await readFile(join(journals, owner, file), 'utf8')).trim().split('\n')) records.push(JSON.parse(line))
  const turnId = records.findLast((row) => row.type === 'flow/operation' && row.operation.id === netId).operation.turnId
  const inputs = records.filter((row) => row.type === 'model/seen' && row.turnId === turnId); assert.equal(inputs.length, 2)
  for (const input of inputs) { const data = input.messages.flatMap((message) => { try { return JSON.parse(message.content).userRequestedFlowDraft ?? [] } catch { return [] } })[0]; const diff = data.reviewDiffs.find((row) => row.path === 'transfer.js').diff; assert.equal(diff.before, guard); assert.equal(diff.after, '// comment only in the second edit\nreturn transfer();'); assert.equal(diff.steps, 2); assert.equal(diff.externalEditsObserved, false); assert.deepEqual(input.eligibleIndexes, []) }
  const claimId = randomUUID(); await script([step([], 'I completed it.')]); await send({ type: 'flow.init' }, claimId); await waitFor((s) => op(s, claimId)?.status === 'failed', 'FALSE_COMPLETION_ACCEPTED')
  assert.equal(op(await snapshot(), claimId).error, 'source-changed') // no source reads and no artifact
  const scopeId = randomUUID(); await script([step([call('desk_web_fetch', { url: 'https://public.synthetic.invalid/blocked-draft-scope' }, 'outside-draft')]), step([], 'No permitted draft output.')]); await send({ type: 'flow.init' }, scopeId); await waitFor((s) => op(s, scopeId)?.status === 'failed', 'DRAFT_EXTERNAL_SCOPE_NOT_SETTLED'); assert.equal((await snapshot()).heartFlow.webFetch.pending, undefined); assert.equal((await snapshot()).heartFlow.webFetch.requestsUsed, 0)
  const cancelId = randomUUID(); const cancelPath = `工作草稿/${cancelId}.md`
  await script([step([call('desk_write', { path: cancelPath, text: 'LATE_WRITE_MUST_NOT_HAPPEN' }, 'late')], '', 2000)])
  await send({ type: 'flow.init' }, cancelId); await waitFor((s) => op(s, cancelId)?.status === 'running' && s.task?.status === 'running', 'CANCEL_JOB_NOT_RUNNING')
  await send({ type: 'turn.stop', taskId: (await snapshot()).task.id }); await waitFor((s) => op(s, cancelId)?.status === 'cancelled' && s.task?.status === 'aborted', 'CANCEL_NOT_SETTLED')
  assert.ok(!(await snapshot()).heartFlow.files.some((file) => file.path === cancelPath))
  await close(); await launch(); assert.equal(op(await snapshot(), initId).status, 'ready'); assert.equal(op(await snapshot(), reviewId).status, 'ready'); assert.equal(op(await snapshot(), cancelId).status, 'cancelled')
  await send({ type: 'flow.exit' }); await waitFor((s) => !s.heartFlow.activeId, 'FLOW_NOT_CLOSED')
  await openSettings(page)
  const archive = join(data, 'drafts.lca-save'); await instance.evaluate(({ dialog }, path) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: path }) }, archive)
  await send({ type: 'backup.export' }); await waitFor((s) => s.backup.status === 'exported', 'DRAFT_BACKUP_FAILED')
  await writeFile(join(desk, output), 'EXTERNAL_EDIT_AFTER_SAVE')
  await instance.evaluate(({ dialog }, path) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] }) }, archive)
  await send({ type: 'backup.import' }); await waitFor((s) => s.backup.status === 'awaiting-confirmation', 'IMPORT_NOT_READY')
  await instance.evaluate(({ app }) => { app.relaunch = () => {} }); const closed = instance.waitForEvent('close')
  await client.close(); client = undefined; await page.getByRole('alertdialog', { name: '恢复私人存档确认' }).getByRole('button', { name: '备份当前数据并恢复', exact: true }).click(); await closed; instance = undefined
  await launch(); assert.equal(op(await snapshot(), initId).status, 'ready'); assert.equal(await readFile(join(desk, output), 'utf8'), product)
  await script([step([], 'ordinary synthetic response')]); await send({ type: 'message.send', text: '普通聊天恢复。' }); await waitFor((s) => s.task?.status === 'completed', 'ORDINARY_NOT_DONE')
  const context = JSON.stringify(await debug('get_context')); for (const marker of ['PRIVATE_DRAFT_PRODUCT', 'PRIVATE_SYNTHETIC_PROJECT_SOURCE', 'PRIVATE_REVIEW_PRODUCT']) assert.ok(!context.includes(marker), 'WORK_IN_ORDINARY_CONTEXT')
  await writeFile(join(desk, output), 'EXTERNAL_EDIT_PRESERVED'); await close(); await launch()
  assert.equal(op(await snapshot(), initId).status, 'failed'); assert.equal((await send({ type: 'flow.operation.open', operationId: initId })).status, 'rejected'); assert.equal(await readFile(join(desk, output), 'utf8'), 'EXTERNAL_EDIT_PRESERVED')
  console.log('Flow drafts Electron: plan refusal; real desk read/write and native private preview; bounded review diffs; claim-only failure; stop prevents late write; restart and private-save restoration; ordinary context exclusion; external edits preserved. Fake model and synthetic sources only.')
} finally { await close() }
