import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron } from 'playwright'
import electronPath from 'electron'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { runtimeEnv, initializeTestBook, openSettingsGroup, openSettings } from './runtime-env.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const data = join(root, '.local-data', `developer-smoke-${randomUUID()}`)
const env = { ...runtimeEnv(root), LCA_DATA_DIR: data, LCA_PROVIDERS_FILE: join(data, 'absent-test-providers.json'), LCA_MCP_PORT: '0', LCA_CDP_PORT: '19527' }
let instance; let client
async function launch(extra = {}) {
  instance = await _electron.launch({ executablePath: electronPath, args: [root], env: { ...env, ...extra }, timeout: 30_000 })
  const page = await instance.firstWindow(); await initializeTestBook(page); await page.locator('[data-mode][data-pose]').waitFor()
  return page
}
try {
  let page = await launch()
  const normal = await page.evaluate(() => window.lca.getSnapshot())
  assert.equal(normal.runtime.developer.mode, 'normal'); assert.equal(normal.runtime.developer.mcpPort, undefined)
  const denied = await page.evaluate((epoch) => window.lca.dispatch({ protocolVersion: 1, epoch, requestId: crypto.randomUUID(), type: 'developer.clock', frozen: true }), normal.epoch)
  assert.equal(denied.status, 'rejected')
  await openSettings(page)
  await openSettingsGroup(page, '高级与开发')
  await page.getByRole('checkbox', { name: /使用独立的假数据/ }).click()
  await page.getByRole('button', { name: '重启应用', exact: true }).waitFor()
  assert.equal((await page.evaluate(() => window.lca.getSnapshot())).runtime.developer.restartRequired, true)
  await instance.close()
  const settings = JSON.parse(await readFile(join(data, 'settings.json'), 'utf8'))
  settings.sceneId = randomUUID()
  await writeFile(join(data, 'settings.json'), JSON.stringify(settings))
  const pluginFolder = join(data, 'developer', settings.sceneId, 'plugins', 'synthetic')
  await mkdir(pluginFolder, { recursive: true })
  await writeFile(join(pluginFolder, 'manifest.json'), JSON.stringify({ apiVersion: 1, id: 'synthetic', name: '合成插件验收', version: '1.0.0', description: 'Synthetic Electron integration fixture',
    entry: 'index.cjs', privacy: 'none', permissions: ['local-code'], tools: [{ name: 'synthetic_fixture', description: 'Synthetic fixture', templateId: 'fixture.synthetic', parameters: { type: 'object', properties: {}, additionalProperties: false } }] }))
  await writeFile(join(pluginFolder, 'index.cjs'), 'const fs=require("node:fs");const marker=__dirname+"/initialized";if(fs.existsSync(marker)) throw new Error("initialization repeated");fs.writeFileSync(marker,"once");module.exports={tools:{synthetic_fixture:async()=>({ok:true,raw:{original:"SYNTHETIC_RAW_ONLY"},visible:{ok:true}})}}')
  page = await launch()
  const development = await page.evaluate(() => window.lca.getSnapshot())
  assert.equal(development.runtime.developer.mode, 'developer')
  assert.equal(development.capabilities.find((item) => item.id === 'chat').source, 'fake')
  assert.notEqual(development.scope.sessionId, normal.scope.sessionId)
  const plugin = development.runtime.plugins.find((item) => item.id === 'synthetic')
  assert.equal(plugin.status, 'needs-approval'); assert.equal(await stat(join(pluginFolder, 'initialized')).then(() => true, () => false), false)
  await openSettings(page)
  await page.locator('.tools-plugin').filter({ hasText: '合成插件验收' }).getByRole('button', { name: '启用', exact: true }).click()
  await page.getByRole('button', { name: '确认此版本并启用', exact: true }).click()
  assert.equal(await readFile(join(pluginFolder, 'initialized'), 'utf8'), 'once')
  const repeated = await page.evaluate(async (plugin) => { const s = await window.lca.getSnapshot(); return window.lca.dispatch({ protocolVersion: 1, epoch: s.epoch, requestId: crypto.randomUUID(), type: 'plugin.enable', pluginId: plugin.id, fingerprint: plugin.fingerprint }) }, plugin)
  assert.equal(repeated.status, 'accepted')
  await page.getByRole('button', { name: '关闭', exact: true }).click()
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
    { text: '', toolCalls: [{ id: 'p', name: 'synthetic_fixture', arguments: '{}' }], delayMs: 0 },
    { text: 'DEVELOPMENT_TEST_COMPLETED', toolCalls: [], delayMs: 0 },
  ] } })
  await page.locator('textarea').fill('synthetic development request')
  await page.getByRole('button', { name: '发送', exact: true }).click()
  await page.locator('.msg-text').filter({ hasText: 'DEVELOPMENT_TEST_COMPLETED' }).waitFor()
  // Her turn ran on DSH with the scripted model: both tools ran as activities. get_context is DSH's last request: it
  // carries both calls and their results, never the plugin's raw-only output; LCA's state never has it either.
  const state = JSON.parse((await client.callTool({ name: 'get_state', arguments: {} })).content[0].text)
  for (const templateId of ['clock.read', 'fixture.synthetic']) assert.ok(state.activities.some((activity) => activity.templateId === templateId && activity.status === 'completed'), templateId)
  const context = JSON.stringify(await client.callTool({ name: 'get_context', arguments: {} }))
  assert.match(context, /lca_get_clock/); assert.match(context, /lca_synthetic_fixture/)
  assert.ok(![context, JSON.stringify(state)].some((text) => text.includes('SYNTHETIC_RAW_ONLY')))
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
  console.log('Developer smoke: isolated fake profile, authenticated MCP, clock control, scripted model on DSH, approved folder plugin, narrow tool results, scene staging and booth refusal verified.')
} finally { await client?.close(); await instance?.close() }
