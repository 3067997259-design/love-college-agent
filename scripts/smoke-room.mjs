import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, writeFile, readFile, readdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron } from 'playwright'
import electronPath from 'electron'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { runtimeEnv, initializeTestBook } from './runtime-env.mjs'
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..'); const data = join(root, '.local-data', 'room-smoke-' + randomUUID()); let sceneId = randomUUID()
const env = { ...runtimeEnv(root), LCA_DATA_DIR: data, LCA_PROVIDERS_FILE: join(data, 'absent.json'), LCA_CDP_PORT: '19541', LCA_MCP_PORT: '0' }; let instance; let page; let client
async function launch() { instance = await _electron.launch({ executablePath: electronPath, args: [root], env }); page = await instance.firstWindow(); await initializeTestBook(page)
  const config = JSON.parse(await readFile(join(data, 'developer', sceneId, 'debug-connection.json'), 'utf8')); client = new Client({ name: 'room-smoke', version: '1.0.0' }); await client.connect(new StreamableHTTPClientTransport(new URL(config.url), { requestInit: { headers: { Authorization: 'Bearer ' + config.token } } })) }
const snapshot = () => page.evaluate(() => window.lca.getSnapshot())
const send = (body) => page.evaluate(async (body) => { const s = await window.lca.getSnapshot(); return window.lca.dispatch({ protocolVersion: 1, epoch: s.epoch, requestId: crypto.randomUUID(), ...body }) }, body)
async function waitFor(test, message) { for (let i = 0; i < 120; i++) { if (test(await snapshot())) return; await new Promise((done) => setTimeout(done, 100)) }; throw new Error(message) }
async function debug(name, args = {}) { const result = await client.callTool({ name, arguments: args }); assert.ok(!result.isError); return JSON.parse(result.content[0].text) }
try {
  await mkdir(data, { recursive: true }); await writeFile(join(data, 'settings.json'), JSON.stringify({ version: 1, developer: true, booth: false, plugins: {}, sceneId }))
  await mkdir(join(data, 'developer', sceneId), { recursive: true }); await writeFile(join(data, 'developer', sceneId, 'clock.json'), JSON.stringify({ nowMs: Date.parse('2026-10-16T12:00:00+08:00'), rate: 1, frozen: true }))
  await launch(); await debug('set_clock', { nowMs: Date.parse('2026-10-16T12:00:00+08:00'), frozen: true }); await debug('set_fake_model', { script: [{ text: '合成共同经历', toolCalls: [], delayMs: 0 }] })
  await send({ type: 'message.send', text: '我把纸桥放在书桌上，给它取名叫周五桥。' }); await waitFor((s) => s.task?.status === 'completed', 'ROOM_CONTEXT_FAILED')
  await debug('set_clock', { nowMs: Date.parse('2026-10-17T12:00:00+08:00') }); await waitFor((s) => s.session.dayKey === '2026-10-17', 'DIARY_ROLLOVER_FAILED'); await send({ type: 'diary.write' }); await waitFor((s) => s.diary.entries.length > 0, 'DIARY_WRITE_FAILED')
  const id = (await snapshot()).diary.entries[0].id
  assert.equal(await page.evaluate(async (id) => { try { await window.lca.readDiary(id); return false } catch { return true } }, id), true)
  await debug('set_clock', { nowMs: Date.parse('2026-10-18T12:00:00+08:00') }); const entry = await page.evaluate((id) => window.lca.readDiary(id), id)
  assert.ok(entry.subjective); assert.ok(entry.key); assert.ok(entry.text); assert.ok(!JSON.stringify(await snapshot()).includes(entry.key)); assert.ok(!JSON.stringify(await debug('get_context')).includes(entry.text))
  await page.getByRole('button', { name: '工具与设置', exact: true }).click(); await page.getByRole('button', { name: '用户查阅日记', exact: true }).first().click(); await page.getByRole('article', { name: '用户独占日记' }).waitFor()
  await send({ type: 'room.rebuild' }); const rooms = join(data, 'developer', sceneId, 'rooms'); const room = join(rooms, (await readdir(rooms))[0]); const encrypted = await readFile(join(room, '日记', '2026-10-16.zip')); assert.ok(!encrypted.includes(Buffer.from(entry.text)))
  const archive = join(data, 'room.lca-save'); await instance.evaluate(({ dialog }, file) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: file }) }, archive); await send({ type: 'backup.export' }); await waitFor((s) => s.backup.status === 'exported', 'ROOM_EXPORT_FAILED')
  // A projection file that no longer belongs to the log must disappear on rebuild, while the desk stays untouched.
  const staleDiary = join(room, '日记', '2026-10-19.zip'); await writeFile(staleDiary, 'STALE_PROJECTION')
  const staleLog = join(room, '运行记录', '2026-10-19.md'); await writeFile(staleLog, 'STALE_PROJECTION'); const deskNote = join(room, '书桌', '用户笔记.md'); await writeFile(deskNote, 'USER_NOTE')
  await send({ type: 'room.rebuild' })
  assert.equal(existsSync(staleDiary), false); assert.equal(existsSync(staleLog), false); assert.equal(await readFile(deskNote, 'utf8'), 'USER_NOTE')
  await client.close(); client = undefined; await instance.close(); sceneId = randomUUID(); await writeFile(join(data, 'settings.json'), JSON.stringify({ version: 1, developer: true, booth: false, plugins: {}, sceneId }))
  await launch(); await instance.evaluate(({ dialog, app }, file) => { app.relaunch = () => {}; dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }) }, archive)
  await send({ type: 'backup.import' }); await waitFor((s) => s.backup.status === 'awaiting-confirmation', 'ROOM_IMPORT_FAILED'); const restoreId = (await snapshot()).backup.restoreId
  await client.close(); client = undefined; const closed = instance.waitForEvent('close'); await send({ type: 'backup.restore', restoreId }); await closed; await launch(); await debug('set_clock', { nowMs: Date.parse('2026-10-18T12:00:00+08:00'), frozen: true })
  const restored = await page.evaluate((id) => window.lca.readDiary(id), id); assert.deepEqual(restored, entry)
  const restoredRooms = join(data, 'developer', sceneId, 'rooms'); const restoredRoom = join(restoredRooms, (await readdir(restoredRooms))[0]); assert.deepEqual(await readFile(join(restoredRoom, '日记', '2026-10-16.zip')), encrypted)
  console.log('Room Electron: seen-only fake diary, locked then user-only key/read, metadata-only snapshots/debug, actual encrypted ZIP projection, native private export/import and unchanged key/ciphertext regeneration verified.')
} finally { await client?.close(); await instance?.close() }
