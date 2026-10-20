import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, writeFile, readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron } from 'playwright'
import electronPath from 'electron'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { runtimeEnv, initializeTestBook, openSettings } from './runtime-env.mjs'
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..'); const data = join(root, '.local-data', 'notifications-smoke-' + randomUUID()); const sceneId = randomUUID()
const env = { ...runtimeEnv(root), LCA_DATA_DIR: data, LCA_PROVIDERS_FILE: join(data, 'absent.json'), LCA_CDP_PORT: '19543', LCA_MCP_PORT: '0' }; let instance; let page; let client
const snapshot = () => page.evaluate(() => window.lca.getSnapshot())
const send = (body) => page.evaluate(async (body) => { const s = await window.lca.getSnapshot(); return window.lca.dispatch({ protocolVersion: 1, epoch: s.epoch, requestId: crypto.randomUUID(), ...body }) }, body)
async function waitFor(test, message) { for (let i = 0; i < 100; i++) { if (test(await snapshot())) return; await new Promise((done) => setTimeout(done, 100)) }; throw new Error(message) }
async function launch() { instance = await _electron.launch({ executablePath: electronPath, args: [root], env }); page = await instance.firstWindow(); await initializeTestBook(page); const config = JSON.parse(await readFile(join(data, 'developer', sceneId, 'debug-connection.json'), 'utf8')); client = new Client({ name: 'notify-smoke', version: '1.0.0' }); await client.connect(new StreamableHTTPClientTransport(new URL(config.url), { requestInit: { headers: { Authorization: 'Bearer ' + config.token } } })) }
async function clock(nowMs) { const result = await client.callTool({ name: 'set_clock', arguments: { nowMs, frozen: true } }); assert.ok(!result.isError) }
try {
  await mkdir(data, { recursive: true }); await writeFile(join(data, 'settings.json'), JSON.stringify({ version: 1, developer: true, booth: false, plugins: {}, sceneId })); await launch()
  let now = Date.parse('2026-10-24T12:00:00+08:00'); await clock(now); await send({ type: 'mail.scan' }); await waitFor((s) => s.mailbox.status === 'ready', 'NOTIFY_MAIL_FAILED')
  await clock(now += 5000); assert.ok((await snapshot()).notifications.pendingCount >= 1); await clock(now += 16000); assert.equal((await snapshot()).notifications.sentLastHour, 1)
  await openSettings(page); await page.getByRole('textbox', { name: '提醒关键词' }).fill('第三次作业'); await page.getByRole('button', { name: '添加这个提醒标准' }).click(); assert.equal((await snapshot()).notifications.rules.length, 1)
  await client.close(); client = undefined; await instance.close(); await launch(); assert.equal((await snapshot()).notifications.rules.length, 1); await clock(now += 21000); assert.equal((await snapshot()).notifications.sentLastHour, 1)
  await openSettings(page); await page.getByRole('button', { name: '删除标准', exact: true }).click(); assert.equal((await snapshot()).notifications.rules.length, 0)
  console.log('Notifications Electron: actual mailbox deadline -> merged synthetic delivery, user rule controls/persistence/removal, and restart dedup verified; no OS toast in developer mode.')
} finally { await client?.close(); await instance?.close() }
