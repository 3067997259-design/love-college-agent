import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron } from 'playwright'
import electronPath from 'electron'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { runtimeEnv, initializeTestBook } from './runtime-env.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..'); const data = join(root, '.local-data', 'mcp-smoke-' + randomUUID()); const sceneId = randomUUID()
const profile = join(data, 'developer', sceneId)
const env = { ...runtimeEnv(root), LCA_DATA_DIR: data, LCA_PROVIDERS_FILE: join(data, 'absent-test-providers.json'), LCA_MCP_PORT: '0', LCA_CDP_PORT: '19532' }
let instance; let page; let client
async function launch() { instance = await _electron.launch({ executablePath: electronPath, args: [root], env, timeout: 30_000 }); page = await instance.firstWindow(); await initializeTestBook(page); await page.locator('[data-mode][data-pose]').waitFor() }
const snapshot = () => page.evaluate(() => window.lca.getSnapshot())
async function waitFor(predicate, error) { for (let i = 0; i < 150; i++) { if (predicate(await snapshot())) return; await new Promise((done) => setTimeout(done, 100)) } throw new Error(error) }
const send = (body) => page.evaluate(async (body) => { const s = await window.lca.getSnapshot(); return window.lca.dispatch({ ...body, epoch: s.epoch, protocolVersion: 1, requestId: crypto.randomUUID() }) }, body)
const tools = () => page.getByRole('button', { name: '工具与设置', exact: true }).click()
const closeTools = () => page.getByRole('button', { name: '关闭', exact: true }).click()
const safe = (value) => { const text = JSON.stringify(value); for (const marker of ['RAW_ONLY_MCP_PRIVATE', 'sk-synthetic', 'Authorization', 'http://127.0.0.1:', 'SYNTHETIC_CONFIG_VALUE']) assert.ok(!text.includes(marker), 'MCP_PRIVATE_LEAK') }
const mcp = async (name, args = {}) => { const result = await client.callTool({ name, arguments: args }); assert.ok(!result.isError, 'MCP_OPERATION_FAILED'); return JSON.parse(result.content[0].text) }
const publicName = (server, tool) => 'mcp_' + server + '_' + createHash('sha256').update(tool).digest('hex').slice(0, 12)
async function runTool(server, tool, expected) {
  await mcp('set_fake_model', { script: [{ text: '', toolCalls: [{ id: 'call', name: publicName(server, tool), arguments: '{}' }], delayMs: 0 }, { text: expected, toolCalls: [], delayMs: 0 }] })
  assert.equal((await send({ type: 'message.send', text: 'synthetic external tool request' })).status, 'accepted')
  await waitFor((s) => s.task?.status === 'completed' && s.messages.some((message) => message.text === expected), 'MCP_HARNESS_FAILED')
}
try {
  await mkdir(data, { recursive: true }); await launch(); assert.equal((await snapshot()).mcp.servers.length, 0)
  assert.equal(await page.evaluate(() => window.lca.readDiagnostics().then(() => false, () => true)), true)
  const invalid = join(data, 'invalid-mcp.json'); await writeFile(invalid, '{"mcpServers":{"invalid":{"url":"SYNTHETIC_CONFIG_VALUE"}}}')
  await instance.evaluate(({ dialog }, file) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }) }, invalid)
  await tools(); await page.getByRole('button', { name: '导入 MCP 配置', exact: true }).click()
  await waitFor((s) => s.mcp.error?.code === 'configuration-failed', 'INVALID_CONFIG_NOT_REJECTED'); safe(await snapshot())
  await instance.close(); await writeFile(join(data, 'settings.json'), JSON.stringify({ version: 1, developer: true, booth: false, plugins: {}, sceneId }))
  await launch(); await tools()
  let nativeConsentCount = 0
  await instance.evaluate(({ dialog }) => { dialog.showMessageBox = async (options) => {
    if (options.title !== '核对 MCP 启动配置' || !options.detail.startsWith('服务地址：http://127.0.0.1:')) throw new Error('NATIVE_TARGET_REVIEW_MISSING')
    return { response: 0, checkboxChecked: false }
  } })
  const refused = (await snapshot()).mcp.servers[0]
  await send({ type: 'mcp.connect', serverId: refused.id, fingerprint: refused.fingerprint })
  await page.waitForTimeout(200); assert.equal((await snapshot()).mcp.servers[0].status, 'disconnected')
  await instance.evaluate(({ dialog }) => { globalThis.lcaNativeConsentCount = 0; dialog.showMessageBox = async (options) => {
    if (options.title !== '核对 MCP 启动配置' || !options.detail.startsWith('服务地址：http://127.0.0.1:')) throw new Error('NATIVE_TARGET_REVIEW_MISSING')
    globalThis.lcaNativeConsentCount++; return { response: 1, checkboxChecked: false }
  } })
  for (const id of ['synthetic-public', 'synthetic-private']) {
    await page.locator(`.mcp-server[data-id="${id}"]`).getByRole('button', { name: '连接', exact: true }).click()
    await page.getByRole('alertdialog', { name: 'MCP 连接确认' }).getByRole('button', { name: '确认此配置并连接', exact: true }).click()
    await waitFor((s) => s.mcp.servers.find((server) => server.id === id)?.status === 'ready', 'MCP_CONNECTION_FAILED')
  }
  const server = (await snapshot()).mcp.servers[0]
  nativeConsentCount = await instance.evaluate(() => globalThis.lcaNativeConsentCount); assert.equal(nativeConsentCount, 2)
  assert.equal((await send({ type: 'mcp.connect', serverId: server.id, fingerprint: '0'.repeat(64) })).error.code, 'permission-denied')
  await closeTools()
  const discovery = JSON.parse(await readFile(join(profile, 'debug-connection.json'), 'utf8')); client = new Client({ name: 'lca-mcp-smoke', version: '1.0.0' })
  await client.connect(new StreamableHTTPClientTransport(new URL(discovery.url), { requestInit: { headers: { Authorization: 'Bearer ' + discovery.token } } }))
  await runTool('synthetic-public', 'synthetic_public', 'SYNTHETIC_MCP_PUBLIC_COMPLETE')
  let context = await mcp('get_context'); assert.ok(JSON.stringify(context).includes('SYNTHETIC_MCP_PUBLIC')); safe(context)
  await runTool('synthetic-private', 'synthetic_read', 'SYNTHETIC_MCP_PRIVATE_COMPLETE')
  context = await mcp('get_context'); safe(context); assert.ok(JSON.stringify(context).includes('untrusted'))
  await runTool('synthetic-private', 'synthetic_invalid', 'SYNTHETIC_MCP_INVALID_COMPLETE')
  context = await mcp('get_context'); assert.ok(JSON.stringify(context).includes('mcp-invalid-result')); safe(context)
  const diagnostics = await page.evaluate(() => window.lca.readDiagnostics()); safe(diagnostics)
  assert.equal(diagnostics.contextSource, 'last-successful-input'); assert.ok(diagnostics.turns.length >= 3); assert.ok(diagnostics.queue.length > 0)
  assert.ok(diagnostics.turns.every((turn) => turn.cost === null && turn.cachedInputTokens === null && turn.firstTokenLatencyMs === null))
  safe(await mcp('get_diagnostics'))
  await mcp('set_fake_model', { script: [{ text: '', toolCalls: [{ id: 'wait', name: publicName('synthetic-private', 'synthetic_wait'), arguments: '{}' }], delayMs: 0 }] })
  await send({ type: 'message.send', text: 'synthetic cancellable external call' })
  await waitFor((s) => s.activities.at(-1)?.status === 'running', 'MCP_CALL_NOT_STARTED')
  await send({ type: 'turn.stop', taskId: (await snapshot()).task.id }); await waitFor((s) => s.task?.status === 'aborted', 'MCP_STOP_FAILED')
  await tools(); await page.locator('.mcp-server[data-id="synthetic-private"]').getByRole('button', { name: '断开', exact: true }).click()
  await page.getByRole('button', { name: '刷新安全诊断', exact: true }).click(); await page.getByText('回合记录 · 4', { exact: true }).waitFor()
  await waitFor((s) => s.mcp.servers.find((item) => item.id === 'synthetic-private').status === 'disconnected', 'MCP_DISCONNECT_FAILED')
  safe(await snapshot()); safe(await mcp('get_context')); safe(await mcp('get_state'))
  for (const folder of await readdir(join(profile, 'journals'))) for (const name of await readdir(join(profile, 'journals', folder))) if (name.endsWith('.jsonl')) safe(await readFile(join(profile, 'journals', folder, name), 'utf8'))
  await client.close(); client = undefined; await instance.close(); await launch()
  assert.ok((await snapshot()).mcp.servers.every((item) => item.status === 'disconnected'), 'MCP_IMPLICIT_RECONNECT')
  console.log('MCP smoke: native private configuration import/refusal, exact fingerprint consent, real HTTP discovery, allowlisted harness tools, privacy-only journal result, malformed result refusal, stop/disconnect, safe MCP views and no automatic reconnect; synthetic services only.')
} finally { await client?.close(); await instance?.close() }
