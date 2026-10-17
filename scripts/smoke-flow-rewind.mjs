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
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..'); const data = join(root, '.local-data', 'flow-rewind-' + randomUUID()); const sceneId = randomUUID(); const profile = join(data, 'developer', sceneId)
const env = { ...runtimeEnv(root), LCA_DATA_DIR: data, LCA_PROVIDERS_FILE: join(data, 'absent.json'), LCA_CDP_PORT: '19569', LCA_MCP_PORT: '0' }
let instance; let page; let client; let desk
const snapshot = () => page.evaluate(() => window.lca.getSnapshot())
const send = (body) => page.evaluate(async (body) => { const s = await window.lca.getSnapshot(); return window.lca.dispatch({ protocolVersion: 1, epoch: s.epoch, requestId: crypto.randomUUID(), ...body }) }, body)
async function accept(body) { assert.equal((await send(body)).status, 'accepted', body.type) }
async function waitFor(test, message) { for (let i = 0; i < 200; i++) { if (test(await snapshot())) return; await new Promise((done) => setTimeout(done, 100)) }; throw new Error(message) }
async function launch() {
  instance = await _electron.launch({ ...electronLaunchTarget(root, electronPath), env }); page = await instance.firstWindow(); await initializeTestBook(page)
  const connection = JSON.parse(await readFile(join(profile, 'debug-connection.json'), 'utf8')); client = new Client({ name: 'rewind-smoke', version: '1.0.0' })
  await client.connect(new StreamableHTTPClientTransport(new URL(connection.url), { requestInit: { headers: { Authorization: 'Bearer ' + connection.token } } }))
  const rooms = await readdir(join(profile, 'rooms')); assert.equal(rooms.length, 1); desk = join(profile, 'rooms', rooms[0], '书桌')
}
async function close() { await client?.close(); client = undefined; await instance?.close(); instance = undefined }
async function debug(name, args) { const result = await client.callTool({ name, arguments: args }); assert.ok(!result.isError); return JSON.parse(result.content[0].text) }
async function writes(entries) {
  await debug('set_fake_model', { script: [...entries.map(([path, text]) => ({ text: '', toolCalls: [{ id: randomUUID(), name: 'desk_write', arguments: JSON.stringify({ path, text }) }], delayMs: 0 })), { text: 'SYNTHETIC_REWIND_WORK', toolCalls: [], delayMs: 0 }] })
  await accept({ type: 'message.send', text: 'Synthetic recorded file edits' }); await waitFor((s) => s.task?.status === 'completed', 'WORK_NOT_COMPLETED')
}
async function records() {
  const rows = []; const journals = join(profile, 'journals')
  for (const owner of await readdir(journals)) for (const file of await readdir(join(journals, owner))) if (file.endsWith('.jsonl')) for (const line of (await readFile(join(journals, owner, file), 'utf8')).trim().split('\n')) rows.push(JSON.parse(line))
  return rows
}
try {
  await mkdir(data, { recursive: true }); await writeFile(join(data, 'settings.json'), JSON.stringify({ version: 1, developer: true, booth: false, plugins: {}, sceneId }))
  await launch(); await debug('set_clock', { frozen: true }); await accept({ type: 'mode.set', mode: 'quiet' }); await accept({ type: 'flow.enter' }); await waitFor((s) => s.heartFlow.activeId, 'FLOW_MISSING'); await accept({ type: 'flow.mode', mode: 'execute' })
  await writeFile(join(desk, 'rewind-a.txt'), 'SYNTHETIC_BASELINE')
  await writes([['rewind-a.txt', 'a1'], ['rewind-b.txt', 'b1'], ['rewind-a.txt', 'a2']])
  const boundary = (await snapshot()).heartFlow.changes.find((change) => change.path === 'rewind-a.txt').id
  await page.locator('.flow-changes li').filter({ hasText: 'rewind-a.txt' }).last().getByRole('button', { name: '从这里往后回退', exact: true }).click()
  await waitFor((s) => s.heartFlow.rewind?.status === 'awaiting-confirmation', 'PREVIEW_MISSING'); let view = (await snapshot()).heartFlow.rewind
  assert.equal(view.changeId, boundary); assert.equal(view.changeCount, 3); assert.deepEqual([...view.paths].sort(), ['rewind-a.txt', 'rewind-b.txt']); assert.equal(view.appliedFiles, 0)
  assert.equal(await readFile(join(desk, 'rewind-a.txt'), 'utf8'), 'a2'); assert.equal(await readFile(join(desk, 'rewind-b.txt'), 'utf8'), 'b1')
  await page.getByRole('button', { name: '确认回退这些文件', exact: true }).click(); await waitFor((s) => s.heartFlow.rewind?.status === 'completed', 'REWIND_NOT_COMPLETED')
  assert.equal((await snapshot()).heartFlow.rewind.appliedFiles, 2); assert.equal(await readFile(join(desk, 'rewind-a.txt'), 'utf8'), 'SYNTHETIC_BASELINE'); await assert.rejects(readFile(join(desk, 'rewind-b.txt')), { code: 'ENOENT' })
  assert.ok((await snapshot()).heartFlow.changes.every((change) => change.undone)); assert.ok((await page.evaluate(() => window.lca.readHeartFlow({ section: 'diff' }))).changes.every((change) => change.undone))
  assert.equal((await send({ type: 'flow.rewind.apply', rewindId: view.id })).status, 'rejected')
  await writes([['rewind-c.txt', 'c'], ['rewind-d.txt', 'd']]); await accept({ type: 'message.send', text: '/undo' }); await waitFor((s) => s.heartFlow.rewind?.status === 'awaiting-confirmation', 'SLASH_UNDO_DID_NOT_PREVIEW')
  assert.deepEqual((await snapshot()).heartFlow.rewind.paths, ['rewind-d.txt']); await page.getByRole('button', { name: '取消回退', exact: true }).click()
  await waitFor((s) => s.heartFlow.rewind?.status === 'cancelled', 'CANCEL_NOT_RECORDED'); assert.equal(await readFile(join(desk, 'rewind-d.txt'), 'utf8'), 'd')
  const c = (await snapshot()).heartFlow.changes.find((change) => change.path === 'rewind-c.txt').id; await accept({ type: 'flow.rewind.prepare', changeId: c }); view = (await snapshot()).heartFlow.rewind
  await writeFile(join(desk, 'rewind-d.txt'), 'USER_EDITED'); assert.equal((await send({ type: 'flow.rewind.apply', rewindId: view.id })).status, 'rejected')
  assert.equal((await snapshot()).heartFlow.rewind.appliedFiles, 0); assert.equal(await readFile(join(desk, 'rewind-c.txt'), 'utf8'), 'c'); assert.equal(await readFile(join(desk, 'rewind-d.txt'), 'utf8'), 'USER_EDITED')
  await writeFile(join(desk, 'rewind-d.txt'), 'd'); await accept({ type: 'flow.rewind.prepare', changeId: c }); const pending = (await snapshot()).heartFlow.rewind.id
  assert.equal((await send({ type: 'backup.export' })).status, 'rejected') // Active flow is an existing save boundary.
  const changes = (await records()).filter((row) => row.type === 'desk/change').length; await close(); await launch()
  assert.equal((await snapshot()).heartFlow.rewind.status, 'cancelled'); assert.equal(await page.getByRole('button', { name: '确认回退这些文件', exact: true }).count(), 0)
  assert.equal((await records()).filter((row) => row.type === 'desk/change').length, changes); assert.equal(await readFile(join(desk, 'rewind-c.txt'), 'utf8'), 'c')
  assert.equal((await send({ type: 'flow.rewind.apply', rewindId: pending })).status, 'rejected')
  const flowId = (await snapshot()).heartFlow.activeId; const workTurns = new Set((await records()).filter((row) => row.type === 'model/seen').map((row) => row.turnId))
  await accept({ type: 'flow.exit' }); await debug('set_fake_model', { script: [{ text: 'SYNTHETIC_ORDINARY_AFTER_REWIND', toolCalls: [], delayMs: 0 }] })
  await accept({ type: 'message.send', text: 'Ordinary conversation after recorded rewind' }); await waitFor((s) => s.task?.status === 'completed', 'ORDINARY_NOT_SETTLED')
  const ordinary = (await records()).filter((row) => row.type === 'model/seen').at(-1); assert.ok(!JSON.stringify(ordinary).includes('SYNTHETIC_BASELINE'))
  const archive = join(data, 'rewind.lca-save'); await instance.evaluate(({ dialog }, file) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: file }) }, archive)
  await accept({ type: 'backup.export' }); await waitFor((s) => s.backup.status === 'exported', 'EXPORT_FAILED')
  await instance.evaluate(({ dialog, app }, file) => { app.relaunch = () => {}; dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }) }, archive)
  await accept({ type: 'backup.import' }); await waitFor((s) => s.backup.status === 'awaiting-confirmation', 'IMPORT_FAILED'); const restoreId = (await snapshot()).backup.restoreId
  await client.close(); client = undefined; const closed = instance.waitForEvent('close'); await accept({ type: 'backup.restore', restoreId }); await closed; instance = undefined; await launch()
  assert.equal((await snapshot()).heartFlow.activeId, null); assert.equal((await snapshot()).heartFlow.rewind, undefined)
  assert.equal(await readFile(join(desk, 'rewind-a.txt'), 'utf8'), 'SYNTHETIC_BASELINE'); assert.equal(await readFile(join(desk, 'rewind-c.txt'), 'utf8'), 'c')
  const rows = await records(); assert.equal(rows.filter((row) => row.type === 'desk/change').length, changes)
  const restored = await page.evaluate((flowId) => window.lca.readHeartFlow({ section: 'diff', flowId }), flowId); assert.equal(restored.changes.filter((change) => change.undone).length, 3)
  assert.ok(rows.some((row) => row.type === 'flow/rewind' && row.status === 'cancelled' && row.appliedFiles === 0))
  for (const row of rows.filter((row) => row.type === 'model/seen' && workTurns.has(row.turnId))) assert.deepEqual(row.eligibleIndexes, [])
  await accept({ type: 'flow.enter' }); await waitFor((s) => s.heartFlow.activeId, 'SECOND_FLOW_MISSING'); await accept({ type: 'flow.mode', mode: 'execute' })
  await writes([['inverse-a.txt', 'A'], ['inverse-b.txt', 'B']])
  const inverseA = (await snapshot()).heartFlow.changes.find((change) => change.path === 'inverse-a.txt').id
  const inverseB = (await snapshot()).heartFlow.changes.find((change) => change.path === 'inverse-b.txt').id
  await accept({ type: 'flow.undo', changeId: inverseA }); await accept({ type: 'flow.rewind.prepare', changeId: inverseB })
  await accept({ type: 'flow.rewind.apply', rewindId: (await snapshot()).heartFlow.rewind.id }); await waitFor((s) => s.heartFlow.rewind?.status === 'completed', 'INVERSE_REWIND_FAILED')
  assert.equal(await readFile(join(desk, 'inverse-a.txt'), 'utf8'), 'A'); await assert.rejects(readFile(join(desk, 'inverse-b.txt')), { code: 'ENOENT' })
  await close(); await launch()
  assert.equal((await snapshot()).heartFlow.changes.find((change) => change.id === inverseA).undone, false)
  assert.equal((await page.evaluate(() => window.lca.readHeartFlow({ section: 'diff' }))).changes.find((change) => change.id === inverseA).undone, false)
  assert.equal(await page.locator('.flow-changes li').filter({ hasText: 'inverse-a.txt' }).getByRole('button', { name: '从这里往后回退', exact: true }).count(), 1)
  await accept({ type: 'message.send', text: '/undo' }); await waitFor((s) => s.heartFlow.rewind?.status === 'awaiting-confirmation', 'INVERSE_SLASH_UNDO_FAILED')
  assert.equal((await snapshot()).heartFlow.rewind.changeId, inverseA); await accept({ type: 'flow.rewind.cancel', rewindId: (await snapshot()).heartFlow.rewind.id })
  await accept({ type: 'flow.undo', changeId: inverseA }); await assert.rejects(readFile(join(desk, 'inverse-a.txt')), { code: 'ENOENT' })
  console.log(JSON.stringify({ ok: true, probe: 'flow-rewind', nativeSQLite: true, source: 'synthetic', uiBoundaryAndConfirmation: true, repeatedEditsAndMultipleFiles: true, staleVersionNoWrites: true, slashPreview: true, cancel: true, restartNoReplay: true, privateRestoreNoReplay: true, workIsolation: true }))
} finally { await close() }
