import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron } from 'playwright'
import electronPath from 'electron'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { runtimeEnv, initializeTestBook, electronLaunchTarget } from './runtime-env.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..'); const data = join(root, '.local-data', 'minecraft-mining-' + randomUUID()); const sceneId = randomUUID(); const profile = join(data, 'developer', sceneId)
const env = { ...runtimeEnv(root), LCA_DATA_DIR: data, LCA_PROVIDERS_FILE: join(data, 'absent.json'), LCA_CDP_PORT: '19567', LCA_MCP_PORT: '0' }
let instance; let page; let client
const snapshot = () => page.evaluate(() => window.lca.getSnapshot())
const send = (body) => page.evaluate(async (body) => { const s = await window.lca.getSnapshot(); return window.lca.dispatch({ protocolVersion: 1, epoch: s.epoch, requestId: crypto.randomUUID(), ...body }) }, body)
async function accepted(body) { assert.equal((await send(body)).status, 'accepted', body.type) }
async function waitFor(predicate, code) { for (let i = 0; i < 200; i++) { if (predicate(await snapshot())) return; await new Promise((done) => setTimeout(done, 100)) }; throw new Error(code) }
async function launch() {
  instance = await _electron.launch({ ...electronLaunchTarget(root, electronPath), env }); page = await instance.firstWindow(); await initializeTestBook(page)
  const connection = JSON.parse(await readFile(join(profile, 'debug-connection.json'), 'utf8')); client = new Client({ name: 'mining-smoke', version: '1.0.0' })
  await client.connect(new StreamableHTTPClientTransport(new URL(connection.url), { requestInit: { headers: { Authorization: 'Bearer ' + connection.token } } }))
}
async function stop() { await client?.close(); client = undefined; await instance?.close(); instance = undefined }
async function rowsAt(base) {
  const result = []; const journals = join(base, 'journals')
  for (const owner of await readdir(journals)) for (const name of await readdir(join(journals, owner))) if (name.endsWith('.jsonl')) result.push(...(await readFile(join(journals, owner, name), 'utf8')).trim().split('\n').map((line) => JSON.parse(line)))
  return result
}
try {
  await mkdir(profile, { recursive: true }); await writeFile(join(data, 'settings.json'), JSON.stringify({ version: 1, developer: true, booth: false, plugins: {}, sceneId }))
  await writeFile(join(profile, 'clock.json'), JSON.stringify({ nowMs: Date.parse('2026-10-17T12:00:00+08:00'), frozen: true, rate: 1 }))
  await launch(); await instance.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false }) })
  await page.getByRole('button', { name: '工具与设置', exact: true }).click()
  await page.locator('.mcp-server[data-id="synthetic-game"]').getByRole('button', { name: '连接', exact: true }).click()
  await page.getByRole('alertdialog', { name: 'MCP 连接确认' }).getByRole('button', { name: '确认此配置并连接', exact: true }).click()
  await waitFor((s) => s.mcp.servers.find((server) => server.id === 'synthetic-game')?.status === 'ready', 'MCP_FAILED')
  const controls = page.getByRole('region', { name: 'Minecraft 展位控制', exact: true })
  await controls.getByRole('button', { name: '核对游戏玩家', exact: true }).click(); await waitFor((s) => s.minecraft.status === 'ready', 'PLAYER_FAILED')
  assert.ok((await snapshot()).minecraft.features.includes('mining'))
  const consent = controls.getByLabel('允许本轮近身生存挖掘（泥土／草方块／石头／圆石）'); assert.equal(await consent.isChecked(), false); await consent.check()
  await controls.getByRole('button', { name: '确认此玩家与范围并开始', exact: true }).click(); await waitFor((s) => s.minecraft.status === 'playing', 'START_FAILED')
  assert.equal((await snapshot()).minecraft.scope.allowMining, true); const round = (await snapshot()).minecraft.roundId
  await page.getByRole('button', { name: '关闭', exact: true }).click()
  const step = (id, name, args) => ({ text: '', toolCalls: [{ id, name, arguments: JSON.stringify(args) }], delayMs: 0 })
  const scripted = await client.callTool({ name: 'set_fake_model', arguments: { script: [step('scene', 'minecraft_scene', {}), step('mine', 'minecraft_mine', { x: 1, y: 64, z: 1, expectedBlockId: 'minecraft:stone' }), step('inventory', 'minecraft_inventory', {}), { text: 'MC_MINING_REPLY', toolCalls: [], delayMs: 0 }] } }); assert.ok(!scripted.isError)
  await accepted({ type: 'message.send', text: 'GAME_MINING_ONLY_PROMPT 按本轮范围尝试近身挖石头，再核对背包。' })
  await waitFor((s) => s.task?.status === 'completed' && s.messages.some((message) => message.text === 'MC_MINING_REPLY'), 'MINING_CHAIN_FAILED')
  assert.equal((await snapshot()).minecraft.actionsUsed, 1); assert.deepEqual((await snapshot()).minecraft.lastAction.kind, 'mine'); assert.equal((await snapshot()).minecraft.lastAction.status, 'succeeded')
  const gameRows = await rowsAt(join(profile, 'minecraft', round)); const mineCall = gameRows.find((row) => row.type === 'tool/call' && row.name === 'minecraft_mine'); const mine = gameRows.find((row) => row.type === 'tool/result' && row.callId === mineCall.callId)
  assert.equal(mine.ok, true); assert.equal(mine.visible.removedObserved, true); assert.equal(mine.visible.inputStopped, true); assert.equal(mine.visible.pickupVerified, false); assert.equal(mine.visible.breakAttributedToPilot, false)
  assert.equal(mine.visible.observedBlockId, 'minecraft:air'); assert.ok(!JSON.stringify(gameRows).includes('GAME_ONLY_MINING_PRIVATE'))
  const inventoryCall = gameRows.find((row) => row.type === 'tool/call' && row.name === 'minecraft_inventory'); const inventory = gameRows.find((row) => row.type === 'tool/result' && row.callId === inventoryCall.callId); assert.equal(inventory.visible.hotbar.length, 1); assert.equal(inventory.visible.hotbar[0].id, 'minecraft:stone_pickaxe')
  assert.ok(gameRows.filter((row) => row.type === 'model/seen').every((row) => row.eligibleIndexes.length === 0))
  await accepted({ type: 'minecraft.stop' }); await waitFor((s) => s.minecraft.status === 'idle' && s.minecraft.stopVerified, 'RELEASE_FAILED')
  const mainRows = await rowsAt(profile); assert.ok(!JSON.stringify(mainRows).includes('GAME_MINING_ONLY') && !JSON.stringify(mainRows).includes('MC_MINING_REPLY'))
  assert.equal(mainRows.filter((row) => row.type === 'minecraft/round' && row.roundId === round).at(-1).stopVerified, true)
  await stop(); await launch(); assert.equal((await snapshot()).minecraft.status, 'idle'); assert.ok((await snapshot()).mcp.servers.every((server) => server.status === 'disconnected'))
  assert.ok(!(await snapshot()).messages.some((message) => message.text.includes('GAME_MINING_ONLY')))
  await mkdir(join(root, 'test-results'), { recursive: true }); await writeFile(join(root, 'test-results/minecraft-mining-report.json'), JSON.stringify({ ok: true, atIso: new Date().toISOString(), syntheticWorldAndModel: true, nativeConsent: true, actualMcpSurvivalOnly: true, observedTargetAirAndOwnedInputStopped: true, pickupNotClaimed: true, inventoryRechecked: true, ordinaryContextExcluded: true, verifiedStopAndRestart: true, realMinecraftUsed: false }, null, 2))
  console.log('Minecraft mining PASS: native separate round consent, real loopback MCP survival-only break after scene/harvest checks, observed target air plus owned input stopped, inventory recheck without pickup/attribution claim, ordinary exclusion and verified release/restart. Synthetic world/model only.')
} finally { await stop() }
