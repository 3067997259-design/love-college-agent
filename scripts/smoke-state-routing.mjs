// Full main/DSH/book path against loopback fixtures only. Never reads real model settings.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { join, resolve } from 'node:path'
import { _electron } from 'playwright'
import electronPath from 'electron'
import { runtimeEnv, testDataRoot, electronLaunchTarget, initializeTestBook } from './runtime-env.mjs'

const root = resolve(import.meta.dirname, '..')
const data = join(testDataRoot(root), `state-routing-${randomUUID()}`)
mkdirSync(data, { recursive: true })
const textOf = (content) => typeof content === 'string' ? content : (content ?? []).map((part) => part.text ?? '').join('')
const frame = (delta, finish_reason) => `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason }] })}\n\n`
const requests = []
let releaseStale, sawStale
const staleSeen = new Promise((resolve) => { sawStale = resolve })
const staleReleased = new Promise((resolve) => { releaseStale = resolve })
const server = createServer(async (req, res) => {
  let input = ''; for await (const chunk of req) input += chunk
  const body = JSON.parse(input), messages = body.messages
  const marker = messages.findLastIndex((message) => message.role === 'user' && /state-probe:\w+/.test(textOf(message.content)))
  const task = textOf(messages[marker]?.content).match(/state-probe:\w+/)?.[0] ?? ''
  const token = messages.map((message) => textOf(message.content)).join('\n').match(/(?:本次|本轮)状态凭据=([\w-]+)/)?.[1]
  const tool = messages.slice(marker + 1).some((message) => message.role === 'tool')
  requests.push({ task, model: body.model })
  if (task === 'state-probe:stale') { sawStale(); await staleReleased }
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  assert.equal(body.model, 'mock-chat', 'FOREGROUND_MUST_KEEP_CHAT_ROUTE')
  if (task === 'state-probe:mode' || task === 'state-probe:stale') {
    assert.ok(token)
    res.end(frame({ content: JSON.stringify({ lca_state: { mode: 'work', token }, reply: '我来处理。' }) }, 'stop') + 'data: [DONE]\n\n')
  } else if (!tool) {
    res.end(frame({ tool_calls: [{ index: 0, id: `clock-${requests.length}`, type: 'function', function: { name: 'lca_get_clock', arguments: '{}' } }] }, 'tool_calls') + 'data: [DONE]\n\n')
  } else res.end(frame({ content: `${task} completed` }, 'stop') + 'data: [DONE]\n\n')
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const provider = (model) => ({ base_url: `http://127.0.0.1:${server.address().port}/v1`, api_key: 'synthetic-key', model })
const settings = join(data, 'synthetic-providers.json')
writeFileSync(settings, JSON.stringify({ providers: { chat: provider('mock-chat'), work: provider('mock-work') }, routing: { work: 'independent', background: 'independent', privacy: 'independent' } }))
const env = { ...runtimeEnv(root), LCA_DATA_DIR: data, LCA_PROVIDERS_FILE: settings, LCA_TEST_SILENT: '1', LCA_MCP_PORT: '0', LCA_CDP_PORT: '0' }
let instance, page
const start = async () => { instance = await _electron.launch({ ...electronLaunchTarget(root, electronPath), env, timeout: 30000 }); page = await instance.firstWindow(); page.setDefaultTimeout(45000); await initializeTestBook(page) }
const mode = async (label) => { await page.locator('.door-sign').click(); await page.getByRole('menuitemradio', { name: new RegExp('^' + label) }).click() }
const send = async (task) => { await page.getByRole('textbox').fill(task); await page.getByRole('button', { name: '发送', exact: true }).click() }
const idle = () => page.waitForFunction(async () => (await window.lca.getSnapshot()).task?.status === 'completed')
const completed = async (task) => { await page.getByText(`${task} completed`, { exact: true }).waitFor(); await idle() }
try {
  await start()
  await send('state-probe:mode 请把门牌切到工作中。')
  await page.getByText('我来处理。', { exact: true }).waitFor(); await idle()
  assert.deepEqual(requests.map((r) => r.model), ['mock-chat'])
  assert.equal((await page.evaluate(() => window.lca.getSnapshot())).companion.mode, 'work')
  assert.ok(!(await page.locator('body').innerText()).includes('lca_state'))
  await mode('休息'); await mode('工作中')
  await send('state-probe:direct'); await completed('state-probe:direct')
  assert.deepEqual(requests.filter((r) => r.task === 'state-probe:direct').map((r) => r.model), ['mock-chat', 'mock-chat'])
  await mode('休息'); await send('state-probe:stale')
  await Promise.race([staleSeen, new Promise((_resolve, reject) => { const t = setTimeout(() => reject(new Error('STALE_REQUEST_TIMEOUT')), 45000); t.unref() })])
  await mode('安静'); releaseStale()
  await page.getByText('这次状态指令格式不完整或已失效，门牌没有改变。可以手动切换后再发送任务。', { exact: true }).waitFor()
  await idle()
  assert.equal((await page.evaluate(() => window.lca.getSnapshot())).companion.mode, 'quiet')
  assert.equal((await page.evaluate(() => window.lca.getSnapshot())).messages.filter((message) => message.text === '我来处理。').length, 1)
  assert.equal(requests.filter((r) => r.task === 'state-probe:stale').length, 1)
  await mode('工作中')
  await page.locator('.door-sign').click()
  await page.screenshot({ path: join(data, 'menu.png') })
  await page.keyboard.press('Escape')
  const count = requests.length
  await instance.close(); await start()
  assert.equal((await page.evaluate(() => window.lca.getSnapshot())).companion.mode, 'work')
  assert.equal(requests.length, count)
  await send('state-probe:restart'); await completed('state-probe:restart')
  assert.deepEqual(requests.filter((r) => r.task === 'state-probe:restart').map((r) => r.model), ['mock-chat', 'mock-chat'])
  const result = { ok: true, kind: 'synthetic-local-http', checks: ['text state change without a worker-model continuation', 'manual work sign keeps the foreground chat route', 'stale response refused', 'restart persists mode without replay', 'LCA clock tool roundtrip'], requests }
  writeFileSync(join(data, 'report.json'), JSON.stringify(result, null, 2))
  console.log(JSON.stringify({ ...result, data }, null, 2))
} catch (error) {
  writeFileSync(join(data, 'report.json'), JSON.stringify({ ok: false, kind: 'synthetic-local-http', error: error.message, requests }, null, 2))
  throw error
} finally {
  releaseStale(); await instance?.close().catch(() => {})
  server.closeAllConnections(); await new Promise((resolve) => server.close(resolve))
}
