import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron } from 'playwright'
import electronPath from 'electron'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { runtimeEnv, initializeTestBook } from './runtime-env.mjs'
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..'); const data = join(root, '.local-data', 'fetch-smoke-' + randomUUID()); const sceneId = randomUUID(); const profile = join(data, 'developer', sceneId)
const env = { ...runtimeEnv(root), LCA_DATA_DIR: data, LCA_PROVIDERS_FILE: join(data, 'absent.json'), LCA_CDP_PORT: '19552', LCA_MCP_PORT: '0' }; let instance; let page; let client
const snapshot = () => page.evaluate(() => window.lca.getSnapshot())
const send = (body) => page.evaluate(async (body) => { const s = await window.lca.getSnapshot(); return window.lca.dispatch({ protocolVersion: 1, epoch: s.epoch, requestId: crypto.randomUUID(), ...body }) }, body)
async function waitFor(test, message) { for (let i = 0; i < 100; i++) { if (test(await snapshot())) return; await new Promise((done) => setTimeout(done, 100)) }; throw new Error(message) }
const debug = async (name, args = {}) => { const result = await client.callTool({ name, arguments: args }); assert.ok(!result.isError); return JSON.parse(result.content[0].text) }
async function launch() { instance = await _electron.launch({ executablePath: electronPath, args: [root], env }); page = await instance.firstWindow(); await initializeTestBook(page); const config = JSON.parse(await readFile(join(profile, 'debug-connection.json'), 'utf8')); client = new Client({ name: 'fetch-smoke', version: '1.0.0' }); await client.connect(new StreamableHTTPClientTransport(new URL(config.url), { requestInit: { headers: { Authorization: 'Bearer ' + config.token } } })); await debug('set_clock', { frozen: true }) }
async function close() { await client?.close(); client = undefined; await instance?.close(); instance = undefined }
const script = (url) => debug('set_fake_model', { script: [{ text: '', toolCalls: [{ id: 'fetch', name: 'desk_web_fetch', arguments: JSON.stringify({ url }) }], delayMs: 0 }, { text: 'SYNTHETIC_WEB_RESPONSE', toolCalls: [], delayMs: 0 }] })
try {
  await mkdir(data, { recursive: true }); await writeFile(join(data, 'settings.json'), JSON.stringify({ version: 1, developer: true, booth: false, plugins: {}, sceneId }))
  await launch(); await send({ type: 'mode.set', mode: 'quiet' }); await send({ type: 'flow.enter' }); await waitFor((s) => s.heartFlow.activeId, 'FLOW_MISSING'); await send({ type: 'flow.mode', mode: 'execute' })
  const url = 'https://public.synthetic.invalid/readme'; await script(url); await send({ type: 'message.send', text: 'Request one exact public URL for this work.' }); await waitFor((s) => !!s.heartFlow.webFetch.pending, 'WEB_APPROVAL_MISSING'); const id = (await snapshot()).heartFlow.webFetch.pending.id
  assert.equal((await snapshot()).heartFlow.webFetch.pending.url, url); assert.equal((await snapshot()).heartFlow.webFetch.last, undefined); assert.equal((await snapshot()).heartFlow.webFetch.source, 'fake')
  await page.getByRole('button', { name: '仅读取这个地址一次', exact: true }).click(); await waitFor((s) => s.task?.status === 'completed' && s.heartFlow.webFetch.last?.status === 'fetched', 'APPROVED_FETCH_MISSING')
  assert.ok(!JSON.stringify((await snapshot()).heartFlow.webFetch).includes('PUBLIC_SYNTHETIC_WEB_WORK')); const context = JSON.stringify(await debug('get_context')); assert.ok(context.includes('PUBLIC_SYNTHETIC_WEB_WORK'))
  assert.equal((await send({ type: 'flow.fetch.approve', approvalId: id, allow: true })).status, 'rejected')
  await script(url); await send({ type: 'message.send', text: 'Request another address for denial.' }); await waitFor((s) => !!s.heartFlow.webFetch.pending, 'DENIAL_APPROVAL_MISSING'); await page.getByRole('button', { name: '拒绝这个地址', exact: true }).click(); await waitFor((s) => s.task?.status === 'completed' && s.heartFlow.webFetch.last?.status === 'denied', 'DENIAL_MISSING')
  await script('https://127.0.0.1/private'); await send({ type: 'message.send', text: 'Reject this synthetic local address.' }); await waitFor((s) => s.task?.status === 'completed', 'LOCAL_REJECTION_HUNG'); assert.equal((await snapshot()).heartFlow.webFetch.requestsUsed, 2); assert.equal((await snapshot()).heartFlow.webFetch.pending, undefined)
  await script(url); await send({ type: 'message.send', text: 'Request an address for stop.' }); await waitFor((s) => !!s.heartFlow.webFetch.pending, 'STOP_APPROVAL_MISSING'); await send({ type: 'turn.stop', taskId: (await snapshot()).task.id }); await waitFor((s) => s.task?.status === 'aborted' && !s.heartFlow.webFetch.pending, 'STOP_FAILED')
  await script(url); await send({ type: 'message.send', text: 'Leave one unapproved request at restart.' }); await waitFor((s) => !!s.heartFlow.webFetch.pending, 'RESTART_APPROVAL_MISSING'); const stale = (await snapshot()).heartFlow.webFetch.pending.id
  await close(); await launch(); assert.equal((await snapshot()).heartFlow.webFetch.pending, undefined); assert.equal((await send({ type: 'flow.fetch.approve', approvalId: stale, allow: true })).status, 'rejected'); assert.equal((await snapshot()).heartFlow.webFetch.requestsUsed, 4)
  await send({ type: 'flow.exit' }); await waitFor((s) => !s.heartFlow.activeId, 'FLOW_NOT_CLOSED'); await debug('set_fake_model', { script: [{ text: 'ordinary response', toolCalls: [], delayMs: 0 }] }); await send({ type: 'message.send', text: 'Return to ordinary chat.' }); await waitFor((s) => s.task?.status === 'completed', 'ORDINARY_NOT_DONE'); assert.ok(!JSON.stringify(await debug('get_context')).includes('PUBLIC_SYNTHETIC_WEB_WORK'))
  console.log('Web-fetch Electron: exact URL shown before every decision, approved synthetic body reaches only work context, denial/local target refusal, unique approval, stop, persisted request budget and no restart approval replay; ordinary context excludes web prose. Fake website/model, no external HTTP from this scenario.')
} finally { await close() }
