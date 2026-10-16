import assert from 'node:assert/strict'
import { randomUUID, createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron } from 'playwright'
import electronPath from 'electron'
import JSZip from 'jszip'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { runtimeEnv } from './runtime-env.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..'); const data = join(root, '.local-data', 'backup-smoke-' + randomUUID()); const sceneId = randomUUID()
let profile = join(data, 'developer', sceneId)
const env = { ...runtimeEnv(root), LCA_DATA_DIR: data, LCA_PROVIDERS_FILE: join(data, 'absent-test-providers.json'), LCA_MCP_PORT: '0', LCA_CDP_PORT: '19533' }
let instance; let page; let client
async function launch() { instance = await _electron.launch({ executablePath: electronPath, args: [root], env, timeout: 30_000 }); page = await instance.firstWindow(); await page.locator('[data-mode][data-pose]').waitFor() }
const snapshot = () => page.evaluate(() => window.lca.getSnapshot())
async function waitFor(predicate, error) { for (let i = 0; i < 200; i++) { if (predicate(await snapshot())) return; await new Promise((done) => setTimeout(done, 100)) } throw new Error(error) }
const send = (body) => page.evaluate(async (body) => { const s = await window.lca.getSnapshot(); return window.lca.dispatch({ ...body, epoch: s.epoch, protocolVersion: 1, requestId: crypto.randomUUID() }) }, body)
const tools = async () => { await send({ type: 'window.book' }); await waitFor((s) => s.windows?.mode === 'book', 'BOOK_NOT_EXPANDED'); await page.getByRole('button', { name: '工具与设置', exact: true }).click() }
const closeTools = () => page.getByRole('button', { name: '关闭', exact: true }).click()
const safe = (value) => { const text = JSON.stringify(value); for (const marker of ['RAW_ONLY_', 'USER_ONLY_DOCUMENT_RESULT', 'sk-synthetic', 'APPLICATION_CREDENTIAL_CANARY']) assert.ok(!text.includes(marker), 'BACKUP_PUBLIC_DATA_LEAK') }
const mcp = async (name, args = {}) => { const result = await client.callTool({ name, arguments: args }); assert.ok(!result.isError, 'MCP_OPERATION_FAILED'); return JSON.parse(result.content[0].text) }
async function connectDebug() {
  const discovery = JSON.parse(await readFile(join(profile, 'debug-connection.json'), 'utf8')); client = new Client({ name: 'lca-backup-smoke', version: '1.0.0' })
  await client.connect(new StreamableHTTPClientTransport(new URL(discovery.url), { requestInit: { headers: { Authorization: 'Bearer ' + discovery.token } } }))
}
async function chat(text) { const count = (await snapshot()).messages.length; await send({ type: 'message.send', text }); await waitFor((s) => s.task?.status === 'completed' && s.messages.length >= count + 2, 'SYNTHETIC_CHAT_FAILED') }
async function chooseImport(file) { await instance.evaluate(({ dialog }, file) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }) }, file); await send({ type: 'backup.import' }); await waitFor((s) => !['validating'].includes(s.backup.status), 'IMPORT_VALIDATION_HUNG') }
async function confirmAndRestart() {
  await instance.evaluate(({ app }) => { app.relaunch = () => {} })
  const closed = instance.waitForEvent('close'); await page.getByRole('alertdialog', { name: '恢复私人存档确认' }).getByRole('button', { name: '备份当前数据并恢复', exact: true }).click()
  await closed; client = undefined; await launch()
}
try {
  await mkdir(data, { recursive: true }); await writeFile(join(data, 'settings.json'), JSON.stringify({ version: 1, developer: true, booth: false, plugins: {}, sceneId }))
  await launch(); await connectDebug(); await mcp('set_clock', { frozen: true }); await send({ type: 'mode.set', mode: 'quiet' })
  await chat('我把纸桥放在书桌上，给它取名叫周五桥。'); await chat('我喜欢的饮料是咖啡。'); await chat('我喜欢的饮料现在改为红茶，不再喝咖啡。')
  await send({ type: 'memory.extract' }); await waitFor((s) => s.memory.status === 'idle' && s.memory.items.length === 3, 'MEMORY_NOT_READY')
  await send({ type: 'mail.scan' }); await waitFor((s) => s.mailbox.status === 'ready', 'MAIL_NOT_READY')
  const candidate = (await snapshot()).candidates[0]; await send({ type: 'candidate.confirm', candidateId: candidate.id, expectedRevision: candidate.revision }); await send({ type: 'campus.export' })
  await send({ type: 'privacy.set', enabled: true }); await send({ type: 'developer.document.import', fixtureId: 'notes-text' })
  await waitFor((s) => s.documents.jobs[0]?.status === 'ready' && s.deliveries.length === 3, 'WORK_NOT_DELIVERED')
  await mcp('set_clock', { nowMs: (await snapshot()).clock.nowMs + 1000 })
  assert.equal((await snapshot()).quill, undefined, 'UNSEEN_WORK_CREATED_GIFT')
  const lastTask = (await snapshot()).task?.id
  await send({ type: 'mode.set', mode: 'rest' })
  await waitFor((s) => s.task?.id !== lastTask && s.task?.status === 'completed', 'WORK_FACT_NOT_DELIVERED_AT_REST')
  await mcp('set_clock', { nowMs: (await snapshot()).clock.nowMs + 1000 })
  await waitFor((s) => s.quill?.state === 'given', 'FIRST_GIFT_NOT_GIVEN_AT_REST')
  await page.getByRole('button', { name: '羽毛笔 · 导出存档', exact: true }).waitFor()
  const evidenceBefore = await page.evaluate((ref) => window.lca.readEvidence(ref), candidate.evidenceRef)
  assert.ok(evidenceBefore.excerpt.length > 0)
  await send({ type: 'pomodoro.plan', plan: { label: '存档验收', plannedCount: 2, focusDurationMs: 60_000, shortBreakDurationMs: 20_000, longBreakDurationMs: 20_000, longBreakEvery: 4, timing: 'demo' } })
  let s = await snapshot(); await send({ type: 'pomodoro.confirm', planId: s.pomodoro.plan.id }); await send({ type: 'pomodoro.start', planId: s.pomodoro.plan.id })
  s = await snapshot(); await mcp('set_clock', { nowMs: s.clock.nowMs + 10_000 })
  const before = await snapshot(); assert.equal(before.pomodoro.remainingMs, 50_000)
  await mkdir(join(profile, 'secrets'), { recursive: true }); await writeFile(join(profile, 'secrets/providers.json'), 'APPLICATION_CREDENTIAL_CANARY')
  const archiveFile = join(data, 'actual-private.lca-save')
  await instance.evaluate(({ dialog }, file) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: file }) }, archiveFile)
  await tools(); await page.getByRole('button', { name: '导出私人存档', exact: true }).click()
  await waitFor((s) => s.backup.status === 'exported', 'SAVE_EXPORT_FAILED'); await closeTools()
  const bytes = await readFile(archiveFile); const zip = await JSZip.loadAsync(bytes, { checkCRC32: true }); const manifest = JSON.parse(await zip.file('manifest.json').async('string'))
  assert.equal(manifest.pomodoro.remainingMs, 50_000); assert.equal(manifest.counts.memoryCount, 4); assert.equal(manifest.counts.deliveryCount, 3)
  assert.ok(manifest.files.every((file) => !/secrets|settings|connections|clock|debug|plugins/.test(file.path)))
  for (const file of manifest.files) { const actual = await zip.file(file.path).async('nodebuffer'); assert.equal(createHash('sha256').update(actual).digest('hex'), file.sha256); assert.ok(!actual.includes(Buffer.from('APPLICATION_CREDENTIAL_CANARY'))) }
  await chat('AFTER_SAVE_SHOULD_BE_REWOUND'); await send({ type: 'lights.set', lightsOut: true })
  await mcp('set_clock', { nowMs: (await snapshot()).clock.nowMs + 24 * 60 * 60_000 })
  const tampered = await JSZip.loadAsync(bytes); tampered.file(manifest.files[0].path, 'tampered', { createFolders: false }); const badFile = join(data, 'corrupt.lca-save'); await writeFile(badFile, await tampered.generateAsync({ type: 'nodebuffer' }))
  await tools(); await chooseImport(badFile)
  assert.equal((await snapshot()).backup.error.code, 'backup-invalid'); assert.ok((await snapshot()).messages.some((message) => message.text === 'AFTER_SAVE_SHOULD_BE_REWOUND'))
  await chooseImport(archiveFile); assert.equal((await snapshot()).backup.status, 'awaiting-confirmation')
  assert.equal((await send({ type: 'backup.restore', restoreId: randomUUID() })).error.code, 'invalid-command')
  await page.getByRole('alertdialog', { name: '恢复私人存档确认' }).getByRole('button', { name: '取消恢复', exact: true }).click()
  assert.equal((await snapshot()).backup.status, 'idle'); assert.ok((await snapshot()).messages.some((message) => message.text === 'AFTER_SAVE_SHOULD_BE_REWOUND'))
  await chooseImport(archiveFile); await client.close(); client = undefined; await confirmAndRestart()
  const restored = await snapshot(); assert.equal(restored.backup.status, 'restored'); assert.notEqual(restored.epoch, before.epoch); assert.equal(restored.scope.sessionId, before.scope.sessionId)
  assert.deepEqual(restored.messages, before.messages); assert.deepEqual(restored.memory.items, before.memory.items); assert.deepEqual(restored.deliveries, before.deliveries)
  assert.deepEqual(restored.quill, before.quill); assert.equal(restored.quill.state, 'given')
  assert.equal(restored.privacy.fileFilteringEnabled, true); assert.equal(restored.companion.lightsOut, false); assert.equal(restored.pomodoro.remainingMs, 50_000)
  assert.equal(restored.pomodoro.endsAtMs, restored.clock.nowMs + 50_000); assert.equal(restored.session.rolloverPending, true)
  assert.deepEqual(await page.evaluate((ref) => window.lca.readEvidence(ref), candidate.evidenceRef), evidenceBefore)
  const safetyZip = await JSZip.loadAsync(await readFile(join(profile, 'backups', 'pre-restore-' + restored.backup.safetyBackupId + '.lca-save')))
  const safetyManifest = JSON.parse(await safetyZip.file('manifest.json').async('string'))
  assert.ok((await safetyZip.file(safetyManifest.files.find((file) => file.path.endsWith('.jsonl')).path).async('string')).includes('AFTER_SAVE_SHOULD_BE_REWOUND'))
  const opened = instance.waitForEvent('window'); await page.locator('.card-delivery[data-kind="document"]').getByRole('button', { name: '打开', exact: true }).click(); const preview = await opened
  await preview.locator('pre').waitFor(); assert.ok((await preview.locator('pre').innerText()).includes('USER_ONLY_DOCUMENT_RESULT')); await preview.close()
  await connectDebug(); await chat('纸桥'); const context = await mcp('get_context'); safe(context); assert.ok(JSON.stringify(context).includes('周五桥')); assert.ok(!JSON.stringify(context).includes('AFTER_SAVE_SHOULD_BE_REWOUND')); safe(await snapshot())
  await client.close(); client = undefined; await instance.close(); await launch(); assert.ok((await snapshot()).messages.some((message) => message.text === '纸桥'))
  await instance.close()
  // Demonstrate the pitch's empty-book path with a fresh profile, preserving all existing user data.
  const emptyScene = randomUUID(); profile = join(data, 'developer', emptyScene)
  await writeFile(join(data, 'settings.json'), JSON.stringify({ version: 1, developer: true, booth: false, plugins: {}, sceneId: emptyScene }))
  await launch(); assert.equal((await snapshot()).messages.length, 0); await tools(); await chooseImport(archiveFile); await confirmAndRestart()
  const emptyRestored = await snapshot(); assert.equal(emptyRestored.backup.status, 'restored'); assert.deepEqual(emptyRestored.messages, before.messages); assert.equal(emptyRestored.deliveries.length, 3); assert.deepEqual(emptyRestored.quill, before.quill)
  safe(emptyRestored); await tools(); await page.getByRole('heading', { name: '私人存档', exact: true }).scrollIntoViewIfNeeded()
  await mkdir(join(root, 'test-results'), { recursive: true }); await page.screenshot({ path: join(root, 'test-results', 'backup.png') })
  console.log('Backup smoke: real SQLite-backed ZIP export, native chooser and explicit restore consent, tamper refusal/cancel, safety archive, same and empty profile recovery, original chat/memory/mail/document/artifact continuity, exact timer reanchoring without catch-up, restart and safe public views verified; fake model/data only.')
} finally { await client?.close(); await instance?.close() }
