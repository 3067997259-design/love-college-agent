import assert from 'node:assert/strict'
import { randomUUID, createHash } from 'node:crypto'
import { mkdir, writeFile, readFile, readdir, unlink } from 'node:fs/promises'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron } from 'playwright'
import electronPath from 'electron'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { runtimeEnv, initializeTestBook } from './runtime-env.mjs'
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..'); const data = join(root, '.local-data', 'life-work-' + randomUUID()); let sceneId = randomUUID()
const env = { ...runtimeEnv(root), LCA_DATA_DIR: data, LCA_PROVIDERS_FILE: join(data, 'absent.json'), LCA_CDP_PORT: '19551', LCA_MCP_PORT: '0' }
const initialTime = Date.parse('2026-10-17T10:00:00+08:00'); let instance; let page; let client; let now = initialTime
const hash = (text) => createHash('sha256').update(text).digest('hex')
async function profile(time) {
  await mkdir(data, { recursive: true }); await writeFile(join(data, 'settings.json'), JSON.stringify({ version: 1, developer: true, booth: false, plugins: {}, sceneId }))
  await mkdir(join(data, 'developer', sceneId), { recursive: true }); await writeFile(join(data, 'developer', sceneId, 'clock.json'), JSON.stringify({ nowMs: time, rate: 1, frozen: true }))
}
async function launch() {
  instance = await _electron.launch({ executablePath: electronPath, args: [root], env }); page = await instance.firstWindow(); await initializeTestBook(page)
  const config = JSON.parse(await readFile(join(data, 'developer', sceneId, 'debug-connection.json'), 'utf8')); client = new Client({ name: 'life-work-smoke', version: '1.0.0' })
  await client.connect(new StreamableHTTPClientTransport(new URL(config.url), { requestInit: { headers: { Authorization: 'Bearer ' + config.token } } }))
}
const snapshot = () => page.evaluate(() => window.lca.getSnapshot())
const work = async () => (await snapshot()).life.work
const send = (body) => page.evaluate(async (body) => { const s = await window.lca.getSnapshot(); return window.lca.dispatch({ protocolVersion: 1, epoch: s.epoch, requestId: crypto.randomUUID(), ...body }) }, body)
async function accepted(body) { const result = await send(body); assert.equal(result.status, 'accepted', body.type + ':' + JSON.stringify(result)) }
async function debug(name, args = {}) { const result = await client.callTool({ name, arguments: args }); assert.ok(!result.isError); return JSON.parse(result.content[0].text) }
async function advance(ms = 5000) { now += ms; await debug('set_clock', { nowMs: now, frozen: true }) }
async function waitFor(test, message) { for (let i = 0; i < 100; i++) { if (test(await snapshot())) return; await new Promise((done) => setTimeout(done, 100)) }; throw new Error(message) }
async function room() { const rooms = join(data, 'developer', sceneId, 'rooms'); return join(rooms, (await readdir(rooms))[0]) }
async function stop() { await client?.close(); client = undefined; await instance?.close(); instance = undefined }
const job = (view, kind) => view.life.work.jobs.find((job) => job.kind === kind)
try {
  await profile(now); await launch(); await debug('set_clock', { nowMs: now, frozen: true })
  await page.getByRole('button', { name: '工具与设置', exact: true }).click(); await page.getByRole('button', { name: '放入合成阅读材料', exact: true }).click()
  assert.equal((await work()).source, 'fake'); assert.equal((await work()).materials.length, 1)
  const desk = join(await room(), '书桌'); await writeFile(join(desk, '用户未登记资料.md'), 'PRIVATE_DESK_CANARY_DO_NOT_READ')
  await accepted({ type: 'life.work.start', kind: 'read' }); await advance(); assert.equal(job(await snapshot(), 'read').completedSteps, 0)
  await accepted({ type: 'pomodoro.plan', plan: { label: '独立阅读验收', plannedCount: 1, focusDurationMs: 60000, shortBreakDurationMs: 20000, longBreakDurationMs: 20000, longBreakEvery: 4, timing: 'demo' } })
  await accepted({ type: 'pomodoro.confirm', planId: (await snapshot()).pomodoro.proposal.id }); await accepted({ type: 'pomodoro.start', planId: (await snapshot()).pomodoro.plan.id })
  await advance(); await waitFor((s) => job(s, 'read')?.completedSteps === 1, 'READ_FIRST_CHECKPOINT_FAILED')
  let reading = job(await snapshot(), 'read'); const first = reading.output; const firstText = await readFile(join(desk, first.path), 'utf8'); assert.equal(hash(firstText), first.sha256)
  await accepted({ type: 'life.work.pause', workId: reading.id }); await accepted({ type: 'pomodoro.stop' }); await accepted({ type: 'mode.set', mode: 'rest' })
  const archive = join(data, 'partial.lca-save'); await instance.evaluate(({ dialog }, file) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: file }) }, archive)
  await accepted({ type: 'backup.export' }); await waitFor((s) => s.backup.status === 'exported', 'WORK_EXPORT_FAILED')
  // Queue the old checkpoint while in rest, then close. Restart must mark it interrupted, not hide it.
  await accepted({ type: 'life.work.resume', workId: reading.id })
  await stop(); now += 3 * 86400000; await profile(now); await launch(); await debug('set_clock', { nowMs: now, frozen: true })
  reading = job(await snapshot(), 'read'); assert.equal(reading.completedSteps, 1); assert.equal(reading.status, 'interrupted'); assert.deepEqual(reading.output, first)
  await page.getByRole('button', { name: '日程', exact: true }).click()
  const interruptedRow = page.locator(`.work-row[data-work-id="${reading.id}"][data-status="interrupted"]`)
  await interruptedRow.waitFor(); assert.equal(await interruptedRow.locator('.work-progress span[data-done="true"]').count(), 1)
  await accepted({ type: 'mode.set', mode: 'quiet' }); await advance(); assert.equal(job(await snapshot(), 'read').completedSteps, 1)
  await interruptedRow.getByRole('button', { name: '接着做', exact: true }).click(); await waitFor((s) => s.life.work.jobs.find((entry) => entry.id === reading.id)?.completedSteps === 2, 'RESTART_RESUME_FAILED')
  await accepted({ type: 'lights.set', lightsOut: true }); await advance(); assert.equal(job(await snapshot(), 'read').completedSteps, 2)
  await accepted({ type: 'lights.set', lightsOut: false }); await advance(); await waitFor((s) => job(s, 'read').status === 'completed', 'READ_COMPLETE_FAILED')
  // Current-day reading may also be queued after midnight; explicitly pause it so writing gets its turn.
  for (const entry of (await work()).jobs) if (entry.status !== 'completed') await accepted({ type: 'life.work.pause', workId: entry.id })
  await accepted({ type: 'life.work.start', kind: 'write' }); await waitFor((s) => job(s, 'write')?.completedSteps === 1, 'WRITE_OUTLINE_FAILED')
  let writing = job(await snapshot(), 'write'); await accepted({ type: 'plugin.disable', pluginId: 'life-work' }); await advance(); assert.equal(job(await snapshot(), 'write').completedSteps, 1)
  const plugin = (await snapshot()).runtime.plugins.find((plugin) => plugin.id === 'life-work'); await accepted({ type: 'plugin.enable', pluginId: plugin.id, fingerprint: plugin.fingerprint })
  await advance(); await waitFor((s) => job(s, 'write').completedSteps === 2, 'WRITE_DRAFT_FAILED'); await advance(); await waitFor((s) => job(s, 'write').status === 'completed', 'WRITE_REVISION_FAILED')
  writing = job(await snapshot(), 'write'); const text = await readFile(join(desk, writing.output.path), 'utf8'); assert.ok(text.includes('修订稿')); assert.equal(hash(text), writing.output.sha256)
  // 从书里打开：日程书签上她今天的书桌作品，步数来自快照，“看看”走同一个原生预览
  if (await page.getByRole('region', { name: '工具与设置', exact: true }).count()) await page.getByRole('button', { name: '关闭', exact: true }).click()
  await page.getByRole('button', { name: '日程', exact: true }).click()
  const writeRow = page.locator('.work-row[data-status="completed"]', { hasText: '照着' }); await writeRow.waitFor()
  assert.equal(await writeRow.locator('.work-progress span[data-done="true"]').count(), writing.totalSteps)
  const previewPromise = instance.waitForEvent('window'); await writeRow.getByRole('button', { name: '看看', exact: true }).click(); const preview = await previewPromise
  await preview.waitForLoadState(); assert.ok((await preview.locator('pre').innerText()).includes('修订稿')); assert.equal(await preview.evaluate(() => typeof window.lca), 'undefined'); await preview.close()
  assert.ok(!JSON.stringify(await snapshot()).includes('留给下一座纸桥')); const context = JSON.stringify(await debug('get_context')); assert.ok(!context.includes('PRIVATE_DESK_CANARY')); assert.ok(!context.includes('修订稿'))
  await accepted({ type: 'room.rebuild' }); const logs = join(await room(), '运行记录'); const contents = (await Promise.all((await readdir(logs)).map((file) => readFile(join(logs, file), 'utf8')))).join('\n')
  assert.ok(contents.includes('life/work-commit')); assert.ok(!contents.includes('修订稿')); assert.ok(!contents.includes('PRIVATE_DESK_CANARY'))
  // Restore the incomplete save into a genuinely empty profile, with no desk folder carried over.
  await stop(); sceneId = randomUUID(); now += 2 * 86400000; await profile(now); await launch()
  assert.equal((await work()).jobs.length, 0)
  await instance.evaluate(({ dialog, app }, file) => { app.relaunch = () => {}; dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }) }, archive)
  await accepted({ type: 'backup.import' }); await waitFor((s) => s.backup.status === 'awaiting-confirmation', 'WORK_IMPORT_FAILED'); const restoreId = (await snapshot()).backup.restoreId
  await client.close(); client = undefined; const closed = instance.waitForEvent('close'); await accepted({ type: 'backup.restore', restoreId }); await closed; instance = undefined
  await launch(); await debug('set_clock', { nowMs: now, frozen: true }); reading = job(await snapshot(), 'read')
  assert.equal(reading.completedSteps, 1); assert.deepEqual(reading.output, first); const restoredDesk = join(await room(), '书桌'); assert.equal(await readFile(join(restoredDesk, first.path), 'utf8'), firstText)
  assert.equal((await work()).jobs.length, 1); assert.equal((await work()).materials.length, 1)
  await unlink(join(restoredDesk, first.path)); await accepted({ type: 'room.rebuild' }); assert.equal(await readFile(join(restoredDesk, first.path), 'utf8'), firstText)
  await accepted({ type: 'mode.set', mode: 'quiet' }); await accepted({ type: 'life.work.resume', workId: reading.id }); await waitFor((s) => job(s, 'read').completedSteps === 2, 'RESTORED_RESUME_FAILED')
  await advance(); await waitFor((s) => job(s, 'read').status === 'completed', 'RESTORED_COMPLETE_FAILED')
  console.log('Life work Electron PASS: registered synthetic desk only, focus-time real notes/manuscript, pause/lights/plugin guards, native user-only product preview, restart and private restore at exact checkpoint, no offline progress, regenerable products and metadata-only runtime log.')
} finally { await stop() }
