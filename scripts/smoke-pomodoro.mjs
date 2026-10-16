import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron } from 'playwright'
import electronPath from 'electron'
import { runtimeEnv } from './runtime-env.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const data = join(root, '.local-data', `pomodoro-smoke-${randomUUID()}`)
const realtime = process.argv.includes('--real-time')
await mkdir(data, { recursive: true })
await writeFile(join(data, 'settings.json'), JSON.stringify({ version: 1, developer: !realtime, booth: false, plugins: {} }))
const env = { ...runtimeEnv(root), LCA_DATA_DIR: data, LCA_PROVIDERS_FILE: join(data, 'absent-test-providers.json'), LCA_MCP_PORT: '0', LCA_CDP_PORT: '19528' }
let instance; let page
const snapshot = () => page.evaluate(() => window.lca.getSnapshot())
const send = (body) => page.evaluate(async (body) => { const s = await window.lca.getSnapshot(); return window.lca.dispatch({ ...body, protocolVersion: 1, epoch: s.epoch, requestId: crypto.randomUUID() }) }, body)
const seek = async (ms) => { const before = await snapshot(); assert.equal((await send({ type: 'developer.clock', nowMs: before.clock.nowMs + ms })).status, 'accepted') }
async function waitFor(predicate, error) { for (let i = 0; i < 100; i++) { if (await predicate(await snapshot())) return; await new Promise((done) => setTimeout(done, 50)) } throw new Error(error) }
const miniSend = (mini, body) => mini.evaluate(async (body) => { const s = await window.lca.getSnapshot(); return window.lca.dispatch({ ...body, protocolVersion: 1, epoch: s.epoch, requestId: crypto.randomUUID() }) }, body)
const windows = () => instance.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map((window) => ({ mini: window.webContents.getURL().includes('view=mini'), visible: window.isVisible(), top: window.isAlwaysOnTop(), background: window.getBackgroundColor(), preferences: window.webContents.getLastWebPreferences() })))
async function verifyMini(mini) {
  await mini.locator('.mini').waitFor(); await waitFor((s) => s.windows?.mode === 'mini', 'MINI_NOT_PRESENTED')
  const views = await windows(); assert.equal(views.length, 2); assert.equal(views.find((w) => !w.mini).visible, false); assert.equal(views.find((w) => w.mini).visible, true); assert.equal(views.find((w) => w.mini).top, true)
  assert.equal(views[0].preferences.preload, views[1].preferences.preload); assert.equal(views.find((w) => w.mini).preferences.sandbox, true)
  await instance.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes('view=mini')); window.lcaIgnoreCalls = []; const original = window.setIgnoreMouseEvents.bind(window); window.setIgnoreMouseEvents = (ignore, options) => { window.lcaIgnoreCalls.push(ignore); original(ignore, options) } })
  assert.equal((await snapshot()).windows.miniClickThrough, true)
  await miniSend(mini, { type: 'window.mini.hover', over: true }); assert.equal((await snapshot()).windows.miniClickThrough, false)
  await miniSend(mini, { type: 'window.mini.hover', over: false }); assert.equal((await snapshot()).windows.miniClickThrough, true)
  const ignored = await instance.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes('view=mini')).lcaIgnoreCalls)
  assert.ok(ignored.includes(false) && ignored.includes(true), 'NATIVE_CLICK_THROUGH_NOT_CHANGED')
}
async function expandMini(mini) {
  const closed = mini.waitForEvent('close'); assert.equal((await miniSend(mini, { type: 'window.expand' })).status, 'accepted'); await closed
  await waitFor((s) => s.windows?.mode === 'book' && s.windows.miniBounds === null, 'MINI_NOT_DESTROYED')
  const views = await windows(); assert.equal(views.length, 1); assert.equal(views[0].visible, true)
}
async function launch() {
  instance = await _electron.launch({ executablePath: electronPath, args: [root], env, timeout: 30_000 })
  page = await instance.firstWindow(); await page.locator('[data-mode][data-pose][data-location]').waitFor()
}
async function cache() {
  return instance.evaluate(({ app }) => {
    const builtin = process.mainModule.require.bind(process.mainModule)
    const { join } = builtin('node:path'); const { createRequire } = builtin('node:module')
    const require = createRequire(join(app.getAppPath(), 'package.json')); const Database = require('better-sqlite3')
    const db = new Database(join(app.getPath('userData'), 'projections.sqlite'), { readonly: true })
    try { return db.prepare("SELECT json_extract(state_json, '$.pomodoro.endsAtMs') AS endsAtMs, json_array_length(json_extract(state_json, '$.pomodoroEvents')) AS eventCount FROM session_projections ORDER BY journal_seq DESC LIMIT 1").get() }
    finally { db.close() }
  })
}
try {
  await launch()
  if (realtime) {
    const plan = { label: '实际计时验收', plannedCount: 2, focusDurationMs: 60_000, shortBreakDurationMs: 20_000, longBreakDurationMs: 20_000, longBreakEvery: 4, timing: 'demo' }
    assert.equal((await snapshot()).runtime.developer.mode, 'normal')
    await send({ type: 'pomodoro.plan', plan }); const planId = (await snapshot()).pomodoro.plan.id
    await send({ type: 'pomodoro.confirm', planId }); await send({ type: 'pomodoro.start', planId })
    const started = await snapshot()
    await page.locator('[data-mode][data-phase="short-break"]').waitFor({ timeout: 75_000 })
    const focusEnded = await snapshot()
    await page.locator('[data-mode][data-phase="idle"]').waitFor({ timeout: 35_000 })
    const finished = await snapshot()
    assert.equal(finished.pomodoro.focusIndex, 1); assert.equal(finished.pomodoro.plan.status, 'confirmed')
    assert.ok(focusEnded.clock.nowMs - started.clock.nowMs >= 60_000)
    assert.ok(finished.clock.nowMs - focusEnded.clock.nowMs >= 20_000)
    console.log(JSON.stringify({ ok: true, probe: 'pomodoro-real-time', rate: finished.clock.rate, frozen: finished.clock.frozen,
      focusElapsedMs: focusEnded.clock.nowMs - started.clock.nowMs, breakElapsedMs: finished.clock.nowMs - focusEnded.clock.nowMs, noAutomaticNext: true }))
  } else {
  await send({ type: 'developer.clock', frozen: true })
  await page.getByRole('button', { name: '工具与设置', exact: true }).click()
  await page.getByRole('checkbox', { name: /演示节奏/ }).check()
  await page.getByRole('button', { name: '生成待确认计划', exact: true }).click()
  let state = await snapshot(); const planId = state.pomodoro.plan.id
  assert.equal(state.pomodoro.plan.status, 'proposed')
  assert.equal((await send({ type: 'pomodoro.start', planId })).status, 'rejected')
  await page.getByRole('button', { name: '确认计划', exact: true }).click()
  const opened = instance.waitForEvent('window'); await page.getByRole('button', { name: '开始下一段专注', exact: true }).click(); let mini = await opened
  await verifyMini(mini)
  state = await snapshot(); assert.equal(state.pomodoro.phaseDurationMs, 60_000); assert.equal(state.companion.mode, 'quiet')
  assert.equal((await cache()).endsAtMs, state.pomodoro.endsAtMs)
  await seek(10_000); state = await snapshot(); assert.equal(state.pomodoro.remainingMs, 50_000)
  await instance.close(); await launch()
  assert.equal((await windows()).length, 1); assert.equal((await snapshot()).windows.mode, 'book'); assert.equal((await snapshot()).windows.miniBounds, null)
  state = await snapshot(); assert.equal(state.pomodoro.plan.id, planId); assert.equal(state.pomodoro.remainingMs, 50_000); assert.equal(state.clock.frozen, true)
  await seek(50_000); state = await snapshot(); assert.equal(state.pomodoro.phase, 'short-break'); assert.equal(state.companion.mode, 'rest')
  assert.equal((await cache()).eventCount, 2)
  await send({ type: 'developer.clock', frozen: true }); assert.equal((await cache()).eventCount, 2)
  await seek(20_000); state = await snapshot(); assert.equal(state.pomodoro.phase, 'idle'); assert.equal(state.pomodoro.plan.status, 'confirmed')
  await seek(60_000); assert.equal((await snapshot()).pomodoro.focusIndex, 1)
  const next = instance.waitForEvent('window'); await send({ type: 'pomodoro.start', planId }); mini = await next; await verifyMini(mini); await seek(5000)
  await send({ type: 'lights.set', lightsOut: true }); const paused = await snapshot(); assert.equal(paused.pomodoro.status, 'paused')
  assert.equal(paused.windows.mode, 'mini'); assert.equal((await windows()).find((w) => !w.mini).visible, false)
  await seek(120_000); assert.equal((await snapshot()).pomodoro.remainingMs, paused.pomodoro.remainingMs)
  await send({ type: 'lights.set', lightsOut: false }); assert.equal((await snapshot()).pomodoro.status, 'running')
  await send({ type: 'pomodoro.pause' }); await send({ type: 'lights.set', lightsOut: true }); await send({ type: 'lights.set', lightsOut: false })
  assert.equal((await snapshot()).pomodoro.status, 'paused')
  await send({ type: 'pomodoro.resume' }); await send({ type: 'mode.set', mode: 'rest' })
  assert.equal((await snapshot()).pomodoro.phase, 'short-break'); assert.equal((await snapshot()).pomodoro.focusIndex, 1)
  assert.equal((await snapshot()).windows.mode, 'mini'); assert.equal((await windows()).find((w) => !w.mini).visible, false)
  await send({ type: 'pomodoro.stop' }); assert.equal((await snapshot()).pomodoro.plan.status, 'finished')
  assert.equal((await snapshot()).windows.mode, 'mini'); await expandMini(mini)
  await page.screenshot({ path: join(root, 'test-results/pomodoro.png') })
  await instance.close()
  // Booth/normal mode uses the same window whitelist; forcing opaque mode must not require developer tools.
  env.LCA_DATA_DIR = join(data, 'opaque-booth'); env.LCA_PROVIDERS_FILE = join(data, 'absent-test-providers.json'); env.LCA_MINI_OPAQUE = '1'; env.LCA_BOOTH = '1'
  await mkdir(env.LCA_DATA_DIR, { recursive: true }); await writeFile(join(env.LCA_DATA_DIR, 'settings.json'), JSON.stringify({ version: 1, developer: false, booth: true, plugins: {}, miniPosition: { x: 99999, y: -99999 } }))
  await launch(); assert.equal((await snapshot()).runtime.developer.mode, 'booth')
  const plan = { label: '不透明窗口验收', plannedCount: 1, items: [{ text: '窗口验收', count: 1, assist: false }], focusDurationMs: 60_000, shortBreakDurationMs: 20_000, longBreakDurationMs: 20_000, longBreakEvery: 4, timing: 'demo' }
  await send({ type: 'pomodoro.plan', plan }); const opaqueId = (await snapshot()).pomodoro.plan.id
  await send({ type: 'pomodoro.confirm', planId: opaqueId }); const opaque = instance.waitForEvent('window'); await send({ type: 'pomodoro.start', planId: opaqueId }); mini = await opaque; await verifyMini(mini)
  assert.equal((await snapshot()).windows.miniPresentation, 'opaque'); assert.equal((await snapshot()).windows.miniFallbackReason, 'forced')
  const bounds = (await snapshot()).windows.miniBounds; const areas = await instance.evaluate(({ screen }) => screen.getAllDisplays().map((display) => display.workArea))
  assert.ok(areas.some((area) => bounds.x >= area.x && bounds.y >= area.y && bounds.x + bounds.width <= area.x + area.width && bounds.y + bounds.height <= area.y + area.height), 'OFFSCREEN_PROFILE_NOT_REHOMED')
  assert.equal((await windows()).find((w) => w.mini).background.toLowerCase(), '#f5eedc')
  await expandMini(mini); await instance.close(); await launch(); assert.equal((await windows()).length, 1)
  assert.equal((await snapshot()).windows.miniBounds, null); assert.equal((await snapshot()).windows.mode, 'book')
  await send({ type: 'pomodoro.stop' }); await instance.close()
  // Simulate compositor output, not an actual driver fault; the replacement itself is a real BrowserWindow.
  delete env.LCA_MINI_OPAQUE; env.LCA_DATA_DIR = join(data, 'black-corners-booth'); await launch()
  await instance.evaluate(({ app, nativeImage }) => { app.on('browser-window-created', (_event, window) => {
    window.webContents.capturePage = async () => { const bytes = Buffer.alloc(32 * 40 * 4); for (let i = 3; i < bytes.length; i += 4) bytes[i] = 255; return nativeImage.createFromBitmap(bytes, { width: 32, height: 40 }) }
  }) })
  const black = instance.waitForEvent('window'); await send({ type: 'window.mini' }); const blackMini = await black
  await waitFor(async (s) => s.windows?.miniFallbackReason === 'black-background' && s.windows.mode === 'mini' && (await windows()).find((w) => w.mini)?.visible === true, 'BLACK_COMPOSITOR_NOT_REPLACED')
  const blackState = await snapshot(); assert.equal(blackState.windows.miniPresentation, 'opaque')
  assert.equal((await windows()).filter((w) => w.mini).length, 1); assert.equal(blackMini.isClosed(), true)
  const opaqueMini = instance.windows().find((w) => w !== page && !w.isClosed()); await opaqueMini.locator('.mini').waitFor(); await expandMini(opaqueMini)
  console.log('Pomodoro smoke: confirmed plans, items, SQLite deadlines/restart, timing/lights/interruption, real dual-window switching and native click-through calls, mini retention through rest/stop/lights, expand destroys, booth opaque rounded fallback, simulated black-compositor replacement and no mini after restart verified; real desktop pointer/driver acceptance still manual.')
  }
} finally { await instance?.close() }
