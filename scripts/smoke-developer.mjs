import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron } from 'playwright'
import electronPath from 'electron'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { runtimeEnv } from './runtime-env.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const data = join(root, '.local-data', `developer-smoke-${randomUUID()}`)
const env = { ...runtimeEnv(root), LCA_DATA_DIR: data, LCA_PROVIDERS_FILE: join(data, 'absent-test-providers.json'), LCA_MCP_PORT: '0', LCA_CDP_PORT: '19527' }
let instance; let client
async function launch(extra = {}) {
  instance = await _electron.launch({ executablePath: electronPath, args: [root], env: { ...env, ...extra }, timeout: 30_000 })
  const page = await instance.firstWindow(); await page.locator('[data-mode][data-pose]').waitFor()
  return page
}
try {
  let page = await launch()
  const normal = await page.evaluate(() => window.lca.getSnapshot())
  assert.equal(normal.runtime.developer.mode, 'normal'); assert.equal(normal.runtime.developer.mcpPort, undefined)
  const denied = await page.evaluate((epoch) => window.lca.dispatch({ protocolVersion: 1, epoch, requestId: crypto.randomUUID(), type: 'developer.clock', frozen: true }), normal.epoch)
  assert.equal(denied.status, 'rejected')
  await page.getByRole('button', { name: '工具与设置', exact: true }).click()
  await page.getByRole('checkbox', { name: /使用独立的假数据/ }).check()
  assert.equal((await page.evaluate(() => window.lca.getSnapshot())).runtime.developer.restartRequired, true)
  await instance.close()
  page = await launch()
  const development = await page.evaluate(() => window.lca.getSnapshot())
  assert.equal(development.runtime.developer.mode, 'developer')
  assert.equal(development.capabilities.find((item) => item.id === 'chat').source, 'fake')
  assert.notEqual(development.scope.sessionId, normal.scope.sessionId)
  const discovery = JSON.parse(await readFile(join(data, 'developer', development.runtime.developer.sceneId, 'debug-connection.json'), 'utf8'))
  assert.equal((await fetch(discovery.url, { method: 'POST' })).status, 403)
  const cdp = await fetch('http://127.0.0.1:19527/json/version'); assert.equal(cdp.ok, true)
  client = new Client({ name: 'lca-smoke', version: '1.0.0' })
  await client.connect(new StreamableHTTPClientTransport(new URL(discovery.url), { requestInit: { headers: { Authorization: `Bearer ${discovery.token}` } } }))
  await client.callTool({ name: 'set_clock', arguments: { frozen: true } })
  const before = await page.evaluate(() => window.lca.getSnapshot())
  await client.callTool({ name: 'set_clock', arguments: { nowMs: before.clock.nowMs + 60_000 } })
  const after = await page.evaluate(() => window.lca.getSnapshot())
  assert.equal(after.clock.nowMs, before.clock.nowMs + 60_000); assert.equal(after.clock.frozen, true)
  await client.callTool({ name: 'set_fake_model', arguments: { script: [
    { text: '', toolCalls: [{ id: 'c', name: 'get_clock', arguments: '{}' }], delayMs: 0 },
    { text: 'DEVELOPMENT_TEST_COMPLETED', toolCalls: [], delayMs: 0 },
  ] } })
  await page.locator('textarea').fill('synthetic development request')
  await page.getByRole('button', { name: '发送', exact: true }).click()
  await page.locator('.msg-text').filter({ hasText: 'DEVELOPMENT_TEST_COMPLETED' }).waitFor()
  const context = await client.callTool({ name: 'get_context', arguments: {} })
  assert.match(JSON.stringify(context), /get_clock/)
  const exported = await client.callTool({ name: 'export_scene', arguments: {} })
  const scene = JSON.parse(exported.content[0].text)
  assert.equal(scene.kind, 'development-fixture')
  const staged = await client.callTool({ name: 'load_scene', arguments: { scene } })
  assert.equal(JSON.parse(staged.content[0].text).restartRequired, true)
  await client.close(); client = undefined; await instance.close()
  page = await launch({ LCA_BOOTH: '1' })
  const booth = await page.evaluate(() => window.lca.getSnapshot())
  assert.equal(booth.runtime.developer.mode, 'booth'); assert.equal(booth.runtime.developer.mcpPort, undefined)
  const boothDenied = await page.evaluate((epoch) => window.lca.dispatch({ protocolVersion: 1, epoch, requestId: crypto.randomUUID(), type: 'developer.set', enabled: true }), booth.epoch)
  assert.equal(boothDenied.status, 'rejected')
  console.log('Developer smoke: isolated fake profile, authenticated MCP, clock control, tool loop, scene staging and booth refusal verified.')
} finally { await client?.close(); await instance?.close() }
