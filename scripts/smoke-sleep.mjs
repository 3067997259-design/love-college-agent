import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, writeFile, readFile } from 'node:fs/promises'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron } from 'playwright'
import electronPath from 'electron'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { runtimeEnv, initializeTestBook, electronLaunchTarget, openSettings, whenIdle } from './runtime-env.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const data = join(root, '.local-data', 'sleep-' + randomUUID()); const sceneId = randomUUID()
const reportDir = join(root, 'test-results', 'sleep-routine-' + sceneId)
const env = { ...runtimeEnv(root), LCA_DATA_DIR: data, LCA_PROVIDERS_FILE: join(data, 'absent.json'), LCA_CDP_PORT: '19557', LCA_MCP_PORT: '0' }
let instance; let page; let client; let now = Date.parse('2026-10-17T03:59:00+08:00')
const snapshot = () => page.evaluate(() => window.lca.getSnapshot())
const send = (body) => page.evaluate(async (body) => { const s = await window.lca.getSnapshot(); return window.lca.dispatch({ protocolVersion: 1, epoch: s.epoch, requestId: crypto.randomUUID(), ...body }) }, body)
async function accepted(body) { const result = await send(body); assert.equal(result.status, 'accepted', body.type) }
async function waitFor(predicate, code) { for (let i = 0; i < 100; i++) { if (predicate(await snapshot())) return; await new Promise((done) => setTimeout(done, 100)) }; throw new Error(code) }
async function launch() {
  instance = await _electron.launch({ ...electronLaunchTarget(root, electronPath), env })
  page = await instance.firstWindow(); await initializeTestBook(page)
  const connection = JSON.parse(await readFile(join(data, 'developer', sceneId, 'debug-connection.json'), 'utf8'))
  client = new Client({ name: 'sleep-smoke', version: '1.0.0' })
  await client.connect(new StreamableHTTPClientTransport(new URL(connection.url), { requestInit: { headers: { Authorization: 'Bearer ' + connection.token } } }))
}
async function advance(ms) { now += ms; const result = await client.callTool({ name: 'set_clock', arguments: { nowMs: now, frozen: true } }); assert.ok(!result.isError) }
async function stop() { await client?.close(); client = undefined; await instance?.close(); instance = undefined }
async function settledArt(key) {
  await page.locator(`[data-photo-scene] [data-art="${key}"]`).waitFor()
  await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))))
  await page.waitForFunction((key) => {
    const art = document.querySelector(`[data-photo-scene] [data-art="${key}"]`)
    if (art instanceof HTMLCanvasElement) return art.dataset.photoReady === 'true'
    const image = art?.querySelector('img')
    return image instanceof HTMLImageElement && image.complete && image.naturalWidth > 0
  }, key)
}
async function exportArchive(file) {
  await instance.evaluate(({ dialog }, file) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: file }) }, file)
  assert.equal((await whenIdle(send, { type: 'backup.export' })).status, 'accepted')
  await waitFor((s) => s.backup.status === 'exported', 'SLEEP_EXPORT_FAILED')
}
async function restoreArchive(file) {
  await instance.evaluate(({ dialog, app }, file) => { app.relaunch = () => {}; dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }) }, file)
  await accepted({ type: 'backup.import' }); await waitFor((s) => s.backup.status === 'awaiting-confirmation', 'SLEEP_IMPORT_FAILED')
  const restoreId = (await snapshot()).backup.restoreId; await client.close(); client = undefined
  const closed = instance.waitForEvent('close'); await accepted({ type: 'backup.restore', restoreId }); await closed; instance = undefined
  await launch()
}
try {
  await mkdir(reportDir, { recursive: true })
  await mkdir(join(data, 'developer', sceneId), { recursive: true })
  await writeFile(join(data, 'settings.json'), JSON.stringify({ version: 1, developer: true, booth: false, plugins: {}, sceneId }))
  await writeFile(join(data, 'developer', sceneId, 'clock.json'), JSON.stringify({ nowMs: now, rate: 1, frozen: true }))
  await launch(); assert.equal((await snapshot()).companion.sleeping, false)
  await accepted({ type: 'developer.life.seed' }); await accepted({ type: 'life.work.start', kind: 'read' })
  await openSettings(page)
  await page.getByRole('button', { name: '让她休息', exact: true }).click()
  await waitFor((s) => s.companion.pose === 'sleeping', 'SLEEP_POSE_MISSING')
  await page.locator('[data-photo-scene][data-pose="sleeping"][data-lighting="baked-night"]').waitFor()
  await accepted({ type: 'lights.set', lightsOut: true })
  await page.locator('[data-photo-scene][data-pose="sleeping"][data-lighting="baked-dark"]').waitFor()
  await accepted({ type: 'lights.set', lightsOut: false })
  const archive = join(data, 'sleep.lca-save')
  await exportArchive(archive)
  await stop(); await launch(); assert.equal((await snapshot()).companion.sleeping, true)
  await accepted({ type: 'companion.sleep', sleeping: false })
  const oldSession = (await snapshot()).scope.sessionId
  await advance(3 * 60000); await waitFor((s) => s.scope.sessionId !== oldSession && s.companion.sleeping, 'SAFE_DAY_SLEEP_MISSING')
  assert.equal((await snapshot()).companion.pose, 'sleeping')
  const automaticArchive = join(data, 'automatic-sleep.lca-save')
  await exportArchive(automaticArchive)
  await stop(); await launch()
  assert.equal((await snapshot()).companion.sleeping, true)
  await advance(117 * 60000)
  assert.equal((await snapshot()).companion.sleeping, true)
  await advance(60000)
  await waitFor((s) => !s.companion.sleeping && s.companion.daypart === 'morning', 'AUTOMATIC_MORNING_WAKE_FAILED')
  await page.locator('[data-photo-scene][data-pose="facing-user"][data-lighting="ambient"]').waitFor()
  await settledArt('facing-user_calm')
  await page.screenshot({ path: join(reportDir, 'morning-awake.png') })
  assert.equal((await snapshot()).life.work.attemptsToday, 0)
  assert.ok(!(await snapshot()).life.work.jobs.some((job) => job.completedSteps > 0))
  await advance(142 * 60000)
  await restoreArchive(automaticArchive)
  await waitFor((s) => !s.companion.sleeping && s.companion.pose !== 'sleeping', 'COLD_AUTOMATIC_MORNING_WAKE_FAILED')
  await page.locator('[data-photo-scene][data-pose="facing-user"][data-lighting="ambient"]').waitFor()
  await settledArt('facing-user_calm')
  const coldMorning = (await snapshot()).companion
  await page.screenshot({ path: join(reportDir, 'cold-morning-awake.png') })
  await accepted({ type: 'message.send', text: '合成醒来测试' }); await waitFor((s) => !s.companion.sleeping && s.task?.status === 'completed', 'USER_WAKE_FAILED')
  await restoreArchive(archive); assert.equal((await snapshot()).companion.sleeping, true)
  assert.ok(!(await snapshot()).life.work.jobs.some((job) => job.completedSteps > 0))
  await accepted({ type: 'companion.sleep', sleeping: false }); await accepted({ type: 'lights.set', lightsOut: true })
  assert.equal((await snapshot()).companion.sleeping, false); assert.notEqual((await snapshot()).companion.pose, 'sleeping')
  await writeFile(join(reportDir, 'report.json'), JSON.stringify({ ok: true, source: 'synthetic-clock-and-model', coldMorning, checks: ['manual-night-dark-art', 'manual-restart-preserved', 'safe-night-rollover', 'automatic-restart-before-morning', 'automatic-06:00-wake-art', 'cold-08:22-wake-art', 'manual-restore-preserved', 'lights-independent'], data }, null, 2))
  console.log('Sleep Electron smoke passed: morning art, automatic wake, cold recovery, manual preservation and lights; synthetic clock/model only. ' + reportDir)
} finally { await stop() }
