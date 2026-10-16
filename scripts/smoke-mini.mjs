import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron } from 'playwright'
import electronPath from 'electron'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { runtimeEnv } from './runtime-env.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..'); const data = join(root, '.local-data', 'mini-smoke-' + randomUUID()); const sceneId = randomUUID()
const profile = join(data, 'developer', sceneId)
const env = { ...runtimeEnv(root), LCA_DATA_DIR: data, LCA_PROVIDERS_FILE: join(data, 'absent-config.json'), LCA_CDP_PORT: '19534', LCA_MCP_PORT: '0' }
let instance; let book; let mini; let client
async function launch() { instance = await _electron.launch({ executablePath: electronPath, args: [root], env, timeout: 30_000 }); book = await instance.firstWindow(); await book.locator('[data-mode][data-pose]').waitFor() }
const snapshot = () => book.evaluate(() => window.lca.getSnapshot())
async function waitFor(predicate, error) { for (let i = 0; i < 100; i++) { if (predicate(await snapshot())) return; await new Promise((done) => setTimeout(done, 100)) } throw new Error(error) }
const send = (body, page = book) => page.evaluate(async (body) => { const s = await window.lca.getSnapshot(); return window.lca.dispatch({ ...body, epoch: s.epoch, protocolVersion: 1, requestId: crypto.randomUUID() }) }, body)
async function connectDebug() { const discovery = JSON.parse(await readFile(join(profile, 'debug-connection.json'), 'utf8')); client = new Client({ name: 'mini-smoke', version: '1.0.0' }); await client.connect(new StreamableHTTPClientTransport(new URL(discovery.url), { requestInit: { headers: { Authorization: 'Bearer ' + discovery.token } } })) }
try {
  await mkdir(data, { recursive: true }); await writeFile(join(data, 'settings.json'), JSON.stringify({ version: 1, developer: true, booth: false, plugins: {}, sceneId }))
  await launch(); await connectDebug(); await client.callTool({ name: 'set_clock', arguments: { frozen: true } })
  await send({ type: 'pomodoro.plan', plan: { label: '迷你窗验收', plannedCount: 1, focusDurationMs: 60_000, shortBreakDurationMs: 20_000, longBreakDurationMs: 20_000, longBreakEvery: 4, timing: 'demo' } })
  const planId = (await snapshot()).pomodoro.plan.id; await send({ type: 'pomodoro.confirm', planId })
  const opened = instance.waitForEvent('window'); await send({ type: 'pomodoro.start', planId }); mini = await opened; await mini.locator('.mini').waitFor()
  await waitFor((s) => s.windows?.mode === 'mini', 'MINI_NOT_SHOWN_ON_FOCUS')
  const first = await snapshot(); const native = await instance.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map((window) => ({ mini: window.webContents.getURL().includes('view=mini'), visible: window.isVisible(), top: window.isAlwaysOnTop(), preferences: window.webContents.getLastWebPreferences(), resizable: window.isResizable() })))
  assert.equal(native.find((window) => window.mini).visible, true); assert.equal(native.find((window) => !window.mini).visible, false); assert.equal(native.find((window) => window.mini).top, true)
  assert.equal(native.find((window) => window.mini).resizable, false); assert.equal(native.find((window) => window.mini).preferences.sandbox, true); assert.equal(native.find((window) => window.mini).preferences.nodeIntegration, false)
  assert.equal((await mini.evaluate(() => window.lca.getSnapshot())).scope.sessionId, first.scope.sessionId)
  assert.equal((await send({ type: 'window.mini.move', dx: 10, dy: 10 })).error.code, 'permission-denied')
  assert.equal((await send({ type: 'window.mini.hover', over: true })).error.code, 'permission-denied')
  await send({ type: 'window.mini.hover', over: true }, mini); await waitFor((s) => !s.windows.miniClickThrough, 'MINI_HOVER_NOT_INTERACTIVE')
  await send({ type: 'window.mini.move', dx: -90, dy: -80 }, mini); const moved = (await snapshot()).windows.miniBounds
  assert.notDeepEqual(moved, first.windows.miniBounds)
  await send({ type: 'window.mini.move', dx: 10000, dy: 10000 }, mini)
  const bounds = (await snapshot()).windows.miniBounds; const areas = await instance.evaluate(({ screen }) => screen.getAllDisplays().map((display) => display.workArea))
  assert.ok(areas.some((area) => bounds.x >= area.x && bounds.y >= area.y && bounds.x + bounds.width <= area.x + area.width && bounds.y + bounds.height <= area.y + area.height), JSON.stringify({ bounds, areas }))
  await send({ type: 'window.mini.hover', over: false }, mini); assert.equal((await snapshot()).windows.miniClickThrough, true)
  await client.callTool({ name: 'set_clock', arguments: { nowMs: first.clock.nowMs + 60_000 } })
  await waitFor((s) => s.pomodoro.phase === 'short-break', 'MINI_TIMER_NOT_SHARED'); assert.equal((await snapshot()).windows.mode, 'mini')
  await mini.getByRole('button', { name: '休息了，点一下回到书本', exact: true }).click()
  await waitFor((s) => s.windows.mode === 'book', 'MINI_DID_NOT_EXPAND')
  assert.equal(await instance.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((window) => !window.webContents.getURL().includes('view=mini')).isVisible()), true)
  await send({ type: 'lights.set', lightsOut: true }); assert.notEqual((await snapshot()).companion.pose, 'sleeping')
  const position = (await snapshot()).windows.miniBounds; await client.close(); client = undefined; await instance.close(); await launch()
  const again = instance.waitForEvent('window'); await send({ type: 'window.mini' }); mini = await again; await mini.locator('.mini').waitFor(); await waitFor((s) => s.windows.mode === 'mini', 'MINI_REOPEN_FAILED')
  const reopened = (await snapshot()).windows.miniBounds
  assert.deepEqual({ x: reopened.x, y: reopened.y }, { x: position.x, y: position.y })
  await mkdir(join(root, 'test-results'), { recursive: true }); await mini.screenshot({ path: join(root, 'test-results', 'mini.png'), omitBackground: true })
  console.log('Mini smoke: actual transparent always-on-top sandboxed Electron window, same session/timer, focus collapse, hover pass-through policy, sender restrictions, native motion/work-area clamp, rest without focus steal, paper expand, lights semantics and persisted position verified; desktop pointer routing still needs human acceptance.')
} finally { await client?.close(); await instance?.close() }
