import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron } from 'playwright'
import electronPath from 'electron'
import JSZip from 'jszip'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { runtimeEnv, initializeTestBook } from './runtime-env.mjs'
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..'); const data = join(root, '.local-data', 'minecraft-' + randomUUID()); const sceneId = randomUUID(); const profile = join(data, 'developer', sceneId)
const env = { ...runtimeEnv(root), LCA_DATA_DIR: data, LCA_PROVIDERS_FILE: join(data, 'absent.json'), LCA_CDP_PORT: '19558', LCA_MCP_PORT: '0' }
let instance; let page; let client; let now = Date.parse('2026-10-17T12:00:00+08:00')
const snapshot = () => page.evaluate(() => window.lca.getSnapshot())
const send = (body) => page.evaluate(async (body) => { const s = await window.lca.getSnapshot(); return window.lca.dispatch({ ...body, protocolVersion: 1, epoch: s.epoch, requestId: crypto.randomUUID() }) }, body)
async function accepted(body) { const ack = await send(body); assert.equal(ack.status, 'accepted', body.type + ':' + JSON.stringify(ack)) }
async function waitFor(test, error) { for (let index = 0; index < 140; index++) { if (test(await snapshot())) return; await new Promise((done) => setTimeout(done, 100)) }; throw new Error(error) }
async function debug(name, args = {}) { const value = await client.callTool({ name, arguments: args }); assert.ok(!value.isError); return JSON.parse(value.content[0].text) }
async function launch() {
  instance = await _electron.launch({ executablePath: electronPath, args: [root], env }); page = await instance.firstWindow(); await initializeTestBook(page)
  const config = JSON.parse(await readFile(join(profile, 'debug-connection.json'), 'utf8')); client = new Client({ name: 'minecraft-smoke', version: '1.0.0' }); await client.connect(new StreamableHTTPClientTransport(new URL(config.url), { requestInit: { headers: { Authorization: 'Bearer ' + config.token } } }))
}
async function stop() { await client?.close(); client = undefined; await instance?.close(); instance = undefined }
async function advance() { now += 5000; await debug('set_clock', { nowMs: now, frozen: true }) }
async function rowsAt(dir) { const folder = join(dir, 'journals'); const owner = (await readdir(folder))[0]; return (await Promise.all((await readdir(join(folder, owner))).filter((name) => name.endsWith('.jsonl')).map((name) => readFile(join(folder, owner, name), 'utf8')))).join('\n').split('\n').filter(Boolean).map((line) => JSON.parse(line)) }
const call = (id, name, args) => ({ text: '', toolCalls: [{ id, name, arguments: JSON.stringify(args) }], delayMs: 0 })
try {
  await mkdir(profile, { recursive: true }); await writeFile(join(data, 'settings.json'), JSON.stringify({ version: 1, developer: true, booth: false, plugins: {}, sceneId })); await writeFile(join(profile, 'clock.json'), JSON.stringify({ nowMs: now, frozen: true, rate: 1 }))
  await launch(); await debug('set_fake_model', { script: [{ text: '普通私人对话回应', toolCalls: [], delayMs: 0 }] })
  // Privileged test instrumentation captures only this isolated fixture's random credential in main;
  // all assertions return booleans, never the value to renderer, debug bridge, or test output.
  await instance.evaluate(() => {
    const original = globalThis.fetch
    globalThis.fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      const auth = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined)).get('Authorization')
      if (url.startsWith('http://127.0.0.1:') && auth?.startsWith('Bearer ')) globalThis.syntheticGameCredential = auth.slice(7)
      return original(input, init)
    }
  })
  await accepted({ type: 'message.send', text: 'PERSONAL_CAMPUS_CANARY 不要出现在公开游戏里。' }); await waitFor((s) => s.task?.status === 'completed', 'ORDINARY_CHAT_FAILED')
  await instance.evaluate(({ dialog }) => { dialog.showMessageBox = async (options) => { assertNative(options); return { response: 1, checkboxChecked: false } }; function assertNative(options) { if (options.title !== '核对 MCP 启动配置') throw new Error('MISSING_NATIVE_MCP_REVIEW') } })
  await page.getByRole('button', { name: '工具与设置', exact: true }).click()
  await page.locator('.mcp-server[data-id="synthetic-game"]').getByRole('button', { name: '连接', exact: true }).click(); await page.getByRole('alertdialog', { name: 'MCP 连接确认' }).getByRole('button', { name: '确认此配置并连接', exact: true }).click()
  await waitFor((s) => s.mcp.servers.find((server) => server.id === 'synthetic-game')?.status === 'ready', 'GAME_MCP_CONNECT_FAILED')
  const publicServer = (await snapshot()).mcp.servers.find((server) => server.id === 'synthetic-public')
  await accepted({ type: 'mcp.connect', serverId: publicServer.id, fingerprint: publicServer.fingerprint }); await waitFor((s) => s.mcp.servers.find((server) => server.id === publicServer.id)?.status === 'ready', 'OTHER_MCP_CONNECT_FAILED')
  const alias = 'mcp_synthetic-game_' + createHash('sha256').update('navigate_to').digest('hex').slice(0, 12)
  await debug('set_fake_model', { script: [call('bypass', alias, { x: 2, y: 64, z: 0 }), { text: 'GENERIC_GAME_BYPASS_REJECTED', toolCalls: [], delayMs: 0 }] })
  await accepted({ type: 'message.send', text: '尝试尚未授权的普通 MCP 游戏别名。' }); await waitFor((s) => s.task?.status === 'completed' && s.messages.some((message) => message.text === 'GENERIC_GAME_BYPASS_REJECTED'), 'GENERIC_BYPASS_PROBE_FAILED')
  assert.ok((await rowsAt(profile)).some((row) => row.type === 'tool/call' && row.name === alias && row.templateId === 'tool.unavailable'))
  const controls = page.getByRole('region', { name: 'Minecraft 展位控制', exact: true })
  await controls.getByRole('button', { name: '核对游戏玩家', exact: true }).click(); await waitFor((s) => s.minecraft.status === 'ready', 'GAME_CHECK_FAILED')
  await controls.getByLabel('允许本轮公开游戏聊天').check(); await controls.getByRole('button', { name: '确认此玩家与范围并开始', exact: true }).click(); await waitFor((s) => s.minecraft.status === 'playing', 'GAME_START_FAILED')
  const roundId = (await snapshot()).minecraft.roundId; assert.equal((await snapshot()).minecraft.source, 'fake')
  await accepted({ type: 'mcp.disconnect', serverId: publicServer.id }); await waitFor((s) => s.mcp.servers.find((server) => server.id === publicServer.id)?.status === 'disconnected', 'OTHER_MCP_DISCONNECT_FAILED'); assert.equal((await snapshot()).minecraft.status, 'playing')
  await page.getByRole('button', { name: '关闭', exact: true }).click()
  await debug('set_fake_model', { script: [call('walk', 'minecraft_navigate', { x: 2, y: 64, z: 0 }), call('check', 'minecraft_navigation_status', {}), call('say', 'minecraft_chat', { message: 'SYNTHETIC_PUBLIC_REPLY' }), { text: 'GAME_ONLY_REPLY_CANARY', toolCalls: [], delayMs: 0 }] })
  await accepted({ type: 'message.send', text: 'GAME_ONLY_USER_CANARY 请走到旁边并打招呼。' }); await waitFor((s) => s.task?.status === 'completed' && s.messages.some((message) => message.text === 'GAME_ONLY_REPLY_CANARY'), 'GAME_TOOL_LOOP_FAILED')
  assert.equal((await snapshot()).minecraft.actionsUsed, 2); assert.equal((await snapshot()).minecraft.lastAction.status, 'succeeded')
  let gameRows = await rowsAt(join(profile, 'minecraft', roundId)); const frames = gameRows.filter((row) => row.type === 'model/seen'); assert.equal(frames.length, 4)
  for (const frame of frames) { assert.deepEqual(frame.eligibleIndexes, []); assert.ok(!JSON.stringify(frame.messages).includes('PERSONAL_CAMPUS_CANARY')) }
  assert.ok(gameRows.some((row) => row.type === 'tool/result' && row.visible.arrived === true))
  assert.ok(!JSON.stringify(await debug('get_context')).includes('GAME_ONLY_'))
  await debug('set_fake_model', { script: [{ text: 'GAME_EVENT_REPLY_CANARY', toolCalls: [], delayMs: 0 }] }); await accepted({ type: 'developer.minecraft', scenario: 'chat' }); await advance()
  await waitFor((s) => s.minecraft.chatSeen === 1 && s.messages.some((message) => message.text === 'GAME_EVENT_REPLY_CANARY'), 'GAME_CHAT_EVENT_FAILED')
  await debug('set_fake_model', { script: [{ text: 'NORMAL_AFTER_GAME', toolCalls: [], delayMs: 0 }] })
  await accepted({ type: 'mode.set', mode: 'quiet' }); await waitFor((s) => s.minecraft.status === 'idle' && s.minecraft.stopVerified, 'QUIET_DID_NOT_RELEASE_GAME')
  await accepted({ type: 'mode.set', mode: 'rest' }); await page.waitForTimeout(150)
  const ordinaryRows = await rowsAt(profile); assert.ok(!JSON.stringify(ordinaryRows).includes('GAME_ONLY_')); assert.ok(!JSON.stringify(ordinaryRows).includes('SYNTHETIC_GAME_CHAT_ONLY'))
  const archive = join(data, 'game-boundary.lca-save'); await instance.evaluate(({ dialog }, file) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: file }) }, archive)
  await accepted({ type: 'backup.export' }); await waitFor((s) => s.backup.status === 'exported', 'GAME_BOUNDARY_EXPORT_FAILED'); const zip = await JSZip.loadAsync(await readFile(archive))
  assert.ok(!Object.keys(zip.files).some((name) => name.includes('minecraft/')))
  for (const file of Object.values(zip.files).filter((file) => !file.dir)) { const bytes = await file.async('nodebuffer'); assert.ok(!bytes.includes(Buffer.from('GAME_ONLY_'))); assert.ok(!bytes.includes(Buffer.from('SYNTHETIC_GAME_CHAT_ONLY'))) }
  const pilot = (await snapshot()).minecraft.pilot.uuid
  const start = async () => { await accepted({ type: 'minecraft.start', serverId: 'synthetic-game', expectedPlayerUuid: pilot, scope: { radiusBlocks: 8, durationMs: 60000, allowChat: false } }); await waitFor((s) => s.minecraft.status === 'playing', 'SECOND_GAME_START_FAILED') }
  await start()
  await accepted({ type: 'pomodoro.plan', plan: { label: '专注停玩', plannedCount: 1, focusDurationMs: 60000, shortBreakDurationMs: 20000, longBreakDurationMs: 20000, longBreakEvery: 4, timing: 'demo' } })
  await accepted({ type: 'pomodoro.confirm', planId: (await snapshot()).pomodoro.proposal.id }); await accepted({ type: 'pomodoro.start', planId: (await snapshot()).pomodoro.plan.id })
  await waitFor((s) => s.minecraft.status === 'idle' && s.minecraft.stopVerified && s.pomodoro.phase === 'focus', 'FOCUS_DID_NOT_RELEASE_GAME')
  await accepted({ type: 'pomodoro.stop' }); await accepted({ type: 'mode.set', mode: 'rest' }); await accepted({ type: 'window.expand' }); await page.waitForTimeout(100)
  await start(); await accepted({ type: 'developer.minecraft', scenario: 'world-change' }); await advance(); await waitFor((s) => s.minecraft.status === 'failed' && s.minecraft.stopVerified, 'WORLD_CHANGE_DID_NOT_STOP')
  await page.waitForTimeout(100); await accepted({ type: 'developer.minecraft', scenario: 'ready' }); await start(); const badRound = (await snapshot()).minecraft.roundId
  await accepted({ type: 'developer.minecraft', scenario: 'unreachable' }); await debug('set_fake_model', { script: [call('bad-status', 'minecraft_navigation_status', {}), { text: 'BAD_STATUS_MUST_NOT_ADVANCE', toolCalls: [], delayMs: 0 }] })
  await accepted({ type: 'message.send', text: '核验不可信导航状态。' }); await waitFor((s) => s.minecraft.status === 'failed' && s.minecraft.stopVerified, 'PRIVATE_NAVIGATION_STATE_NOT_REJECTED')
  await page.waitForTimeout(100); const badRows = await rowsAt(join(profile, 'minecraft', badRound))
  assert.ok(badRows.some((row) => row.type === 'tool/call' && row.name === 'minecraft_navigation_status')); assert.ok(badRows.some((row) => row.type === 'tool/result' && !row.ok))
  assert.equal(await instance.evaluate((_electron, rows) => typeof globalThis.syntheticGameCredential === 'string' && !JSON.stringify(rows).includes(globalThis.syntheticGameCredential), badRows), true, 'CREDENTIAL_IN_GAME_JOURNAL')
  assert.equal(badRows.filter((row) => row.type === 'model/seen').length, 1, 'PRIVATE_STATUS_ADVANCED_MODEL')
  await accepted({ type: 'developer.minecraft', scenario: 'ready' }); await start()
  await debug('set_fake_model', { script: [call('disconnect-walk', 'minecraft_navigate', { x: 3, y: 64, z: 0 }), { text: 'ACTIVE_NAV_BEFORE_DISCONNECT', toolCalls: [], delayMs: 0 }] })
  await accepted({ type: 'message.send', text: '启动一段合成导航以核验主动断开。' }); await waitFor((s) => s.task?.status === 'completed' && s.minecraft.lastAction?.status === 'running', 'DISCONNECT_NAVIGATION_NOT_STARTED')
  await accepted({ type: 'mcp.disconnect', serverId: 'synthetic-game' }); await waitFor((s) => s.minecraft.status === 'idle' && s.minecraft.stopVerified && s.mcp.servers.find((server) => server.id === 'synthetic-game')?.status === 'disconnected', 'DISCONNECT_DID_NOT_VERIFY_RELEASE')
  assert.equal((await snapshot()).minecraft.lastAction.status, 'cancelled')
  const gameServer = (await snapshot()).mcp.servers.find((server) => server.id === 'synthetic-game'); await accepted({ type: 'mcp.connect', serverId: gameServer.id, fingerprint: gameServer.fingerprint }); await waitFor((s) => s.mcp.servers.find((server) => server.id === gameServer.id)?.status === 'ready', 'GAME_RECONNECT_FAILED')
  await page.waitForTimeout(100); await start(); const finalRound = (await snapshot()).minecraft.roundId
  await stop(); const settled = (await rowsAt(profile)).filter((row) => row.type === 'minecraft/round' && row.roundId === finalRound).at(-1); assert.equal(settled.status, 'stopped'); assert.equal(settled.stopVerified, true)
  await launch(); assert.equal((await snapshot()).minecraft.status, 'idle'); assert.ok((await snapshot()).mcp.servers.every((server) => server.status === 'disconnected')); assert.ok(!(await snapshot()).messages.some((message) => message.text.includes('GAME_ONLY_')))
  console.log('Minecraft Electron PASS: native MCP consent + real loopback synthetic-world transport, reviewed pilot/scope UI, isolated fake model navigation/status/chat, event tail/echo, focus release, world fence, private-save exclusion, shutdown verification and restart without reconnect/replay. No Minecraft instance or real model contacted.')
} finally { await stop() }
