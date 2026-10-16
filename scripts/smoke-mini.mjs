import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron } from 'playwright'
import electronPath from 'electron'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { runtimeEnv, initializeTestBook, electronLaunchTarget } from './runtime-env.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..'); const data = join(root, '.local-data', 'mini-smoke-' + randomUUID()); const sceneId = randomUUID()
const profile = join(data, 'developer', sceneId)
const env = { ...runtimeEnv(root), LCA_DATA_DIR: data, LCA_PROVIDERS_FILE: join(data, 'absent-config.json'), LCA_CDP_PORT: '19534', LCA_MCP_PORT: '0' }
let instance; let book; let mini; let client
async function launch() { instance = await _electron.launch({ ...electronLaunchTarget(root, electronPath), env, timeout: 30_000 }); book = await instance.firstWindow(); await initializeTestBook(book); await book.locator('[data-mode][data-pose]').waitFor() }
const snapshot = () => book.evaluate(() => window.lca.getSnapshot())
async function waitFor(predicate, error) { for (let i = 0; i < 100; i++) { if (predicate(await snapshot())) return; await new Promise((done) => setTimeout(done, 100)) } throw new Error(error) }
const send = (body, page = book) => page.evaluate(async (body) => { const s = await window.lca.getSnapshot(); return window.lca.dispatch({ ...body, epoch: s.epoch, protocolVersion: 1, requestId: crypto.randomUUID() }) }, body)
async function connectDebug() { const discovery = JSON.parse(await readFile(join(profile, 'debug-connection.json'), 'utf8')); client = new Client({ name: 'mini-smoke', version: '1.0.0' }); await client.connect(new StreamableHTTPClientTransport(new URL(discovery.url), { requestInit: { headers: { Authorization: 'Bearer ' + discovery.token } } })) }
const nativeWindows = () => instance.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map((window) => ({ mini: window.webContents.getURL().includes('view=mini'), diagnostics: window.webContents.getURL().includes('view=diagnostics'), visible: window.isVisible(), top: window.isAlwaysOnTop(), focused: window.isFocused(), bounds: window.getBounds(), preferences: window.webContents.getLastWebPreferences(), resizable: window.isResizable(), inactiveCalls: window.lcaInactiveCalls, ignoreCalls: window.lcaIgnoreCalls })))
async function openMini() { const opened = instance.waitForEvent('window'); assert.equal((await send({ type: 'window.mini' })).status, 'accepted'); mini = await opened; await mini.locator('.mini').waitFor(); await waitFor((s) => s.windows.mode === 'mini', 'MINI_REOPEN_FAILED') }
async function expandMini() { const closed = mini.waitForEvent('close'); assert.equal((await send({ type: 'window.expand' }, mini)).status, 'accepted'); await closed; await waitFor((s) => s.windows.mode === 'book', 'MINI_DID_NOT_EXPAND') }
async function verifyBookOnly() { assert.equal((await nativeWindows()).length, 1); assert.equal((await snapshot()).windows.mode, 'book'); assert.equal((await snapshot()).windows.miniBounds, null); assert.equal((await snapshot()).windows.diagnosticsOpen, false) }
async function verifyDefaultCorner() {
  const bounds = (await snapshot()).windows.miniBounds; const area = await instance.evaluate(({ screen }) => screen.getPrimaryDisplay().workArea)
  const content = await instance.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes('view=mini')).getContentBounds())
  const viewport = await mini.evaluate(() => ({ width: innerWidth, height: innerHeight, ratio: devicePixelRatio }))
  assert.ok(Math.abs(content.width - 280) <= 1 && Math.abs(content.height - 350) <= 1 && Math.abs(viewport.width - 280) <= 1 && Math.abs(viewport.height - 350) <= 1, 'MINI_LOGICAL_SIZE ' + JSON.stringify({ bounds, area, content, viewport }))
  assert.ok(Math.abs(area.x + area.width - bounds.x - bounds.width - 24) <= 2 && Math.abs(area.y + area.height - bounds.y - bounds.height - 24) <= 2, 'MINI_DEFAULT_MARGIN ' + JSON.stringify({ bounds, area }))
}
async function rewritePosition(miniPosition) { const path = join(profile, 'settings.json'); const settings = JSON.parse(await readFile(path, 'utf8')); await writeFile(path, JSON.stringify({ ...settings, miniPosition })) }
try {
  env.LCA_DATA_DIR = join(data, 'normal'); await mkdir(env.LCA_DATA_DIR, { recursive: true }); await launch()
  assert.equal((await snapshot()).runtime.developer.mode, 'normal')
  assert.equal((await send({ type: 'window.diagnostics.open' })).error.code, 'permission-denied'); await verifyBookOnly(); await instance.close()
  env.LCA_DATA_DIR = data
  await mkdir(data, { recursive: true }); await writeFile(join(data, 'settings.json'), JSON.stringify({ version: 1, developer: true, booth: false, plugins: {}, sceneId }))
  await launch(); await connectDebug(); await client.callTool({ name: 'set_clock', arguments: { frozen: true } })
  await instance.evaluate(({ app }) => { app.on('browser-window-created', (_event, window) => {
    window.lcaIgnoreCalls = []; window.lcaInactiveCalls = 0
    const ignore = window.setIgnoreMouseEvents.bind(window); window.setIgnoreMouseEvents = (value, options) => { window.lcaIgnoreCalls.push({ value, options }); ignore(value, options) }
    const inactive = window.showInactive.bind(window); window.showInactive = () => { window.lcaInactiveCalls++; inactive() }
  }) })
  await send({ type: 'pomodoro.plan', plan: { label: '迷你窗验收', plannedCount: 1, focusDurationMs: 60_000, shortBreakDurationMs: 20_000, longBreakDurationMs: 20_000, longBreakEvery: 4, timing: 'demo' } })
  const planId = (await snapshot()).pomodoro.proposal.id; await send({ type: 'pomodoro.confirm', planId })
  const opened = instance.waitForEvent('window'); await send({ type: 'pomodoro.start', planId }); mini = await opened; await mini.locator('.mini').waitFor()
  await waitFor((s) => s.windows?.mode === 'mini', 'MINI_NOT_SHOWN_ON_FOCUS')
  const first = await snapshot(); const native = await nativeWindows()
  assert.equal(native.find((window) => window.mini).visible, true); assert.equal(native.find((window) => !window.mini).visible, false); assert.equal(native.find((window) => window.mini).top, true)
  assert.equal(native.find((window) => window.mini).resizable, false); assert.equal(native.find((window) => window.mini).preferences.sandbox, true); assert.equal(native.find((window) => window.mini).preferences.nodeIntegration, false)
  assert.equal(native.find((window) => window.mini).preferences.preload, native.find((window) => !window.mini).preferences.preload)
  assert.equal(native.find((window) => window.mini).focused, false); assert.ok(native.find((window) => window.mini).inactiveCalls > 0)
  assert.ok(native.find((window) => window.mini).ignoreCalls.some((call) => call.value && call.options.forward))
  await verifyDefaultCorner()
  assert.equal(await mini.evaluate(() => [...document.querySelectorAll('*')].some((element) => getComputedStyle(element).getPropertyValue('-webkit-app-region') === 'drag')), false)
  assert.equal((await mini.evaluate(() => window.lca.getSnapshot())).scope.sessionId, first.scope.sessionId)
  assert.equal((await send({ type: 'window.mini.moveBy', dx: 10, dy: 10 })).error.code, 'permission-denied')
  assert.equal((await send({ type: 'window.mini.hover', over: true })).error.code, 'permission-denied')
  assert.equal((await send({ type: 'window.mini.moveBy', dx: 1.5, dy: 0 }, mini)).error.code, 'invalid-command')
  await send({ type: 'window.mini.hover', over: true }, mini); await waitFor((s) => !s.windows.miniClickThrough, 'MINI_HOVER_NOT_INTERACTIVE')
  const display = await instance.evaluate(({ screen }, bounds) => { const display = screen.getDisplayMatching(bounds); return { id: display.id, scaleFactor: display.scaleFactor, workArea: display.workArea } }, first.windows.miniBounds)
  await send({ type: 'window.mini.moveBy', dx: -90, dy: -80 }, mini); const moved = (await snapshot()).windows.miniBounds
  assert.notDeepEqual(moved, first.windows.miniBounds)
  assert.ok(Math.abs(moved.x - first.windows.miniBounds.x + 90 / display.scaleFactor) <= 1 && Math.abs(moved.y - first.windows.miniBounds.y + 80 / display.scaleFactor) <= 1, 'PHYSICAL_PIXEL_SCALE_INCORRECT')
  await send({ type: 'window.mini.moveBy', dx: 10000, dy: 10000 }, mini)
  const bounds = (await snapshot()).windows.miniBounds; const area = display.workArea
  assert.ok(bounds.x >= area.x && bounds.y >= area.y && bounds.x + bounds.width <= area.x + area.width && bounds.y + bounds.height <= area.y + area.height, JSON.stringify({ bounds, area }))
  assert.equal(await instance.evaluate(({ screen }, bounds) => screen.getDisplayMatching(bounds).id, bounds), display.id)
  await send({ type: 'window.mini.moveBy', dx: -60, dy: -60 }, mini)
  await send({ type: 'window.mini.hover', over: false }, mini); assert.equal((await snapshot()).windows.miniClickThrough, true)
  const calls = (await nativeWindows()).find((window) => window.mini).ignoreCalls
  assert.ok(calls.some((call) => call.value === false) && calls.some((call) => call.value === true && call.options.forward), 'NATIVE_CLICK_THROUGH_NOT_CHANGED')

  // Open the actual developer-only button from the hidden book; the independent surface remains visible through focus.
  await expandMini(); await book.getByRole('button', { name: '工具与设置', exact: true }).click()
  const diagnosticsOpened = instance.waitForEvent('window'); await book.getByRole('button', { name: '独立窗口', exact: true }).click(); const diagnostics = await diagnosticsOpened
  await diagnostics.getByRole('heading', { name: '开发诊断 · 独立窗口', exact: true }).waitFor()
  await diagnostics.locator('.diagnostics-data').waitFor(); assert.equal((await snapshot()).windows.diagnosticsOpen, true)
  assert.equal((await send({ type: 'window.diagnostics.open' })).status, 'accepted'); assert.equal((await nativeWindows()).length, 2)
  const restrictions = await diagnostics.evaluate(async () => {
    const s = await window.lca.getSnapshot(); const rejected = []
    for (const body of [{ type: 'lights.set', lightsOut: true }, { type: 'window.expand' }, { type: 'window.mini.hover', over: true }, { type: 'window.mini.moveBy', dx: 1, dy: 1 }]) rejected.push(await window.lca.dispatch({ ...body, epoch: s.epoch, protocolVersion: 1, requestId: crypto.randomUUID() }))
    const denied = (operation) => operation().then(() => false, () => true)
    return { rejected, evidence: await denied(() => window.lca.readEvidence('synthetic-evidence')), session: await denied(() => window.lca.readSession(s.scope.sessionId)) }
  })
  assert.ok(restrictions.rejected.every((ack) => ack.status === 'rejected' && ack.error.code === 'permission-denied'))
  assert.equal(restrictions.evidence, true); assert.equal(restrictions.session, true)
  const diagnosticFile = join(data, 'diagnostics-synthetic.txt'); await writeFile(diagnosticFile, 'Synthetic read-only window import must be refused.')
  await diagnostics.evaluate(() => { const input = document.createElement('input'); input.type = 'file'; input.id = 'diagnostic-file-test'; document.body.append(input) })
  await diagnostics.locator('#diagnostic-file-test').setInputFiles(diagnosticFile)
  const importAck = await diagnostics.evaluate(async () => { const s = await window.lca.getSnapshot(); return window.lca.importFiles(Array.from(document.querySelector('#diagnostic-file-test').files), s.epoch) })
  assert.deepEqual(importAck.acceptedIds, []); assert.equal(importAck.rejectedCount, 1); assert.ok(importAck.error)
  await book.getByRole('button', { name: '关闭', exact: true }).click(); await openMini()
  assert.equal((await nativeWindows()).find((window) => window.diagnostics).visible, true); assert.equal((await nativeWindows()).find((window) => !window.diagnostics && !window.mini).visible, false)
  // Safe synthetic activity follows the event stream while the book is hidden; this makes no real model or provider call.
  await client.callTool({ name: 'set_fake_model', arguments: { script: [{ text: '', toolCalls: [{ id: 'diagnostic-clock', name: 'get_clock', arguments: '{}' }], delayMs: 0 }, { text: '独立诊断合成结果', toolCalls: [], delayMs: 0 }] } })
  await send({ type: 'message.send', text: '独立诊断合成回合' })
  await waitFor((s) => s.task?.status === 'completed', 'DIAGNOSTICS_SYNTHETIC_TURN_NOT_COMPLETED')
  await diagnostics.locator('.diagnostics-live li').first().waitFor()
  await diagnostics.getByText('回合记录 · 1', { exact: true }).waitFor()
  assert.equal((await diagnostics.evaluate(() => window.lca.readDiagnostics())).turns.length, 1)
  await diagnostics.close(); await waitFor((s) => !s.windows.diagnosticsOpen, 'DIAGNOSTICS_NOT_CLOSED'); assert.equal((await snapshot()).windows.mode, 'mini')
  await client.callTool({ name: 'set_clock', arguments: { nowMs: first.clock.nowMs + 60_000 } })
  await waitFor((s) => s.pomodoro.phase === 'short-break', 'MINI_TIMER_NOT_SHARED'); assert.equal((await snapshot()).windows.mode, 'mini')
  const position = (await snapshot()).windows.miniBounds
  const closed = mini.waitForEvent('close')
  await mini.getByRole('button', { name: '休息了，点一下回到书本', exact: true }).click()
  await closed
  await waitFor((s) => s.windows.mode === 'book', 'MINI_DID_NOT_EXPAND')
  assert.equal((await snapshot()).windows.miniBounds, null)
  assert.equal(await instance.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((window) => !window.webContents.getURL().includes('view=mini')).isVisible()), true)
  await send({ type: 'lights.set', lightsOut: true }); assert.notEqual((await snapshot()).companion.pose, 'sleeping')
  await client.close(); client = undefined; await instance.close(); await launch()
  await verifyBookOnly(); await openMini()
  const reopened = (await snapshot()).windows.miniBounds
  assert.ok(Math.abs(reopened.x - position.x) <= 1 && Math.abs(reopened.y - position.y) <= 1, 'MINI_POSITION_NOT_PERSISTED')
  const settings = JSON.parse(await readFile(join(profile, 'settings.json'), 'utf8')); assert.equal(settings.miniPosition.displayId, display.id)
  await mkdir(join(root, 'test-results'), { recursive: true }); await mini.screenshot({ path: join(root, 'test-results', 'mini.png'), omitBackground: true })
  const finalDiagnosticsOpened = instance.waitForEvent('window'); await send({ type: 'window.diagnostics.open' }); const finalDiagnostics = await finalDiagnosticsOpened
  await finalDiagnostics.getByRole('heading', { name: '开发诊断 · 独立窗口', exact: true }).waitFor()
  await instance.close()
  for (const invalid of [{ x: 99999, y: -99999, displayId: display.id }, { x: position.x, y: position.y, displayId: -987654321 }]) {
    await rewritePosition(invalid); await launch(); await verifyBookOnly(); await openMini(); await verifyDefaultCorner(); await instance.close()
  }
  await launch(); await verifyBookOnly()
  console.log('Mini smoke: 280x350 DIP / 24 DIP margin, inactive transparent topmost sandboxed window, shared focus/rest timer, native hover calls, physical-pixel moveBy / current-display clamp, persisted position and removed-display/off-screen recovery, expand/paper return, no restart orphans; developer diagnostics button, live safe projection and read-only IPC, normal-mode refusal verified. Desktop pointer routing and physical monitor hotplug still require human acceptance.')
} finally { await client?.close(); await instance?.close() }
