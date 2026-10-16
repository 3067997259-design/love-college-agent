import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron } from 'playwright'
import electronPath from 'electron'
import { runtimeEnv } from './runtime-env.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const data = join(root, '.local-data', `harness-smoke-${randomUUID()}`)
mkdirSync(data, { recursive: true })
const frame = (delta, finish_reason) => `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason }] })}\n\n`
const requests = []
let pendingAborted = false
let receivedWait
let receivedAbort
const waitingRequest = new Promise((resolve) => { receivedWait = resolve })
const abortedRequest = new Promise((resolve) => { receivedAbort = resolve })
function within(promise) {
  let timer
  return Promise.race([promise, new Promise((_resolve, reject) => { timer = setTimeout(() => reject(new Error('Synthetic fixture timed out')), 30_000) })]).finally(() => clearTimeout(timer))
}
const server = createServer(async (req, res) => {
  let input = ''
  for await (const chunk of req) input += chunk
  const body = JSON.parse(input)
  requests.push(body)
  res.writeHead(200, { 'Content-Type': 'text/event-stream' })
  if (body.messages.some((message) => message.content === 'synthetic wait')) {
    res.flushHeaders()
    res.on('close', () => { pendingAborted = true; receivedAbort() })
    receivedWait()
    return
  }
  if (requests.length === 1) {
    res.end(frame({ tool_calls: [{ index: 0, id: 'fixture-clock-call', type: 'function', function: { name: 'get_clock', arguments: '{}' } }] }, 'tool_calls') + 'data: [DONE]\n\n')
  } else res.end(frame({ content: 'synthetic final response' }, 'stop') + 'data: [DONE]\n\n')
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port
const fixturePath = join(data, 'synthetic-providers.json')
writeFileSync(fixturePath, JSON.stringify({ providers: { chat: { base_url: `http://127.0.0.1:${port}/v1`, api_key: 'synthetic-fixture-key', model: 'synthetic-fixture-model' } } }))
// This script uses a synthetic HTTP fixture; it never reads the user's providers file.
const env = { ...runtimeEnv(root), LCA_DATA_DIR: data, LCA_PROVIDERS_FILE: fixturePath }
let instance
try {
  instance = await _electron.launch({ executablePath: electronPath, args: [root], env, timeout: 30_000 })
  let page = await instance.firstWindow()
  await page.locator('[data-mode][data-pose][data-location]').waitFor()
  await page.getByRole('textbox').fill('synthetic user question')
  await page.getByRole('button', { name: '发送', exact: true }).click()
  await page.locator('.task[data-status="completed"]').waitFor()
  await page.locator('.msg-assistant .msg-text').getByText('synthetic final response', { exact: true }).first().waitFor()
  assert.equal(requests.length, 2)
  assert.equal(requests[1].messages[0].role, 'system'); assert.ok(requests[1].messages[0].content.includes('桃子'))
  assert.deepEqual(requests[1].messages.filter((message) => message.role !== 'system').map((message) => message.role), ['user', 'assistant', 'tool'])
  const toolResult = JSON.parse(requests[1].messages.at(-1).content)
  assert.equal(typeof toolResult.nowMs, 'number')
  const before = await page.evaluate(() => window.lca.getSnapshot())
  assert.equal(before.activities[0].status, 'completed')
  assert.ok(!JSON.stringify(before).includes('synthetic-fixture-key'))
  assert.ok(!JSON.stringify(before).includes('synthetic-fixture-model'))
  await page.getByRole('textbox').fill('synthetic wait')
  await page.getByRole('button', { name: '发送', exact: true }).click()
  await within(waitingRequest)
  await page.evaluate(async () => { const s = await window.lca.getSnapshot(); await window.lca.dispatch({ protocolVersion: 1, epoch: s.epoch, requestId: crypto.randomUUID(), type: 'lights.set', lightsOut: true }) })
  await page.locator('.task[data-status="waiting-user"]').waitFor()
  await page.getByRole('button', { name: '停止', exact: true }).click()
  await page.locator('.task[data-status="aborted"]').waitFor()
  await within(abortedRequest)
  assert.equal(pendingAborted, true)
  await instance.close()
  const count = requests.length
  instance = await _electron.launch({ executablePath: electronPath, args: [root], env, timeout: 30_000 })
  page = await instance.firstWindow()
  await page.locator('[data-mode][data-pose][data-location]').waitFor()
  const after = await page.evaluate(() => window.lca.getSnapshot())
  assert.equal(after.scope.sessionId, before.scope.sessionId)
  assert.notEqual(after.epoch, before.epoch)
  assert.ok(after.messages.some((message) => message.text === 'synthetic final response'))
  assert.equal(after.task.status, 'aborted')
  assert.equal(requests.length, count)
  console.log('Harness Electron smoke: synthetic HTTP stream, UI send, tool roundtrip, stop and persisted restart verified.')
} finally {
  await instance?.close().catch(() => {})
  server.closeAllConnections()
  await new Promise((resolve) => server.close(resolve))
}
