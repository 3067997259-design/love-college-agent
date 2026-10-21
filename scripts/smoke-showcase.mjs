import assert from 'node:assert/strict'
import { randomUUID, createHash } from 'node:crypto'
import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron } from 'playwright'
import electronPath from 'electron'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { runtimeEnv, initializeTestBook, electronLaunchTarget } from './runtime-env.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..'); const data = join(root, '.local-data', 'showcase-' + randomUUID()); const sceneId = randomUUID()
const profile = join(data, 'developer', sceneId)
const env = { ...runtimeEnv(root), LCA_DATA_DIR: data, LCA_PROVIDERS_FILE: join(data, 'absent.json'), LCA_CDP_PORT: '19559', LCA_MCP_PORT: '0' }
let instance; let page; let client; let now = Date.parse('2026-10-16T18:00:00+08:00')
const proof = []; const sha = (text) => createHash('sha256').update(text).digest('hex')
const snapshot = () => page.evaluate(() => window.lca.getSnapshot())
const send = (body, target = page) => target.evaluate(async (body) => { const s = await window.lca.getSnapshot(); return window.lca.dispatch({ protocolVersion: 1, epoch: s.epoch, requestId: crypto.randomUUID(), ...body }) }, body)
async function accepted(body, target) { const result = await send(body, target); assert.equal(result.status, 'accepted', body.type) }
async function waitFor(predicate, code) { for (let i = 0; i < 180; i++) { if (predicate(await snapshot())) return; await new Promise((done) => setTimeout(done, 100)) }; throw new Error(code) }
async function debug(name, args = {}) { const result = await client.callTool({ name, arguments: args }); assert.ok(!result.isError, name); return JSON.parse(result.content[0].text) }
async function advance(ms) { now += ms; await debug('set_clock', { nowMs: now, frozen: true }) }
async function script(steps) { await debug('set_fake_model', { script: steps }) }
async function chat(text, reply) { await script([{ text: reply, toolCalls: [], delayMs: 0 }]); await accepted({ type: 'message.send', text }); await waitFor((s) => s.task?.status === 'completed', 'CHAT_FAILED') }
async function launch() {
  instance = await _electron.launch({ ...electronLaunchTarget(root, electronPath), env }); page = await instance.firstWindow(); await initializeTestBook(page)
  const connection = JSON.parse(await readFile(join(profile, 'debug-connection.json'), 'utf8')); client = new Client({ name: 'showcase-smoke', version: '1.0.0' })
  await client.connect(new StreamableHTTPClientTransport(new URL(connection.url), { requestInit: { headers: { Authorization: 'Bearer ' + connection.token } } }))
}
async function stop() { await client?.close(); client = undefined; await instance?.close(); instance = undefined }
function safe(value) { const text = JSON.stringify(value); for (const token of ['RAW_ONLY_', 'USER_ONLY_DOCUMENT_RESULT', 'PRIVATE_SHOWCASE_WORK_BODY', 'sk-synthetic']) assert.ok(!text.includes(token), 'PRIVATE_TEXT_IN_ORDINARY_PROJECTION') }
async function mark(name) { proof.push(name); console.log('One-book stage passed: ' + name) }
try {
  await mkdir(profile, { recursive: true }); await writeFile(join(data, 'settings.json'), JSON.stringify({ version: 1, developer: true, booth: false, plugins: {}, sceneId }))
  await writeFile(join(profile, 'clock.json'), JSON.stringify({ nowMs: now, rate: 1, frozen: true })); await launch(); await accepted({ type: 'mode.set', mode: 'quiet' })
  const oldSession = (await snapshot()).scope.sessionId
  await accepted({ type: 'mail.scan' }); await waitFor((s) => s.mailbox.status === 'ready' && s.candidates.length === 2, 'CANDIDATES_MISSING')
  assert.equal((await snapshot()).mailbox.source, 'fake')
  const candidate = (await snapshot()).candidates.find((item) => item.kind === 'deadline')
  const evidence = await page.evaluate((ref) => window.lca.readEvidence(ref), candidate.evidenceRef)
  assert.ok(evidence.excerpt.includes('RAW_ONLY_MAIL_ONE')); assert.ok(evidence.highlights.length > 0)
  for (const item of (await snapshot()).candidates) await accepted({ type: 'candidate.confirm', candidateId: item.id, expectedRevision: item.revision })
  await accepted({ type: 'campus.export' }); await waitFor((s) => s.deliveries.length === 4, 'DELIVERIES_MISSING')
  const calendar = (await snapshot()).deliveries.find((item) => item.kind === 'calendar'); const opened = instance.waitForEvent('window')
  await accepted({ type: 'artifact.open', artifactId: calendar.artifactId }); const preview = await opened; await preview.locator('pre').waitFor()
  assert.ok((await preview.locator('pre').innerText()).includes('BEGIN:VCALENDAR')); assert.equal(await preview.evaluate(() => typeof window.lca), 'undefined'); await preview.close()
  await mark('mail-evidence-confirm-real-calendar')
  await accepted({ type: 'document.attachment', attachmentId: (await snapshot()).documents.attachments[0].id })
  await accepted({ type: 'developer.document.import', fixtureId: 'notes-text' }); assert.ok((await snapshot()).documents.jobs.every((job) => job.status === 'staged'))
  await accepted({ type: 'message.send', text: '/privacy' }); await waitFor((s) => s.privacy.fileFilteringEnabled && s.documents.jobs.length === 2 && s.documents.jobs.every((job) => job.status === 'ready'), 'DOCUMENTS_FAILED')
  const document = (await snapshot()).deliveries.find((item) => item.kind === 'document'); const documentOpened = instance.waitForEvent('window')
  await accepted({ type: 'artifact.open', artifactId: document.artifactId }); const documentPreview = await documentOpened; await documentPreview.locator('pre').waitFor()
  assert.ok((await documentPreview.locator('pre').innerText()).includes('USER_ONLY_DOCUMENT_RESULT')); await documentPreview.close()
  safe(await snapshot()); safe(await debug('get_context')); await mark('privacy-attachment-and-file-user-only-product')
  await accepted({ type: 'developer.life.seed' }); await accepted({ type: 'life.work.start', kind: 'read' })
  await accepted({ type: 'pomodoro.plan', plan: { label: '合成连续场景', plannedCount: 1, items: [{ text: '阅读与写作', count: 1, assist: true }], focusDurationMs: 60000, shortBreakDurationMs: 20000, longBreakDurationMs: 20000, longBreakEvery: 4, timing: 'demo' } })
  const planId = (await snapshot()).pomodoro.proposal.id; await accepted({ type: 'pomodoro.confirm', planId }); const miniOpened = instance.waitForEvent('window')
  await accepted({ type: 'pomodoro.start', planId }); const mini = await miniOpened; await mini.waitForLoadState(); await waitFor((s) => s.windows.mode === 'mini', 'MINI_MISSING')
  assert.equal(await instance.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => !w.webContents.getURL().includes('view=mini')).isVisible()), false)
  for (let count = 1; count <= 3; count++) { await advance(5000); await waitFor((s) => s.life.work.jobs.some((job) => job.kind === 'read' && job.completedSteps >= count), 'READ_CHECKPOINT_MISSING') }
  const reading = (await snapshot()).life.work.jobs.find((job) => job.kind === 'read'); assert.equal(reading.status, 'completed')
  const room = join(profile, 'rooms', (await readdir(join(profile, 'rooms')))[0]); const desk = join(room, '书桌')
  assert.equal(sha(await readFile(join(desk, reading.output.path), 'utf8')), reading.output.sha256)
  await advance(45001); await waitFor((s) => s.pomodoro.phase === 'short-break', 'BREAK_MISSING'); assert.equal((await snapshot()).windows.mode, 'mini')
  await accepted({ type: 'window.mini.hover', over: true }, mini); const miniClosed = mini.waitForEvent('close'); await mini.getByRole('button', { name: '休息了，点一下回到书本', exact: true }).click(); await miniClosed
  assert.equal((await snapshot()).windows.mode, 'book'); await advance(20001); await waitFor((s) => s.pomodoro.phase === 'idle', 'PLAN_NOT_FINISHED'); await accepted({ type: 'mode.set', mode: 'quiet' })
  await accepted({ type: 'life.work.start', kind: 'write' })
  while ((await snapshot()).life.work.jobs.find((job) => job.kind === 'write').status !== 'completed') {
    const before = (await snapshot()).life.work.jobs.find((job) => job.kind === 'write').completedSteps
    await advance(5000); await waitFor((s) => s.life.work.jobs.some((job) => job.kind === 'write' && job.completedSteps > before), 'WRITE_CHECKPOINT_MISSING')
  }
  const writing = (await snapshot()).life.work.jobs.find((job) => job.kind === 'write'); assert.equal(sha(await readFile(join(desk, writing.output.path), 'utf8')), writing.output.sha256)
  await mark('focus-mini-real-reading-writing-and-rest-expand')
  await chat('我给纸桥取名叫晚风桥。', 'SYNTHETIC_SHARED_REPLY'); await chat('这座纸桥叫晚风桥。', 'SYNTHETIC_SECOND_REPLY')
  const firstMessage = (await snapshot()).messages.find((message) => message.role === 'user' && message.text === '我给纸桥取名叫晚风桥。')
  // A question she asks mid-turn waits out quiet time, then the turn finishes with your answer.
  await script([
    { text: '', toolCalls: [{ id: 'showcase-question', name: 'ask_user_question', arguments: JSON.stringify({ questions: [{ id: 'format', header: '格式', question: '用哪种格式记下这份合成结果？', options: [{ label: 'Markdown', description: '标题和列表照样保留' }, { label: 'Text' }] }] }) }], delayMs: 0 },
    { text: 'SYNTHETIC_WORK_SAVED', toolCalls: [], delayMs: 0 },
  ])
  await accepted({ type: 'message.send', text: '这份合成结果用哪种格式记下来，你问我一下。' })
  await waitFor((s) => s.question?.status === 'queued', 'QUESTION_NOT_QUEUED'); await accepted({ type: 'mode.set', mode: 'rest' })
  await waitFor((s) => s.question?.status === 'waiting', 'QUESTION_NOT_VISIBLE'); await page.locator('[data-question="waiting"]').getByRole('button', { name: /^Markdown/ }).click()
  await waitFor((s) => s.task?.status === 'completed' && s.messages.some((message) => message.text === 'SYNTHETIC_WORK_SAVED'), 'QUESTION_TURN_FAILED'); await mark('bounded-question')
  // The model endpoint refuses her second call after a tool ran: the book narrates the failure, never the vendor's text.
  await script([{ text: '', toolCalls: [{ id: 'bounded-clock', name: 'get_clock', arguments: '{}' }], delayMs: 0 }, { text: '', toolCalls: [], delayMs: 0, httpStatus: 400 }])
  await accepted({ type: 'message.send', text: '合成失败场景：读一次时钟后模型接口拒绝请求。' }); await waitFor((s) => s.task?.status === 'failed' && s.task.error.code === 'configuration-failed' && s.messages.some((message) => message.failure?.turnId === s.task.id), 'FAILURE_NARRATION_MISSING')
  const failed = await snapshot(); const failure = failed.messages.find((message) => message.failure?.turnId === failed.task.id)
  assert.equal(failure.failure.category, 'configuration'); assert.equal(failure.failure.toolsExecuted, true); assert.ok(!JSON.stringify(failed).includes('scripted failure')); await accepted({ type: 'mode.set', mode: 'quiet' })
  await chat('工作告一段落，我们回到书页继续聊纸桥。', 'SYNTHETIC_ORDINARY_AFTER_WORK')
  safe(await debug('get_context')); await mark('bounded-failure-narration')
  // A later automatic gift photo may fail during page transitions even when the day's work photo
  // already exists. Settle that attempt, then exercise the real manual retry instead of waiting for
  // an idle status that cannot reappear while this scenario's business clock is frozen.
  await waitFor((s) => s.history.captureStatus !== 'capturing', 'PHOTO_CAPTURE_BUSY')
  const photoState = (await snapshot()).history
  if (!photoState.photos.some((p) => p.sessionId === oldSession) || photoState.captureStatus === 'failed') await accepted({ type: 'history.photo.capture' })
  await waitFor((s) => s.history.photos.some((p) => p.sessionId === oldSession) && s.history.captureStatus === 'idle', 'PHOTO_MISSING')
  const photo = (await snapshot()).history.photos.find((item) => item.sessionId === oldSession)
  await accepted({ type: 'memory.extract' }); await waitFor((s) => !['extracting', 'compacting'].includes(s.memory.status), 'MEMORY_BUSY')
  const archive = join(data, 'one-book.lca-save'); await instance.evaluate(({ dialog }, file) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: file }) }, archive)
  await accepted({ type: 'backup.export' }); await waitFor((s) => s.backup.status === 'exported', 'SAVE_FAILED'); await mark('shared-chat-work-boundary-photo-and-private-save')
  await advance(Date.parse('2026-10-17T04:03:00+08:00') - now); await waitFor((s) => s.scope.sessionId !== oldSession && s.companion.sleeping, 'DAY_END_FAILED')
  await script([{ text: '合成引用回忆响应', toolCalls: [], delayMs: 0 }])
  await accepted({ type: 'history.recall', anchor: { sessionId: oldSession, messageId: firstMessage.id, start: 0, end: firstMessage.text.length }, question: '纸桥叫什么？' })
  await waitFor((s) => s.history.recall.status === 'ready' && s.task?.status === 'completed', 'RECALL_FAILED')
  safe(await debug('get_context')); safe((await snapshot()).memory.items); assert.equal((await snapshot()).companion.sleeping, false)
  await stop(); await launch(); assert.equal((await snapshot()).windows.mode, 'book'); assert.equal(instance.windows().length, 1)
  assert.ok((await snapshot()).life.work.jobs.filter((job) => job.status === 'completed').length >= 2)
  await instance.evaluate(({ dialog, app }, file) => { app.relaunch = () => {}; dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }) }, archive)
  await accepted({ type: 'backup.import' }); await waitFor((s) => s.backup.status === 'awaiting-confirmation', 'IMPORT_FAILED')
  const restoreId = (await snapshot()).backup.restoreId; await client.close(); client = undefined; const closed = instance.waitForEvent('close'); await accepted({ type: 'backup.restore', restoreId }); await closed; instance = undefined; await launch()
  assert.equal((await snapshot()).backup.status, 'restored'); assert.equal((await snapshot()).scope.sessionId, oldSession)
  assert.equal((await snapshot()).history.photos.find((item) => item.id === photo.id).imageUrl, photo.imageUrl)
  assert.equal(sha(await readFile(join(desk, reading.output.path), 'utf8')), reading.output.sha256); assert.equal(sha(await readFile(join(desk, writing.output.path), 'utf8')), writing.output.sha256)
  assert.equal((await snapshot()).candidates.filter((item) => item.status === 'confirmed').length, 2)
  safe(await snapshot()); await mark('safe-day-rollover-recall-restart-and-exact-restore')
  await mkdir(join(root, 'test-results'), { recursive: true }); await page.screenshot({ path: join(root, 'test-results/showcase.png') })
  await writeFile(join(root, 'test-results/showcase-report.json'), JSON.stringify({ ok: true, atIso: new Date().toISOString(), stages: proof, oneProfile: true, syntheticServices: true, acceleratedClock: true, executable: process.env.LCA_TEST_EXECUTABLE ? 'explicit-build' : 'source-electron', longTermRuntimeAccepted: false }, null, 2))
} finally { await stop() }
