import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron } from 'playwright'
import electronPath from 'electron'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { runtimeEnv, initializeTestBook } from './runtime-env.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..'); const data = join(root, '.local-data', 'documents-smoke-' + randomUUID())
const sceneId = randomUUID(); const profile = join(data, 'developer', sceneId)
const env = { ...runtimeEnv(root), LCA_DATA_DIR: data, LCA_PROVIDERS_FILE: join(data, 'absent-test-providers.json'), LCA_MCP_PORT: '0', LCA_CDP_PORT: '19530' }
let instance; let page; let client
async function launch() { instance = await _electron.launch({ executablePath: electronPath, args: [root], env, timeout: 30_000 }); page = await instance.firstWindow(); await initializeTestBook(page); await page.locator('[data-mode][data-pose]').waitFor() }
const snapshot = () => page.evaluate(() => window.lca.getSnapshot())
async function waitFor(predicate, error) { for (let i = 0; i < 150; i++) { if (predicate(await snapshot())) return; await new Promise((done) => setTimeout(done, 100)) } throw new Error(error) }
const send = (body) => page.evaluate(async (body) => { const s = await window.lca.getSnapshot(); return window.lca.dispatch({ ...body, epoch: s.epoch, protocolVersion: 1, requestId: crypto.randomUUID() }) }, body)
const openTools = () => page.getByRole('button', { name: '工具与设置', exact: true }).click()
const closeTools = () => page.getByRole('button', { name: '关闭', exact: true }).click()
const safe = (value) => { const text = JSON.stringify(value); for (const marker of ['RAW_ONLY_', 'USER_ONLY_DOCUMENT_RESULT', 'PRIVATE_ORIGINAL_NAME', 'sk-synthetic', 'PRIVATE_FAULT_']) assert.ok(!text.includes(marker), 'PRIVATE_DOCUMENT_LEAK') }
async function slash(value) { await page.locator('textarea').fill(value); if (value.startsWith('/')) { assert.equal(await page.getByRole('listbox', { name: '可用指令', exact: true }).isVisible(), true); if (value === '/privacy') await page.screenshot({ path: join(root, 'test-results', 'slash-menu.png') }) } await page.getByRole('button', { name: '发送', exact: true }).click() }
async function drop(path) {
  // Native file backing is retained when placed into DataTransfer. A JS-created File is refused.
  await page.evaluate(() => { const input = document.createElement('input'); input.type = 'file'; input.id = 'native-drop-carrier'; input.hidden = true; document.body.append(input) })
  await page.locator('#native-drop-carrier').setInputFiles(path)
  await page.evaluate(() => { const input = document.querySelector('#native-drop-carrier'); const data = new DataTransfer(); data.items.add(input.files[0]); document.body.dispatchEvent(new DragEvent('drop', { dataTransfer: data, bubbles: true, cancelable: true })); input.remove() })
}
try {
  await mkdir(data, { recursive: true })
  const source = join(data, 'PRIVATE_ORIGINAL_NAME.txt')
  await writeFile(source, 'SYNTHETIC_USER_FILE\nRAW_ONLY_DROPPED_FILE\nDeadline: 2026-10-24 23:59\nAPI key: sk-syntheticdroppedcredential1234567890\n')
  await launch()
  await mkdir(join(root, 'test-results'), { recursive: true }); await page.screenshot({ path: join(root, 'test-results', 'composer-paperclip.png') })
  assert.equal((await snapshot()).mailbox.status, 'blocked')
  assert.equal((await send({ type: 'privacy.set', enabled: true })).error.code, 'privacy-unavailable')
  const forged = await page.evaluate(async () => { const s = await window.lca.getSnapshot(); return window.lca.importFiles([new File(['synthetic'], 'forged.txt')], s.epoch) })
  assert.equal(forged.error.code, 'invalid-command')
  await page.getByLabel('选择资料文件', { exact: true }).setInputFiles(source)
  await waitFor((s) => s.documents.jobs.length === 1, 'NORMAL_STAGING_FAILED')
  assert.equal((await snapshot()).documents.jobs[0].status, 'staged'); assert.equal((await snapshot()).deliveries.length, 0)
  await instance.close()
  await writeFile(join(data, 'settings.json'), JSON.stringify({ version: 1, developer: true, booth: false, plugins: {}, sceneId }))
  await launch(); assert.equal((await snapshot()).documents.jobs.length, 0)
  await send({ type: 'mode.set', mode: 'quiet' })
  const discovery = JSON.parse(await readFile(join(profile, 'debug-connection.json'), 'utf8'))
  client = new Client({ name: 'lca-documents-smoke', version: '1.0.0' })
  await client.connect(new StreamableHTTPClientTransport(new URL(discovery.url), { requestInit: { headers: { Authorization: 'Bearer ' + discovery.token } } }))
  await drop(source)
  await waitFor((s) => s.documents.jobs.length === 1, 'NATIVE_DROP_NOT_ACCEPTED')
  assert.equal((await snapshot()).documents.jobs[0].status, 'staged')
  await page.getByRole('button', { name: '日程', exact: true }).click()
  await page.getByRole('button', { name: '扫描合成邮件', exact: true }).click()
  await waitFor((s) => s.mailbox.status === 'ready' && s.documents.attachments.length === 1, 'ATTACHMENT_NOT_DISCOVERED')
  await page.locator('.bookmarks').getByRole('button', { name: /^对话/ }).click()
  await openTools(); await page.locator('.document-attachment').getByRole('button', { name: '整理附件', exact: true }).click()
  await waitFor((s) => s.documents.jobs.length === 2, 'ATTACHMENT_NOT_STAGED')
  assert.equal((await snapshot()).documents.jobs.find((job) => job.origin === 'mail-attachment').status, 'staged')
  assert.equal((await snapshot()).deliveries.length, 0); await closeTools()
  const attemptsBefore = await client.callTool({ name: 'get_context', arguments: {} })
  await slash('/privacy')
  await waitFor((s) => s.privacy.fileFilteringEnabled && s.documents.jobs.every((job) => job.status === 'ready'), 'ISOLATED_ORGANIZING_FAILED')
  assert.equal(await page.locator('.filter-mark').count(), 1)
  const completed = await snapshot(); safe(completed)
  assert.equal(completed.deliveries.length, 2); assert.equal(completed.documents.jobs.find((job) => job.format === 'pdf').pageCount, 1)
  assert.ok(completed.documents.jobs.every((job) => job.deadlineIso === '2026-10-24T23:59:00+08:00'), 'VALIDATED_DEADLINE_MISSING')
  assert.deepEqual(await client.callTool({ name: 'get_context', arguments: {} }), attemptsBefore)
  const opened = instance.waitForEvent('window')
  await page.locator('.card-delivery[data-kind="document"]').first().getByRole('button', { name: '打开', exact: true }).click()
  const preview = await opened; await preview.locator('pre').waitFor()
  const content = await preview.locator('pre').innerText()
  assert.ok(content.includes('RAW_ONLY_DROPPED_FILE') && content.includes('USER_ONLY_DOCUMENT_RESULT'), 'USER_ONLY_FILE_NOT_OPENED')
  assert.ok(!content.includes('sk-synthetic'), 'CREDENTIAL_IN_DELIVERY')
  assert.equal(await preview.evaluate(() => typeof window.lca), 'undefined'); await preview.close()
  const outputFiles = (await readdir(join(profile, 'artifacts'))).filter((name) => name.endsWith('.md'))
  assert.equal(outputFiles.length, 2)
  const outputs = await Promise.all(outputFiles.map((name) => readFile(join(profile, 'artifacts', name), 'utf8')))
  assert.ok(outputs.some((text) => text.includes('RAW_ONLY_ATTACHMENT_PDF')), 'ATTACHMENT_OUTPUT_NOT_WRITTEN')
  await client.callTool({ name: 'set_fake_model', arguments: { script: [
    { text: '', toolCalls: [{ id: 'status', name: 'get_processed_files', arguments: '{}' }], delayMs: 0 },
    { text: 'DOCUMENT_METADATA_CHECK_COMPLETED', toolCalls: [], delayMs: 0 },
  ] } })
  await slash('synthetic metadata-only document check')
  await page.locator('.msg-text').filter({ hasText: 'DOCUMENT_METADATA_CHECK_COMPLETED' }).waitFor()
  const context = await client.callTool({ name: 'get_context', arguments: {} }); safe(context)
  assert.ok(JSON.stringify(context).includes('get_processed_files'), 'DOCUMENT_TOOL_NOT_EXECUTED')
  safe(await client.callTool({ name: 'get_state', arguments: {} }))
  for (const scenario of ['privacy-failure', 'malicious']) {
    await openTools(); await page.getByLabel('资料滤芯场景').selectOption(scenario)
    await waitFor((s) => s.documents.scenarioId === scenario, 'FILTER_SCENARIO_NOT_SET'); await closeTools()
    const path = join(data, scenario + '.txt'); await writeFile(path, 'PRIVATE_FAULT_' + scenario)
    await page.getByLabel('选择资料文件', { exact: true }).setInputFiles(path)
    await waitFor((s) => s.documents.jobs.at(-1)?.status === 'failed', 'FILTER_FAULT_NOT_REPORTED')
    const failed = await snapshot(); assert.equal(failed.documents.jobs.at(-1).error.code, scenario === 'malicious' ? 'privacy-invalid-output' : 'privacy-unavailable')
    assert.equal(failed.deliveries.length, 2); safe(failed)
  }
  await openTools(); await page.getByLabel('资料滤芯场景').selectOption('ready')
  const failedId = (await snapshot()).documents.jobs.find((job) => job.error?.code === 'privacy-unavailable').id
  await page.locator(`.document-job[data-id="${failedId}"]`).getByRole('button', { name: '重试', exact: true }).click()
  await waitFor((s) => s.deliveries.length === 3, 'EXPLICIT_RETRY_FAILED'); await closeTools()
  for (const fixtureId of ['malformed-pdf', 'scanned-pdf']) {
    assert.equal((await send({ type: 'developer.document.import', fixtureId })).status, 'accepted')
    await waitFor((s) => s.documents.jobs.at(-1)?.status === 'failed', 'BAD_PDF_NOT_REJECTED')
    assert.equal((await snapshot()).documents.jobs.at(-1).error.code, 'document-parse-failed')
  }
  for (const name of (await readdir(join(profile, 'journals'))).filter((name) => name.endsWith('.jsonl'))) safe(await readFile(join(profile, 'journals', name), 'utf8'))
  safe(await client.callTool({ name: 'get_context', arguments: {} })); safe(await client.callTool({ name: 'get_state', arguments: {} }))
  const beforeRestart = await snapshot(); await client.close(); client = undefined; await instance.close(); await launch()
  const restored = await snapshot()
  assert.equal(restored.privacy.fileFilteringEnabled, true); assert.deepEqual(restored.documents.jobs, beforeRestart.documents.jobs); assert.deepEqual(restored.deliveries, beforeRestart.deliveries)
  assert.equal(await page.locator('.card-delivery[data-entering="true"]').count(), 0)
  await slash('/privacy off'); await waitFor((s) => !s.privacy.fileFilteringEnabled, 'PRIVACY_OFF_FAILED')
  const offFile = join(data, 'after-off.md'); await writeFile(offFile, 'RAW_ONLY_AFTER_OFF\nsynthetic staging')
  await drop(offFile); await waitFor((s) => s.documents.jobs.at(-1)?.status === 'staged', 'PRIVACY_OFF_NOT_STAGED')
  const staged = (await snapshot()).documents.jobs.at(-1).id
  await send({ type: 'document.cancel', documentId: staged }); assert.equal((await snapshot()).documents.jobs.at(-1).status, 'cancelled')
  await mkdir(join(root, 'test-results'), { recursive: true }); await page.screenshot({ path: join(root, 'test-results', 'documents.png') })
  await instance.close(); await launch(); assert.equal((await snapshot()).privacy.fileFilteringEnabled, false)
  console.log('Documents smoke: native drop/chooser, staged mail PDF, local persistent /privacy, actual isolated PDF process and Markdown preview, metadata-only tool/MCP/journal, explicit retry, malformed/no-text PDF refusal, cancel and restart; real IMAP/model not attempted.')
} finally { await client?.close(); await instance?.close() }
