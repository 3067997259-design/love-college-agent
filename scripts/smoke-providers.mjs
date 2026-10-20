import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdir, readFile, rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron } from 'playwright'
import electronPath from 'electron'
import { runtimeEnv, initializeTestBook, electronLaunchTarget, openSettings } from './runtime-env.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const data = join(root, '.local-data', `providers-smoke-${randomUUID()}`)
const requests = []
const server = createServer((request, response) => {
  void (async () => {
    let body = ''; for await (const chunk of request) body += chunk
    requests.push(JSON.parse(body))
    response.writeHead(200, { 'Content-Type': 'text/event-stream' })
    response.end('data: ' + JSON.stringify({ choices: [{ index: 0, delta: { content: 'OK' }, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 1 } }) + '\n\ndata: [DONE]\n\n')
  })().catch(() => { if (!response.headersSent) response.writeHead(500).end(); else response.end() })
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const env = { ...runtimeEnv(root), LCA_DATA_DIR: data, LCA_PROVIDERS_FILE: join(data, 'absent.json'), LCA_MCP_PORT: '0', LCA_CDP_PORT: '19574' }
let instance; let page
const snapshot = () => page.evaluate(() => window.lca.getSnapshot())
async function waitFor(test, message) {
  for (let i = 0; i < 120; i++) { if (await test()) return; await new Promise((done) => setTimeout(done, 100)) }
  throw new Error(message)
}

try {
  await mkdir(data, { recursive: true })
  instance = await _electron.launch({ ...electronLaunchTarget(root, electronPath), env })
  page = await instance.firstWindow(); await initializeTestBook(page)
  await openSettings(page)
  const card = page.locator('.provider-card[data-slot="chat"]')
  await card.waitFor()
  await card.getByLabel('服务商模板', { exact: true }).selectOption('deepseek')
  assert.equal(await card.getByLabel('接口地址', { exact: true }).inputValue(), 'https://api.deepseek.com/v1')
  assert.equal(await card.getByLabel('模型', { exact: true }).inputValue(), 'deepseek-flash')
  await card.getByLabel('接口地址', { exact: true }).fill(`http://127.0.0.1:${server.address().port}/v1`)
  await card.getByLabel('模型', { exact: true }).fill('synthetic-chat')
  await card.getByLabel('API 密钥', { exact: true }).fill('synthetic-provider-secret')
  await card.getByRole('button', { name: '保存', exact: true }).click()
  await waitFor(async () => (await snapshot()).modelSettings.configuredSlots.includes('chat'), 'PROVIDER_NOT_SAVED')
  assert.equal((await snapshot()).modelSettings.restartRequired, false)
  assert.ok(!JSON.stringify(await snapshot()).includes('synthetic-provider-secret'))
  const saved = JSON.parse(await readFile(join(data, 'connections', 'providers.json'), 'utf8'))
  assert.equal(saved.providers.chat.api_key, 'synthetic-provider-secret')
  await card.getByRole('button', { name: '测试连接', exact: true }).click()
  await waitFor(async () => (await snapshot()).modelSettings.probe?.status === 'ok', 'PROVIDER_PROBE_NOT_OK')
  await page.waitForTimeout(150)
  await card.getByText('已经连接', { exact: true }).waitFor()
  await page.screenshot({ path: join(root, 'test-results', 'providers-connected.png') })
  assert.equal(requests.length, 1); assert.equal(requests[0].model, 'synthetic-chat')
  const sent = await page.evaluate(async () => { const s = await window.lca.getSnapshot(); return window.lca.dispatch({ type: 'message.send', text: '第一次见面，你好。', epoch: s.epoch, protocolVersion: 1, requestId: crypto.randomUUID() }) })
  assert.equal(sent.status, 'accepted')
  await waitFor(async () => (await snapshot()).task?.status === 'completed', 'FIRST_CHAT_WITHOUT_RESTART_FAILED')
  // LCA's references (her world, memory) ride in front of your words in the same DSH message.
  const textOf = (content) => typeof content === 'string' ? content : (content ?? []).map((part) => part?.text ?? '').join('')
  assert.ok(requests.some((body) => body.messages.some((message) => textOf(message.content).endsWith('第一次见面，你好。'))))
  // 配好的卡把地址和密钥收起来了：清除在“修改连接”里
  await card.getByRole('button', { name: '修改连接', exact: true }).click(); await card.getByRole('button', { name: '清除', exact: true }).click()
  await waitFor(async () => !(await snapshot()).modelSettings.configuredSlots.includes('chat'), 'PROVIDER_NOT_REMOVED')
  await page.waitForTimeout(150)
  const local = `http://127.0.0.1:${server.address().port}/v1`
  const tts = page.locator('.provider-card[data-service="tts"]')
  await tts.getByLabel('TTS 接口地址', { exact: true }).fill('https://speech.invalid/v1')
  await tts.getByLabel('TTS 模型', { exact: true }).fill('synthetic-tts')
  await tts.getByLabel('音色', { exact: true }).fill('synthetic-voice')
  await tts.getByLabel('TTS 密钥', { exact: true }).fill('synthetic-tts-secret')
  await tts.getByRole('button', { name: '保存语音', exact: true }).click()
  await waitFor(async () => (await snapshot()).modelSettings.services?.tts === true, 'TTS_NOT_SAVED')
  const rodin = page.locator('.provider-card[data-service="rodin"]')
  await rodin.getByLabel('礼物接口地址', { exact: true }).fill(local)
  await rodin.getByLabel('礼物密钥', { exact: true }).fill('synthetic-rodin-secret')
  await rodin.getByRole('button', { name: '保存礼物连接', exact: true }).click()
  await waitFor(async () => (await snapshot()).modelSettings.services?.rodin === true, 'RODIN_NOT_SAVED')
  const mail = page.locator('.provider-card[data-service="mail"]')
  await mail.getByLabel('IMAP 服务器', { exact: true }).fill('imap.invalid')
  await mail.getByLabel('邮箱用户', { exact: true }).fill('synthetic@example.edu')
  await mail.getByLabel('授权码', { exact: true }).fill('synthetic-mail-secret')
  await mail.getByRole('button', { name: '保存邮箱连接', exact: true }).click()
  await waitFor(async () => (await snapshot()).modelSettings.services?.mail === true, 'MAIL_NOT_SAVED')
  const services = JSON.parse(await readFile(join(data, 'connections', 'providers.json'), 'utf8'))
  assert.equal(services.providers.tts.voice, 'synthetic-voice'); assert.equal(services.providers.rodin.model, ''); assert.equal(services.mail.folder, '桃子')
  assert.ok(!JSON.stringify(await snapshot()).includes('synthetic-tts-secret')); assert.ok(!JSON.stringify(await snapshot()).includes('synthetic-mail-secret'))
  console.log(JSON.stringify({ ok: true, probe: 'providers', guiSave: true, guiProbe: true, guiRemove: true, firstChatWithoutRestart: true, services: true, syntheticHTTP: true, noSecretInSnapshot: true }))
} finally {
  await instance?.close().catch(() => {})
  server.closeAllConnections(); await new Promise((done) => server.close(done))
  if (resolve(data).startsWith(join(resolve(root), '.local-data', 'providers-smoke-'))) await rm(data, { recursive: true, force: true })
}
