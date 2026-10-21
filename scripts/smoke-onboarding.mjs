import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron } from 'playwright'
import electronPath from 'electron'
import JSZip from 'jszip'
import { runtimeEnv, electronLaunchTarget, openSettingsGroup, openSettings, whenIdle } from './runtime-env.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..'); const data = join(root, '.local-data', 'onboarding-smoke-' + randomUUID())
const backendOnly = process.argv.includes('--backend-only'); const requests = []
const server = createServer(async (request, response) => {
  let input = ''; for await (const chunk of request) input += chunk
  requests.push(JSON.parse(input))
  response.writeHead(200, { 'Content-Type': 'text/event-stream' })
  response.end('data: ' + JSON.stringify({ choices: [{ index: 0, delta: { content: '合成档案验收回应' }, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n')
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
await mkdir(data, { recursive: true }); const fixture = join(data, 'synthetic-providers.json')
await writeFile(fixture, JSON.stringify({ providers: { chat: { base_url: 'http://127.0.0.1:' + server.address().port + '/v1', api_key: 'synthetic-test-only', model: 'synthetic-test-only' } } }))
const env = { ...runtimeEnv(root), LCA_DATA_DIR: join(data, 'source'), LCA_PROVIDERS_FILE: fixture, LCA_CDP_PORT: '19535', LCA_MCP_PORT: '0' }
let instance; let page
async function launch() { instance = await _electron.launch({ ...electronLaunchTarget(root, electronPath), env, timeout: 30_000 }); page = await instance.firstWindow(); await page.locator('[data-mode][data-pose]').waitFor() }
const snapshot = () => page.evaluate(() => window.lca.getSnapshot())
const send = (body) => page.evaluate(async (body) => { const s = await window.lca.getSnapshot(); return window.lca.dispatch({ protocolVersion: 1, epoch: s.epoch, requestId: crypto.randomUUID(), ...body }) }, body)
async function waitFor(predicate, message) { for (let i = 0; i < 100; i++) { if (predicate(await snapshot())) return; await new Promise((done) => setTimeout(done, 100)) } throw new Error(message) }
const onboarding = () => page.getByRole('region', { name: '新手流程', exact: true })
async function writeNames(expectedUser, expectedCharacter) {
  await onboarding().getByRole('button', { name: '翻开', exact: true }).click()
  await onboarding().getByRole('textbox', { name: '你的名字', exact: true }).fill(expectedUser)
  await onboarding().getByRole('button', { name: '写好了', exact: true }).click()
  await onboarding().getByRole('button', { name: '先跳过，稍后在设置里配', exact: true }).click()
  await onboarding().getByRole('textbox', { name: '她的称呼', exact: true }).fill(expectedCharacter)
  await onboarding().getByRole('button', { name: '就叫这个', exact: true }).click()
}
try {
  await launch(); assert.deepEqual((await snapshot()).onboarding, { status: 'needed', userName: null, characterName: '桃子', completedAtMs: null })
  if (!backendOnly) { await onboarding().waitFor(); await writeNames('程同学', '杏子') } else assert.equal((await send({ type: 'onboarding.profile', userName: '程同学', characterName: '杏子' })).status, 'accepted')
  const savedNames = (await snapshot()).onboarding; assert.equal(savedNames.userName, '程同学'); assert.equal(savedNames.characterName, '杏子'); assert.equal(savedNames.status, 'needed')
  await instance.close(); await launch(); assert.deepEqual((await snapshot()).onboarding, savedNames)
  if (!backendOnly) {
    await onboarding().getByRole('button', { name: '翻开', exact: true }).click()
    assert.equal(await onboarding().getByRole('textbox', { name: '你的名字', exact: true }).inputValue(), '程同学')
    await onboarding().getByRole('button', { name: '写好了', exact: true }).click(); await onboarding().getByRole('button', { name: '先跳过，稍后在设置里配', exact: true }).click()
    assert.equal(await onboarding().getByRole('textbox', { name: '她的称呼', exact: true }).inputValue(), '杏子')
    await onboarding().getByRole('button', { name: '就叫这个', exact: true }).click(); await onboarding().getByRole('button', { name: '好', exact: true }).click()
    await onboarding().getByRole('button', { name: '剩下的交给她', exact: true }).click(); await onboarding().getByRole('button', { name: '开始吧', exact: true }).click()
    await waitFor((s) => s.onboarding.status === 'completed', 'ONBOARDING_COMPLETION_NOT_PERSISTED')
  } else assert.equal((await send({ type: 'onboarding.complete' })).status, 'accepted')
  const completed = (await snapshot()).onboarding; assert.equal(typeof completed.completedAtMs, 'number')
  await instance.close(); await launch(); assert.deepEqual((await snapshot()).onboarding, completed)
  if (!backendOnly) { assert.equal(await onboarding().count(), 0); await page.getByRole('textbox').waitFor() }
  // Main's final request is observed at a local synthetic HTTP server, never a real provider.
  await send({ type: 'message.send', text: '只核对合成档案分层' }); await waitFor((s) => s.task?.status === 'completed', 'SYNTHETIC_CONTEXT_NOT_COMPLETED')
  // DSH assembles her system prompt from LCA's persona: the card names her and never you; your name lives only in
  // the profile part ("关于你"). Names chosen in onboarding reach the session even though DSH started before them.
  const textOf = (content) => typeof content === 'string' ? content : (content ?? []).map((part) => part?.text ?? '').join('')
  const request = requests.findLast((body) => body.messages.some((message) => textOf(message.content).includes('只核对合成档案分层')))
  assert.ok(request, 'SYNTHETIC_CONTEXT_REQUEST_MISSING')
  const system = request.messages.filter((message) => message.role === 'system' || message.role === 'developer').map((message) => textOf(message.content)).join('\n')
  const parts = system.split('\n\n')
  const herName = parts.find((part) => part.includes(JSON.stringify({ characterName: '杏子' })))
  const aboutYou = parts.find((part) => part.includes('关于你'))
  assert.ok(herName && !herName.includes('程同学'), 'CHARACTER_NAME_LAYER')
  assert.ok(aboutYou?.includes(JSON.stringify({ userName: '程同学' })) && !aboutYou.includes('杏子'), 'PROFILE_LAYER')
  assert.equal((await snapshot()).memory.items.length, 0)
  const archiveFile = join(data, 'completed.lca-save')
  await instance.evaluate(({ dialog }, file) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: file }) }, archiveFile)
  assert.equal((await whenIdle(send, { type: 'backup.export' })).status, 'accepted'); await waitFor((s) => s.backup.status === 'exported', 'ONBOARDING_EXPORT_FAILED')
  const zip = await JSZip.loadAsync(await readFile(archiveFile)); const manifest = JSON.parse(await zip.file('manifest.json').async('string')); assert.deepEqual(manifest.onboarding, completed)
  const journals = (await Promise.all(manifest.files.filter((file) => file.path.endsWith('.jsonl')).map((file) => zip.file(file.path).async('string')))).flatMap((text) => text.trim().split('\n').map((line) => JSON.parse(line)))
  const seen = journals.find((row) => row.type === 'model/seen'); assert.ok(seen.eligibleIndexes.every((index) => !JSON.stringify(seen.messages[index]).match(/程同学|杏子/)))
  const beforeReset = (await snapshot()).messages
  if (!backendOnly) { await openSettings(page); await openSettingsGroup(page, '书本与角色'); await page.getByRole('button', { name: '重新体验新手指引', exact: true }).click(); await onboarding().waitFor() } else await send({ type: 'onboarding.reset' })
  assert.equal((await snapshot()).onboarding.status, 'needed'); assert.deepEqual((await snapshot()).messages, beforeReset)
  await instance.close(); env.LCA_DATA_DIR = join(data, 'empty-target'); await launch(); assert.equal((await snapshot()).onboarding.status, 'needed')
  if (!backendOnly) await onboarding().waitFor()
  await instance.evaluate(({ dialog }, file) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }) }, archiveFile)
  if (!backendOnly) await onboarding().getByRole('button', { name: '我已经有一本书了', exact: true }).click(); else await send({ type: 'backup.import' })
  await waitFor((s) => s.backup.status === 'awaiting-confirmation', 'ONBOARDING_IMPORT_FAILED'); assert.equal((await snapshot()).onboarding.status, 'needed')
  assert.equal((await send({ type: 'backup.restore', restoreId: randomUUID() })).status, 'rejected')
  await instance.evaluate(({ app }) => { app.relaunch = () => {} }); const closed = instance.waitForEvent('close')
  if (!backendOnly) await onboarding().getByRole('button', { name: '从这本书恢复', exact: true }).click(); else await send({ type: 'backup.restore', restoreId: (await snapshot()).backup.restoreId })
  await closed; await launch(); assert.equal((await snapshot()).backup.status, 'restored'); assert.deepEqual((await snapshot()).onboarding, completed)
  if (!backendOnly) { assert.equal(await onboarding().count(), 0); await page.getByRole('textbox').waitFor() }
  await instance.close(); await launch(); assert.deepEqual((await snapshot()).onboarding, completed)
  await instance.close(); env.LCA_DATA_DIR = join(data, 'booth'); env.LCA_BOOTH = '1'; await launch()
  assert.equal((await snapshot()).onboarding.status, 'completed'); assert.equal((await send({ type: 'onboarding.reset' })).error.code, 'permission-denied')
  if (!backendOnly) assert.equal(await onboarding().count(), 0)
  console.log(backendOnly ? 'Onboarding backend Electron: fresh needed / booth completed, names and completion across restarts, separate system/about-you context, no configuration experience, private manifest and empty-profile confirmed restore verified; UI acceptance not run.' : 'Onboarding Electron: real wizard entry/forms/restart prefill/completion, book after restart, reset without data loss, already-have-a-book native import/confirmed restore, profile system/about-you layers and booth bypass verified; synthetic HTTP only.')
} finally { await instance?.close().catch(() => {}); server.closeAllConnections(); await new Promise((done) => server.close(done)) }
