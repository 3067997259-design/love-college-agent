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
await mkdir(data, { recursive: true })
await writeFile(join(data, 'settings.json'), JSON.stringify({ version: 1, developer: true, booth: false, plugins: {} }))
const env = { ...runtimeEnv(root), LCA_DATA_DIR: data, LCA_PROVIDERS_FILE: join(data, 'absent-test-providers.json'), LCA_MCP_PORT: '0', LCA_CDP_PORT: '19528' }
let instance; let page
const snapshot = () => page.evaluate(() => window.lca.getSnapshot())
const send = (body) => page.evaluate(async (body) => { const s = await window.lca.getSnapshot(); return window.lca.dispatch({ ...body, protocolVersion: 1, epoch: s.epoch, requestId: crypto.randomUUID() }) }, body)
const seek = async (ms) => { const before = await snapshot(); assert.equal((await send({ type: 'developer.clock', nowMs: before.clock.nowMs + ms })).status, 'accepted') }
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
  await launch(); await send({ type: 'developer.clock', frozen: true })
  await page.getByRole('button', { name: '工具与设置', exact: true }).click()
  await page.getByRole('checkbox', { name: /演示节奏/ }).check()
  await page.getByRole('button', { name: '生成待确认计划', exact: true }).click()
  let state = await snapshot(); const planId = state.pomodoro.plan.id
  assert.equal(state.pomodoro.plan.status, 'proposed')
  assert.equal((await send({ type: 'pomodoro.start', planId })).status, 'rejected')
  await page.getByRole('button', { name: '确认计划', exact: true }).click()
  await page.getByRole('button', { name: '开始下一段专注', exact: true }).click()
  state = await snapshot(); assert.equal(state.pomodoro.phaseDurationMs, 60_000); assert.equal(state.companion.mode, 'quiet')
  assert.equal((await cache()).endsAtMs, state.pomodoro.endsAtMs)
  await seek(10_000); state = await snapshot(); assert.equal(state.pomodoro.remainingMs, 50_000)
  await instance.close(); await launch()
  state = await snapshot(); assert.equal(state.pomodoro.plan.id, planId); assert.equal(state.pomodoro.remainingMs, 50_000); assert.equal(state.clock.frozen, true)
  await seek(50_000); state = await snapshot(); assert.equal(state.pomodoro.phase, 'short-break'); assert.equal(state.companion.mode, 'rest')
  assert.equal((await cache()).eventCount, 2)
  await send({ type: 'developer.clock', frozen: true }); assert.equal((await cache()).eventCount, 2)
  await seek(20_000); state = await snapshot(); assert.equal(state.pomodoro.phase, 'idle'); assert.equal(state.pomodoro.plan.status, 'confirmed')
  await seek(60_000); assert.equal((await snapshot()).pomodoro.focusIndex, 1)
  await send({ type: 'pomodoro.start', planId }); await seek(5000)
  await send({ type: 'lights.set', lightsOut: true }); const paused = await snapshot(); assert.equal(paused.pomodoro.status, 'paused')
  await seek(120_000); assert.equal((await snapshot()).pomodoro.remainingMs, paused.pomodoro.remainingMs)
  await send({ type: 'lights.set', lightsOut: false }); assert.equal((await snapshot()).pomodoro.status, 'running')
  await send({ type: 'pomodoro.pause' }); await send({ type: 'lights.set', lightsOut: true }); await send({ type: 'lights.set', lightsOut: false })
  assert.equal((await snapshot()).pomodoro.status, 'paused')
  await send({ type: 'pomodoro.resume' }); await send({ type: 'mode.set', mode: 'rest' })
  assert.equal((await snapshot()).pomodoro.phase, 'short-break'); assert.equal((await snapshot()).pomodoro.focusIndex, 1)
  await send({ type: 'pomodoro.stop' }); assert.equal((await snapshot()).pomodoro.plan.status, 'finished')
  await page.screenshot({ path: join(root, 'test-results/pomodoro.png') })
  console.log('Pomodoro smoke: user-confirmed plan, 1m/20s timing, SQLite deadline, persisted restart, unique phase events, no auto-next, lights pause and interrupted focus verified.')
} finally { await instance?.close() }
