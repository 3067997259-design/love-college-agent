import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import ts from 'typescript'
import JSZip from 'jszip'
import { _electron } from 'playwright'
import electronPath from 'electron'
import { runtimeEnv, initializeTestBook, electronLaunchTarget } from './runtime-env.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const data = join(root, '.local-data', 'minecraft-images-' + randomUUID()); const profile = join(data, 'booth')
await mkdir(data, { recursive: true })
// Reuse only this repository's explicit synthetic MCP fixture in the Node test server.
for (const [source, target, replacements] of [
  ['minecraft/fixture-image.ts', 'fixture-image.mjs', []],
  ['minecraft/fixture.ts', 'fixture-game.mjs', [["'./fixture-image'", "'./fixture-image.mjs'"]]],
  ['mcp/fixture.ts', 'fixture-mcp.mjs', [["'../minecraft/fixture'", "'./fixture-game.mjs'"]]],
]) {
  let code = ts.transpileModule(await readFile(join(root, 'src/main', source), 'utf8'), { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText
  for (const [from, to] of replacements) code = code.replace(from, to)
  await writeFile(join(data, target), code)
}
const { startMcpFixture } = await import(pathToFileURL(join(data, 'fixture-mcp.mjs')).href)
const fixture = await startMcpFixture({ after: (ms, callback) => { const timer = setTimeout(callback, ms); return () => clearTimeout(timer) } })
const requests = []; let gameCount = 0
const server = createServer((request, response) => { void (async () => {
  let text = ''; for await (const chunk of request) text += chunk
  const body = JSON.parse(text); const game = body.messages.some((message) => typeof message.content === 'string' && message.content.includes('陪你玩：展位 Minecraft'))
  const images = body.messages.flatMap((message) => Array.isArray(message.content) ? message.content.filter((part) => part.type === 'image_url').map((part) => part.image_url.url) : [])
  requests.push({ body, game, images })
  let delta; let reason = 'stop'
  if (game && gameCount++ < 2) { delta = { tool_calls: [{ index: 0, id: 'synthetic-shot-' + gameCount, type: 'function', function: { name: 'minecraft_screenshot', arguments: '{}' } }] }; reason = 'tool_calls' }
  else delta = { content: game ? 'GAME_IMAGE_ONLY_REPLY' : 'ORDINARY_ONLY_REPLY' }
  response.writeHead(200, { 'Content-Type': 'text/event-stream' }).end('data: ' + JSON.stringify({ choices: [{ index: 0, delta, finish_reason: reason }] }) + '\n\ndata: [DONE]\n\n')
})().catch(() => { if (!response.headersSent) response.writeHead(500); response.end() }) })
await new Promise((done) => server.listen(0, '127.0.0.1', done))
const providers = join(data, 'synthetic-providers.json'); const mcp = join(data, 'synthetic-mcp.json')
await writeFile(providers, JSON.stringify({ providers: { chat: { base_url: 'http://127.0.0.1:' + server.address().port + '/v1', api_key: 'synthetic-image-model-key', model: 'synthetic-game-image-model' } } }))
await writeFile(mcp, JSON.stringify(fixture.config))
const env = { ...runtimeEnv(root), LCA_DATA_DIR: data, LCA_PROVIDERS_FILE: providers, LCA_MCP_CONFIG: mcp, LCA_BOOTH: '1' }
let instance; let page
const snapshot = () => page.evaluate(() => window.lca.getSnapshot())
const send = (body) => page.evaluate(async (body) => { const s = await window.lca.getSnapshot(); return window.lca.dispatch({ protocolVersion: 1, epoch: s.epoch, requestId: crypto.randomUUID(), ...body }) }, body)
async function accepted(body) { assert.equal((await send(body)).status, 'accepted', body.type) }
async function waitFor(predicate, code) { for (let i = 0; i < 250; i++) { if (predicate(await snapshot())) return; await new Promise((done) => setTimeout(done, 100)) }; throw new Error(code) }
async function launch() { instance = await _electron.launch({ ...electronLaunchTarget(root, electronPath), env }); page = await instance.firstWindow(); await initializeTestBook(page) }
async function stop() { await instance?.close(); instance = undefined }
async function rowsAt(base) {
  const journals = join(base, 'journals'); const result = []
  for (const owner of await readdir(journals)) for (const name of await readdir(join(journals, owner))) if (name.endsWith('.jsonl')) result.push(...(await readFile(join(journals, owner, name), 'utf8')).trim().split('\n').map((line) => JSON.parse(line)))
  return result
}
try {
  await launch(); assert.equal((await snapshot()).runtime.developer.mode, 'booth')
  await accepted({ type: 'message.send', text: 'PERSONAL_IMAGE_CONTEXT_CANARY 留在普通书本。' })
  await waitFor((s) => s.task?.status === 'completed', 'ORDINARY_PRECONDITION_FAILED')
  await instance.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false }) })
  await page.getByRole('button', { name: '工具与设置', exact: true }).click()
  await page.locator('.mcp-server[data-id="synthetic-game"]').getByRole('button', { name: '连接', exact: true }).click()
  await page.getByRole('alertdialog', { name: 'MCP 连接确认' }).getByRole('button', { name: '确认此配置并连接', exact: true }).click()
  await waitFor((s) => s.mcp.servers.find((item) => item.id === 'synthetic-game')?.status === 'ready', 'MCP_CONNECT_FAILED')
  const controls = page.getByRole('region', { name: 'Minecraft 展位控制', exact: true })
  await controls.getByRole('button', { name: '核对游戏玩家', exact: true }).click(); await waitFor((s) => s.minecraft.status === 'ready', 'GAME_CHECK_FAILED')
  assert.ok((await snapshot()).minecraft.features.includes('screenshot'))
  const consent = controls.getByLabel('允许本轮游戏截图交给游戏模型'); assert.equal(await consent.isChecked(), false); await consent.check()
  await controls.getByRole('button', { name: '确认此玩家与范围并开始', exact: true }).click(); await waitFor((s) => s.minecraft.status === 'playing', 'GAME_START_FAILED')
  const round = (await snapshot()).minecraft.roundId; assert.equal((await snapshot()).minecraft.scope.allowScreenshots, true)
  await page.getByRole('button', { name: '关闭', exact: true }).click()
  await accepted({ type: 'message.send', text: 'GAME_IMAGE_ONLY_PROMPT 请看两帧合成游戏画面。' })
  await waitFor((s) => s.task?.status === 'completed' && s.messages.some((message) => message.text === 'GAME_IMAGE_ONLY_REPLY'), 'GAME_IMAGE_ROUND_FAILED')
  const gameRequests = requests.filter((item) => item.game); assert.equal(gameRequests.length, 3)
  assert.deepEqual(gameRequests.map((item) => item.images.length), [0, 1, 2])
  assert.ok(gameRequests.every((item) => !JSON.stringify(item.body).includes('PERSONAL_IMAGE_CONTEXT_CANARY')))
  assert.ok(gameRequests.every((item) => item.body.tools.some((tool) => tool.function.name === 'minecraft_screenshot')))
  const urls = gameRequests.at(-1).images; assert.ok(urls.every((url) => url.startsWith('data:image/jpeg;base64,')))
  assert.equal(await instance.evaluate(({ nativeImage }, image) => { const bitmap = nativeImage.createFromBuffer(Buffer.from(image.split(',')[1], 'base64')); const size = bitmap.getSize(); return !bitmap.isEmpty() && size.width === 16 && size.height === 12 }, urls[0]), true)
  const gameRows = await rowsAt(join(profile, 'minecraft', round)); const mainRows = await rowsAt(profile)
  const frames = gameRows.filter((row) => row.type === 'model/seen'); assert.equal(frames.length, 3); assert.ok(frames.every((row) => row.eligibleIndexes.length === 0))
  const refs = frames.at(-1).messages.flatMap((message) => message.imageRefs ?? []); assert.equal(refs.length, 2); assert.ok(refs.every((ref) => /^game-frame:[a-f0-9]{64}$/.test(ref)))
  const reservations = gameRows.filter((row) => row.type === 'model/attempt' && row.status === 'started'); assert.ok(reservations.at(-1).reservedTokens > 32768)
  assert.deepEqual(mainRows.filter((row) => row.type === 'model/attempt' && row.turnId === 'minecraft:' + round && row.status === 'started').map((row) => row.reservedTokens), reservations.map((row) => row.reservedTokens))
  assert.ok(!JSON.stringify(gameRows).includes('data:image')); assert.ok(!JSON.stringify(mainRows).includes('game-frame:')); assert.ok(!JSON.stringify(mainRows).includes('GAME_IMAGE_ONLY'))
  assert.ok(!JSON.stringify(await snapshot()).includes('data:image/jpeg'))
  await accepted({ type: 'minecraft.stop' }); await waitFor((s) => s.minecraft.status === 'idle' && s.minecraft.stopVerified, 'STOP_NOT_VERIFIED')
  await waitFor((s) => s.task?.status !== 'running', 'ORDINARY_EVENT_DID_NOT_SETTLE')
  await accepted({ type: 'message.send', text: '普通上下文再次核对。' }); await waitFor((s) => s.task?.status === 'completed', 'ORDINARY_RETURN_FAILED')
  const ordinary = requests.filter((item) => !item.game).at(-1); assert.equal(ordinary.images.length, 0); assert.ok(!JSON.stringify(ordinary.body).includes('GAME_IMAGE_ONLY')); assert.ok(!JSON.stringify(ordinary.body).includes('game-frame:'))
  const archive = join(data, 'game-image-exclusion.lca-save')
  await instance.evaluate(({ dialog }, file) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: file }) }, archive)
  await accepted({ type: 'backup.export' }); await waitFor((s) => s.backup.status === 'exported', 'EXPORT_FAILED')
  const zip = await JSZip.loadAsync(await readFile(archive)); assert.ok(Object.keys(zip.files).every((name) => !name.startsWith('minecraft/')))
  for (const file of Object.values(zip.files).filter((file) => !file.dir && /\.(json|jsonl|md)$/.test(file.name))) { const value = await file.async('string'); assert.ok(!value.includes('game-frame:') && !value.includes('GAME_IMAGE_ONLY') && !value.includes('data:image/jpeg')) }
  await stop(); await launch(); assert.equal((await snapshot()).minecraft.status, 'idle'); assert.equal((await snapshot()).task?.status === 'running', false)
  assert.ok(!(await snapshot()).messages.some((message) => message.text.includes('GAME_IMAGE_ONLY')))
  await mkdir(join(root, 'test-results'), { recursive: true }); await writeFile(join(root, 'test-results/minecraft-images-report.json'), JSON.stringify({ ok: true, atIso: new Date().toISOString(), mode: 'booth', syntheticMcpAndPixelsAndModel: true, nativeImageDecoded: true, actualCompatibleMultimodalHttp: true, imageCounts: [0, 1, 2], sharedImageReservations: true, ordinaryContextAndPrivateSaveExcluded: true, stopAndRestartConsistent: true, realMinecraftOrProviderUsed: false }, null, 2))
  console.log('Minecraft pixels PASS: booth/native consent, fixed MCP image outlet, actual PNG decode/JPEG multimodal HTTP, latest two game-only frames, image budget mirrored, ordinary/private-save exclusion and stopped restart. Synthetic world/pixels/model; no real Minecraft or provider.')
} finally { await stop(); await fixture.close(); server.closeAllConnections(); await new Promise((done) => server.close(done)) }
