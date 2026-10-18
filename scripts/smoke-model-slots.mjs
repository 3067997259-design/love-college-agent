import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron } from 'playwright'
import electronPath from 'electron'
import { runtimeEnv, initializeTestBook } from './runtime-env.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..'); const data = join(root, '.local-data', 'slots-smoke-' + randomUUID())
const requests = []; let denyPrivacy = false
const paper = '我把纸桥放在书桌上，给它取名叫周五桥。'
const server = createServer((request, response) => {
  void (async () => {
    let text = ''; for await (const chunk of request) text += chunk
    const body = JSON.parse(text); requests.push(body)
    if (denyPrivacy && body.model === 'slot-privacy') { response.writeHead(401).end('SYNTHETIC_CONFIGURATION_FAILURE'); return }
    let output
    if (body.model === 'slot-chat') output = 'SYNTHETIC_MAIN_VISIBLE'
    else if (body.model === 'slot-background') {
      const fragments = JSON.parse(body.messages[1].content); const source = fragments.find((fragment) => fragment.text.includes(paper))
      output = JSON.stringify({ items: source ? [{ sourceId: source.id, quote: paper, kind: 'experience', topic: '纸桥', replaceTopic: false }] : [] })
    } else if (body.model === 'slot-privacy') output = JSON.stringify({ markdown: '# 合成 HTTP 整理\n\nUSER_ONLY_SLOT_OUTPUT\n\nRAW_ONLY_SLOT_CONTENT', deadline: null })
    else throw new Error('UNEXPECTED_SLOT')
    response.writeHead(200, { 'Content-Type': 'text/event-stream' }).end('data: ' + JSON.stringify({ choices: [{ index: 0, delta: { content: output }, finish_reason: 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 10 } }) + '\n\ndata: [DONE]\n\n')
  })().catch(() => { if (!response.headersSent) response.writeHead(500).end(); else response.end() })
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const providers = { providers: Object.fromEntries(['chat', 'background', 'privacy'].map((slot) => [slot, { base_url: 'http://127.0.0.1:' + server.address().port + '/v1', api_key: 'synthetic-' + slot + '-credential', model: 'slot-' + slot }])) }
providers.providers.tts = { protocol: 'openai-speech', base_url: 'https://speech.invalid/v1', api_key: 'synthetic-speech-credential', model: 'synthetic-speech-model', voice: 'synthetic-stock-voice' }
const env = { ...runtimeEnv(root), LCA_DATA_DIR: data, LCA_PROVIDERS_FILE: join(data, 'absent-config.json') }
let instance; let page
async function launch() { instance = await _electron.launch({ executablePath: electronPath, args: [root], env, timeout: 30_000 }); page = await instance.firstWindow(); await initializeTestBook(page); await page.locator('[data-mode][data-pose]').waitFor() }
const snapshot = () => page.evaluate(() => window.lca.getSnapshot())
async function waitFor(predicate, error) { for (let i = 0; i < 150; i++) { if (predicate(await snapshot())) return; await new Promise((done) => setTimeout(done, 100)) } throw new Error(error) }
const send = (body) => page.evaluate(async (body) => { const s = await window.lca.getSnapshot(); return window.lca.dispatch({ ...body, epoch: s.epoch, protocolVersion: 1, requestId: crypto.randomUUID() }) }, body)
const safe = (value) => { const text = JSON.stringify(value); for (const marker of ['RAW_ONLY_SLOT_CONTENT', 'USER_ONLY_SLOT_OUTPUT', 'synthetic-chat-credential', 'synthetic-background-credential', 'synthetic-privacy-credential', 'synthetic-speech-credential', 'synthetic-stock-voice', 'speech.invalid']) assert.ok(!text.includes(marker), 'SLOT_PRIVATE_LEAK') }
try {
  await mkdir(data, { recursive: true }); const file = join(data, 'synthetic-models.json'); await writeFile(file, JSON.stringify(providers))
  await launch(); assert.equal((await snapshot()).memory.status, 'unconfigured')
  await instance.evaluate(({ dialog }, file) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }) }, file)
  await page.getByRole('button', { name: '工具与设置', exact: true }).click(); await page.getByRole('button', { name: '导入模型配置', exact: true }).click()
  await waitFor((s) => s.modelSettings.status === 'saved' && s.modelSettings.restartRequired, 'PRIVATE_CONFIG_NOT_SAVED'); assert.deepEqual((await snapshot()).modelSettings.configuredSlots, ['chat', 'background', 'privacy']); safe(await snapshot())
  assert.deepEqual(JSON.parse(await readFile(join(data, 'connections', 'providers.json'), 'utf8')).providers.tts, providers.providers.tts)
  const savedConfig = await readFile(join(data, 'connections', 'providers.json')); const badFile = join(data, 'invalid-speech.json'); const invalid = structuredClone(providers); delete invalid.providers.tts.voice; await writeFile(badFile, JSON.stringify(invalid))
  await instance.evaluate(({ dialog }, file) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }) }, badFile)
  await page.getByRole('button', { name: '导入模型配置', exact: true }).click(); await waitFor((s) => s.modelSettings.status === 'failed', 'BAD_VOICE_ACCEPTED'); assert.deepEqual(await readFile(join(data, 'connections', 'providers.json')), savedConfig)
  await instance.close(); await launch()
  let s = await snapshot(); assert.deepEqual(s.modelSettings.configuredSlots, ['chat', 'background', 'privacy']); assert.equal(s.modelSettings.restartRequired, false)
  assert.deepEqual(s.voice, { enabled: false, available: true, source: 'real' }) // Configuration only; never enable or contact this synthetic HTTPS target.
  assert.equal(s.memory.source, 'real'); assert.equal(s.memory.status, 'idle'); assert.equal(s.runtime.developer.mode, 'normal'); assert.equal(s.mailbox.status, 'blocked')
  await send({ type: 'mode.set', mode: 'quiet' }); await send({ type: 'message.send', text: paper }); await waitFor((s) => s.task?.status === 'completed', 'NORMAL_CHAT_FAILED')
  await send({ type: 'memory.extract' }); await waitFor((s) => s.memory.status === 'idle' && s.memory.items.length === 1, 'NORMAL_BACKGROUND_MEMORY_FAILED')
  assert.equal((await send({ type: 'privacy.set', enabled: true })).status, 'accepted')
  const source = join(data, 'synthetic-private.txt'); await writeFile(source, 'RAW_ONLY_SLOT_CONTENT\nAPI key: sk-syntheticprivateinputcredential1234567')
  await page.getByLabel('选择资料文件', { exact: true }).setInputFiles(source)
  await waitFor((s) => s.documents.jobs.at(-1)?.status === 'ready', 'NORMAL_ISOLATED_DOCUMENT_FAILED')
  const privateRequest = requests.find((request) => request.model === 'slot-privacy'); assert.ok(JSON.stringify(privateRequest).includes('RAW_ONLY_SLOT_CONTENT')); assert.ok(!JSON.stringify(privateRequest).includes('sk-synthetic'))
  for (const request of requests.filter((request) => request.model !== 'slot-privacy')) { assert.ok(!JSON.stringify(request).includes('RAW_ONLY_SLOT_CONTENT')); assert.ok(!JSON.stringify(request).includes('USER_ONLY_SLOT_OUTPUT')); if (request.model === 'slot-background') assert.equal(request.tools, undefined) }
  assert.equal(privateRequest.tools, undefined)
  denyPrivacy = true; const before = requests.filter((request) => request.model === 'slot-chat').length
  const failure = join(data, 'synthetic-failure.txt'); await writeFile(failure, 'RAW_ONLY_SLOT_CONTENT failure')
  await page.getByLabel('选择资料文件', { exact: true }).setInputFiles(failure)
  await waitFor((s) => s.documents.jobs.at(-1)?.status === 'failed', 'PRIVACY_FAILURE_NOT_CLOSED')
  s = await snapshot(); assert.equal(s.documents.jobs.at(-1).error.code, 'privacy-unavailable'); assert.equal(s.deliveries.length, 1); assert.equal(requests.filter((request) => request.model === 'slot-chat').length, before)
  safe(s); for (const folder of await readdir(join(data, 'journals'))) for (const name of await readdir(join(data, 'journals', folder))) if (name.endsWith('.jsonl')) safe(await readFile(join(data, 'journals', folder, name), 'utf8'))
  console.log('Model slots smoke: native mixed chat/background/privacy/TTS import, strict invalid-TTS refusal preserving saved file, restart speech availability without requesting audio; synthetic HTTP model slots, exact memory provenance and privacy fail-closed verified. No real providers or IMAP accessed.')
} finally { await instance?.close(); await new Promise((resolve) => { server.close(() => resolve()); server.closeAllConnections() }) }
