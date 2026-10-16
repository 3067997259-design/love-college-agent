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

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const data = join(root, '.local-data', `campus-smoke-${randomUUID()}`)
const sceneId = randomUUID(); const profile = join(data, 'developer', sceneId)
const env = { ...runtimeEnv(root), LCA_DATA_DIR: data, LCA_PROVIDERS_FILE: join(data, 'absent-test-providers.json'), LCA_MCP_PORT: '0', LCA_CDP_PORT: '19529' }
let instance; let page; let client
const snapshot = () => page.evaluate(() => window.lca.getSnapshot())
async function launch() {
  instance = await _electron.launch({ executablePath: electronPath, args: [root], env, timeout: 30_000 })
  page = await instance.firstWindow(); await initializeTestBook(page); await page.locator('[data-mode][data-pose]').waitFor()
}
async function send(body) {
  return page.evaluate(async (body) => { const s = await window.lca.getSnapshot(); return window.lca.dispatch({ ...body, protocolVersion: 1, epoch: s.epoch, requestId: crypto.randomUUID() }) }, body)
}
async function waitFor(predicate, message) {
  for (let i = 0; i < 100; i++) { if (predicate(await snapshot())) return; await new Promise((done) => setTimeout(done, 100)) }
  throw new Error(message)
}
async function openTools() { await page.getByRole('button', { name: '工具与设置', exact: true }).click() }
async function closeTools() { await page.getByRole('button', { name: '关闭', exact: true }).click() }
async function scan(scenario = 'initial') {
  await openTools()
  await page.getByLabel('合成邮件场景').selectOption(scenario)
  await waitFor((s) => s.mailbox.scenarioId === scenario, 'SCENARIO_NOT_SELECTED')
  await page.getByRole('button', { name: '扫描合成邮件', exact: true }).click()
  await waitFor((s) => ['ready', 'failed'].includes(s.mailbox.status), 'SCAN_NOT_FINISHED')
  await closeTools()
}
async function exportNew(count) {
  await openTools(); await page.getByRole('button', { name: '导出新确认事项', exact: true }).click()
  await waitFor((s) => s.deliveries.length === count, 'EXPORT_NOT_FINISHED'); await closeTools()
}
const safe = (value) => {
  const text = JSON.stringify(value)
  for (const forbidden of ['RAW_ONLY_', 'sk-synthetic', 'songyizhou@example.edu.cn', 'api_key', 'auth_code']) assert.ok(!text.includes(forbidden), 'PRIVATE_VALUE_IN_PUBLIC_PROJECTION')
}
try {
  // Normal mode remains blocked; no source observation and no real-provider file exists.
  await launch()
  const normal = await snapshot()
  assert.equal(normal.runtime.developer.mode, 'normal'); assert.equal(normal.mailbox.status, 'blocked'); assert.equal(normal.mailbox.unseenCount, null)
  assert.equal((await send({ type: 'mail.scan' })).error.code, 'source-blocked')
  assert.equal((await send({ type: 'developer.mailbox', scenarioId: 'initial' })).error.code, 'permission-denied')
  await instance.close()
  await mkdir(profile, { recursive: true })
  await writeFile(join(data, 'settings.json'), JSON.stringify({ version: 1, developer: true, booth: false, plugins: {}, sceneId }))
  await launch()
  const initial = await snapshot()
  assert.equal(initial.runtime.developer.mode, 'developer'); assert.equal(initial.capabilities.find((c) => c.id === 'mail').source, 'fake')
  assert.equal(initial.runtime.plugins.find((p) => p.id === 'mail').privacyLocked, true)
  assert.equal((await send({ type: 'plugin.privacy.set', pluginId: 'mail', privacy: 'none' })).error.code, 'permission-denied')
  const discovery = JSON.parse(await readFile(join(profile, 'debug-connection.json'), 'utf8'))
  client = new Client({ name: 'lca-campus-smoke', version: '1.0.0' })
  await client.connect(new StreamableHTTPClientTransport(new URL(discovery.url), { requestInit: { headers: { Authorization: `Bearer ${discovery.token}` } } }))
  await send({ type: 'mode.set', mode: 'quiet' })
  await scan()
  const proposed = await snapshot(); safe(proposed)
  assert.equal(proposed.mailbox.processedCount, 3); assert.equal(proposed.mailbox.pendingReviewCount, 2)
  assert.equal(proposed.candidates.length, 2); assert.equal(proposed.deliveries.length, 0)
  assert.equal(proposed.companion.mailboxUnseen, 2)
  const assignment = page.locator('.card-candidate[data-kind="deadline"]')
  await assignment.getByRole('button', { name: '看原文', exact: true }).click()
  await assignment.locator('.evidence-body').waitFor()
  const evidence = await assignment.locator('.evidence-body').innerText()
  assert.ok(evidence.includes('RAW_ONLY_MAIL_ONE'), 'USER_EVIDENCE_NOT_AVAILABLE'); assert.ok(!evidence.includes('sk-synthetic'), 'USER_KEY_NOT_REDACTED')
  assert.match(await assignment.locator('mark').allTextContents().then((parts) => parts.join(' ')), /23:59/)
  safe(await client.callTool({ name: 'get_state', arguments: {} })); safe(await client.callTool({ name: 'get_context', arguments: {} }))
  assert.equal(await page.evaluate(() => window.lca.readEvidence('../secrets/providers.json').then(() => false, () => true)), true)
  await assignment.getByLabel('计划完成时间').fill('2026-10-23T20:00')
  await assignment.getByRole('button', { name: '确认', exact: true }).click()
  await waitFor((s) => s.candidates.some((c) => c.kind === 'deadline' && c.status === 'confirmed'), 'CONFIRM_NOT_FINISHED')
  await page.locator('.card-candidate[data-kind="event"]').getByRole('button', { name: '确认', exact: true }).click()
  await waitFor((s) => s.candidates.every((c) => c.status === 'confirmed'), 'EVENT_CONFIRM_NOT_FINISHED')
  assert.equal((await snapshot()).candidates.find((c) => c.kind === 'deadline').plannedCompletionIso, '2026-10-23T20:00:00+08:00')
  await exportNew(4); await exportNew(4)
  assert.equal(await page.locator('.card-delivery[data-status="ready"]').count(), 4)
  const opened = instance.waitForEvent('window')
  await page.locator('.card-delivery[data-kind="calendar"]').first().getByRole('button', { name: '打开', exact: true }).click()
  const preview = await opened; await preview.locator('pre').waitFor()
  assert.match(await preview.locator('pre').innerText(), /BEGIN:VCALENDAR/)
  const previewIsolation = await preview.evaluate(() => ({ bridge: typeof window.lca, require: typeof window.require, process: typeof window.process }))
  assert.deepEqual(previewIsolation, { bridge: 'undefined', require: 'undefined', process: 'undefined' })
  await preview.close()
  const files = async () => Promise.all((await readdir(join(profile, 'artifacts'))).filter((f) => f.endsWith('.ics')).map(async (name) => ({ name, text: await readFile(join(profile, 'artifacts', name), 'utf8') })))
  const oldFiles = await files(); assert.equal(oldFiles.length, 2)
  const oldAssignment = oldFiles.find((f) => f.text.includes('DTSTART:20261024T155900Z'))
  assert.ok(oldAssignment, 'DEADLINE_EXPORT_NOT_WRITTEN')
  const uid = oldAssignment.text.match(/^UID:(.+)$/m)[1].trim()
  await scan('deadline-change')
  const changed = (await snapshot()).candidates.find((c) => c.kind === 'deadline')
  assert.equal(changed.status, 'changed'); assert.equal(changed.revision, 2)
  assert.equal((await send({ type: 'candidate.confirm', candidateId: changed.id, expectedRevision: 1 })).error.code, 'stale-candidate')
  assert.equal((await snapshot()).deliveries.length, 4)
  await assignment.getByRole('button', { name: '看原确认邮件', exact: true }).click()
  await assignment.locator('.card-note .evidence-body').waitFor()
  assert.ok((await assignment.locator('.card-note .evidence-body').innerText()).includes('RAW_ONLY_MAIL_ONE'), 'OLD_EVIDENCE_NOT_AVAILABLE')
  await assignment.getByRole('button', { name: '看原文', exact: true }).click()
  await assignment.locator(':scope > .evidence .evidence-body').waitFor()
  assert.ok((await assignment.locator(':scope > .evidence .evidence-body').innerText()).includes('RAW_ONLY_MAIL_CHANGE'), 'CHANGE_EVIDENCE_NOT_AVAILABLE')
  await assignment.getByRole('button', { name: '确认', exact: true }).click()
  await waitFor((s) => s.candidates.every((c) => c.status === 'confirmed'), 'CHANGE_CONFIRM_NOT_FINISHED')
  await exportNew(6)
  const updated = (await files()).find((f) => f.text.includes('DTSTART:20261026T155900Z'))
  assert.ok(updated?.text.includes('UID:' + uid + '\r\nSEQUENCE:1'), 'CALENDAR_UPDATE_IDENTITY_FAILED')
  assert.equal(await readFile(join(profile, 'artifacts', oldAssignment.name), 'utf8'), oldAssignment.text)
  // Exercise the actual harness tools; these tools never receive an evidence-reader capability.
  await client.callTool({ name: 'set_fake_model', arguments: { script: [
    { text: '', toolCalls: [{ id: 'scan', name: 'check_mail', arguments: '{}' }], delayMs: 0 },
    { text: '', toolCalls: [{ id: 'list', name: 'get_campus_items', arguments: '{}' }], delayMs: 0 },
    { text: 'CAMPUS_TOOL_CHECK_COMPLETED', toolCalls: [], delayMs: 0 },
  ] } })
  await page.locator('textarea').fill('synthetic campus tool verification'); await page.getByRole('button', { name: '发送', exact: true }).click()
  await page.locator('.msg-text').filter({ hasText: 'CAMPUS_TOOL_CHECK_COMPLETED' }).waitFor()
  const context = await client.callTool({ name: 'get_context', arguments: {} }); safe(context)
  assert.ok(JSON.stringify(context).includes('get_campus_items'), 'CAMPUS_TOOL_NOT_IN_CONTEXT')
  for (const scenario of ['privacy-failure', 'malicious']) {
    await scan(scenario)
    const failed = await snapshot()
    assert.equal(failed.mailbox.status, 'failed'); assert.equal(failed.mailbox.error.code, scenario === 'privacy-failure' ? 'privacy-unavailable' : 'privacy-invalid-output')
    assert.equal(failed.candidates.length, 2); assert.equal(failed.deliveries.length, 6); safe(failed)
    safe(await client.callTool({ name: 'get_context', arguments: {} }))
  }
  const logs = await readdir(join(profile, 'journals'))
  for (const name of logs.filter((file) => file.endsWith('.jsonl'))) safe(await readFile(join(profile, 'journals', name), 'utf8'))
  const beforeRestart = await snapshot()
  await client.close(); client = undefined; await instance.close(); await launch()
  const restored = await snapshot()
  assert.notEqual(restored.epoch, beforeRestart.epoch); assert.deepEqual(restored.candidates, beforeRestart.candidates); assert.deepEqual(restored.deliveries, beforeRestart.deliveries)
  assert.equal(await page.locator('.card-delivery[data-entering="true"]').count(), 0)
  assert.equal(await page.locator('.card-candidate[data-entering="true"]').count(), 0)
  assert.equal((await page.evaluate(() => window.lca.readEvidence('e:missing').then(() => false, () => true))), true)
  await mkdir(join(root, 'test-results'), { recursive: true }); await page.screenshot({ path: join(root, 'test-results', 'campus.png') })
  console.log('Campus smoke: synthetic UI evidence -> versioned confirmation -> real local ICS/Markdown -> same-UID change -> restart; private source absent from snapshots, MCP, tool context and journal; fail-closed privacy; real IMAP not attempted.')
} finally { await client?.close(); await instance?.close() }
