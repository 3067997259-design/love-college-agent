import assert from 'node:assert/strict'
import { randomUUID, createHash } from 'node:crypto'
import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron } from 'playwright'
import electronPath from 'electron'
import JSZip from 'jszip'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { runtimeEnv, initializeTestBook } from './runtime-env.mjs'
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..'); const data = join(root, '.local-data', 'history-smoke-' + randomUUID()); let sceneId = randomUUID()
const env = { ...runtimeEnv(root), LCA_DATA_DIR: data, LCA_PROVIDERS_FILE: join(data, 'absent.json'), LCA_CDP_PORT: '19547', LCA_MCP_PORT: '0' }
let instance; let page; let client
const snapshot = () => page.evaluate(() => window.lca.getSnapshot())
const send = (body) => page.evaluate(async (body) => { const s = await window.lca.getSnapshot(); return window.lca.dispatch({ ...body, protocolVersion: 1, epoch: s.epoch, requestId: body.requestId ?? crypto.randomUUID() }) }, body)
async function waitFor(test, error) { for (let index = 0; index < 160; index++) { if (test(await snapshot())) return; await new Promise((resolve) => setTimeout(resolve, 100)) }; throw new Error(error) }
async function debug(name, args = {}) { const result = await client.callTool({ name, arguments: args }); assert.ok(!result.isError); return JSON.parse(result.content[0].text) }
async function setupScene() {
  await mkdir(join(data, 'developer', sceneId), { recursive: true }); await writeFile(join(data, 'settings.json'), JSON.stringify({ version: 1, developer: true, booth: false, plugins: {}, sceneId }))
  await writeFile(join(data, 'developer', sceneId, 'clock.json'), JSON.stringify({ nowMs: Date.parse('2026-10-16T20:00:00+08:00'), frozen: true, rate: 1 }))
}
async function launch() {
  instance = await _electron.launch({ executablePath: process.env.LCA_HISTORY_EXECUTABLE ?? electronPath, args: process.env.LCA_HISTORY_EXECUTABLE ? [] : [root], env }); page = await instance.firstWindow(); await page.emulateMedia({ reducedMotion: 'reduce' }); await initializeTestBook(page)
  const config = JSON.parse(await readFile(join(data, 'developer', sceneId, 'debug-connection.json'), 'utf8')); client = new Client({ name: 'history-smoke', version: '1.0.0' })
  await client.connect(new StreamableHTTPClientTransport(new URL(config.url), { requestInit: { headers: { Authorization: 'Bearer ' + config.token } } }))
  await page.locator('[data-photo-scene] canvas, [data-photo-scene] img').first().waitFor()
}
async function stop() { await client?.close(); client = undefined; await instance?.close(); instance = undefined }
try {
  await setupScene(); await launch()
  await debug('set_fake_model', { script: [{ text: '合成经历：周五桥放在窗边。', toolCalls: [], delayMs: 0 }] })
  await send({ type: 'message.send', text: '我把纸桥放在窗边，取名叫周五桥。' }); await waitFor((s) => s.task?.status === 'completed', 'HISTORY_CHAT_FAILED')
  const quotedMessage = (await snapshot()).messages.find((message) => message.role === 'user')
  await send({ type: 'message.send', text: '窗边那座桥是我们一起折的。' }); await waitFor((s) => s.task?.status === 'completed' && s.messages.filter((message) => message.role === 'user').length === 2, 'HISTORY_SECOND_TURN_FAILED')
  const sessionId = (await snapshot()).scope.sessionId
  await page.waitForFunction(() => document.querySelector('[data-photo-scene] canvas')?.getAttribute('data-photo-ready') === 'true' || !!document.querySelector('[data-photo-scene] img')?.complete)
  await page.addStyleTag({ content: '.wall-clock,.door{background:rgb(255,0,255)!important;z-index:99999!important;opacity:1!important;filter:none!important;mix-blend-mode:normal!important;backdrop-filter:none!important}' })
  const countCanaryPixels = (bytes) => instance.evaluate(({ nativeImage }, bytes) => {
    const bitmap = nativeImage.createFromBuffer(Buffer.from(bytes)).toBitmap(); let count = 0
    for (let i = 0; i < bitmap.length; i += 4) if (bitmap[i] > 200 && bitmap[i + 1] < 70 && bitmap[i + 2] > 200) count++
    return count
  }, [...bytes])
  assert.ok(await countCanaryPixels(await page.screenshot()) > 100, 'PHOTO_PIXEL_CANARY_MISSING')
  await page.getByRole('button', { name: '工具与设置', exact: true }).click()
  // Inspect the real capture call while an overlay is open; all non-scene nodes must be hidden.
  await instance.evaluate(({ BrowserWindow }) => {
    const contents = BrowserWindow.getAllWindows()[0].webContents; const capture = contents.capturePage.bind(contents)
    contents.capturePage = async (...args) => {
      const hidden = await contents.executeJavaScript("['.wall-clock','.door','[aria-label=\"记忆与日会话控制\"]'].every(s=>!document.querySelector(s)||getComputedStyle(document.querySelector(s)).visibility==='hidden')")
      if (!hidden) throw new Error('PHOTO_UI_NOT_HIDDEN'); return capture(...args)
    }
  })
  assert.equal((await send({ type: 'history.photo.capture' })).status, 'accepted'); await waitFor((s) => s.history.photos.length === 1, 'PHOTO_CAPTURE_FAILED')
  let photo = (await snapshot()).history.photos[0]; assert.equal(photo.sessionId, sessionId); assert.ok(photo.width > 100 && photo.height > 100)
  assert.equal(await page.evaluate(() => !!document.getElementById('lca-photo-isolation')), false)
  let image = Buffer.from(await page.evaluate(async (url) => [...new Uint8Array(await (await fetch(url)).arrayBuffer())], photo.imageUrl)); assert.equal(image.subarray(0, 8).toString('hex'), '89504e470d0a1a0a')
  assert.equal(await countCanaryPixels(image), 0, 'PHOTO_RETAINED_CLOCK_OR_SIGN_PIXELS')
  await mkdir(join(root, 'test-results'), { recursive: true }); await writeFile(join(root, 'test-results/history-photo.png'), image)
  await page.getByRole('button', { name: '关闭', exact: true }).click()
  const openedMini = instance.waitForEvent('window'); await send({ type: 'window.mini' }); const mini = await openedMini; await waitFor((s) => s.windows?.mode === 'mini', 'HISTORY_MINI_FAILED')
  await mini.waitForFunction(() => !!window.lca)
  assert.equal((await mini.evaluate(async () => { const s = await window.lca.getSnapshot(); return window.lca.dispatch({ protocolVersion: 1, epoch: s.epoch, requestId: crypto.randomUUID(), type: 'history.photo.capture' }) })).error.code, 'permission-denied')
  const previousPhoto = photo.id; await send({ type: 'history.photo.capture' }); await waitFor((s) => s.history.captureStatus === 'idle' && s.history.photos[0].id !== previousPhoto, 'HIDDEN_BOOK_CAPTURE_FAILED')
  assert.equal(await instance.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((window) => !window.webContents.getURL().includes('view=mini')).isVisible()), false)
  photo = (await snapshot()).history.photos[0]; image = Buffer.from(await page.evaluate(async (url) => [...new Uint8Array(await (await fetch(url)).arrayBuffer())], photo.imageUrl))
  assert.equal(await countCanaryPixels(image), 0, 'HIDDEN_PHOTO_RETAINED_UI'); await send({ type: 'window.expand' })
  await debug('set_clock', { nowMs: Date.parse('2026-10-17T12:00:00+08:00') }); await waitFor((s) => s.session.dayKey === '2026-10-17', 'HISTORY_ROLLOVER_FAILED')
  assert.deepEqual((await page.evaluate((id) => window.lca.readSession(id), sessionId)).photo, photo)
  const historical = await page.evaluate((id) => window.lca.readSession(id), sessionId); assert.ok(historical.recallableMessageIds.includes(quotedMessage.id))
  await debug('set_fake_model', { script: [{ text: '合成回忆：我们一起折的周五桥在窗边。', toolCalls: [], delayMs: 500 }] })
  await debug('set_clock', { frozen: false, rate: 1 })
  await page.getByRole('button', { name: '工具与设置', exact: true }).click(); await page.getByLabel('历史会话', { exact: true }).selectOption(sessionId)
  await page.locator(`[data-quote-message="${quotedMessage.id}"]`).click(); await page.getByRole('textbox', { name: '回忆问题', exact: true }).fill('这座桥有什么意义？')
  await page.getByRole('button', { name: '引用并回忆', exact: true }).click(); await waitFor((s) => s.history.recall.status === 'recalling', 'RECALL_STATUS_MISSING')
  assert.equal((await snapshot()).history.recall.photo.id, photo.id); await waitFor((s) => s.history.recall.status === 'ready', 'RECALL_UI_FAILED')
  await debug('set_clock', { frozen: true })
  assert.ok(JSON.stringify(await debug('get_context')).includes('recalledSeenReference')); await page.getByRole('button', { name: '关闭', exact: true }).click()
  // 书页入口：往回翻到那一页，左页换成那天保存的照片（不进实时拍照根）；从书里引用整句，回到今天贴引用条发问
  await debug('set_fake_model', { script: [{ text: '合成回忆：书页里引用的周五桥。', toolCalls: [], delayMs: 500 }] })
  await debug('set_clock', { frozen: false, rate: 1 })
  await page.locator('.turn-back').click(); await page.locator(`.old-page [data-message-id="${quotedMessage.id}"]`).waitFor()
  assert.equal(await page.locator('.history-photo[data-mode="page"] .history-photo-img').getAttribute('src'), photo.imageUrl)
  assert.equal(await page.locator('[data-photo-scene] .history-photo').count(), 0, 'HISTORY_OVERLAY_IN_CAPTURE_ROOT')
  await page.locator(`.old-page [data-message-id="${quotedMessage.id}"]`).hover(); await page.locator(`.old-page [data-message-id="${quotedMessage.id}"] .quote-button`).click()
  await page.locator('.quote-chip').waitFor(); await page.locator('.composer-input').fill('书页里这一句还记得吗？'); await page.locator('.composer .btn-primary').click()
  await waitFor((s) => s.history.recall.status === 'recalling', 'BOOK_RECALL_STATUS_MISSING'); await page.locator('.history-photo[data-mode="recall"]').waitFor({ state: 'attached' })
  await waitFor((s) => s.history.recall.status === 'ready' && s.messages.some((message) => message.text.includes('书页里引用的周五桥')), 'BOOK_RECALL_FAILED')
  assert.equal(await page.locator('.quote-chip').count(), 0); await debug('set_clock', { frozen: true })
  const anchor = { sessionId, messageId: quotedMessage.id, start: 0, end: quotedMessage.text.length }; const recallId = randomUUID()
  await debug('set_fake_model', { script: [{ text: '', toolCalls: [{ id: 'expand-recall', name: 'recall_seen', arguments: JSON.stringify({ requestId: recallId, relativeStart: 0, count: 2 }) }], delayMs: 0 }, { text: '合成扩读完成：周五桥和窗边的共同经历。', toolCalls: [], delayMs: 0 }] })
  assert.equal((await send({ type: 'history.recall', requestId: recallId, anchor, question: '再看看附近那段对话。' })).status, 'accepted'); await waitFor((s) => s.history.recall.requestId === recallId && s.history.recall.status === 'ready', 'RECALL_TOOL_FAILED')
  const profile = join(data, 'developer', sceneId); const journals = join(profile, 'journals'); const ownerFolder = join(journals, (await readdir(journals))[0])
  const rows = (await readFile(join(ownerFolder, '2026-10-17.jsonl'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line))
  const expansionCalls = new Set(rows.filter((row) => row.type === 'tool/call' && row.name === 'recall_seen').map((row) => row.callId))
  assert.ok(rows.some((row) => row.type === 'history/recall-read' && row.requestId === recallId)); assert.ok(rows.some((row) => row.type === 'tool/result' && expansionCalls.has(row.callId) && row.ok))
  for (const frame of rows.filter((row) => row.type === 'model/seen')) for (const index of frame.eligibleIndexes) {
    assert.ok(!frame.messages[index].content.includes('recalledSeenReference')); assert.ok(!expansionCalls.has(frame.messages[index].toolCallId))
  }
  const modelContext = JSON.stringify(await debug('get_context')); for (const marker of ['RAW_ONLY_', 'USER_ONLY_DOCUMENT_RESULT']) assert.ok(!modelContext.includes(marker))
  assert.equal((await send({ type: 'history.recall', anchor: { ...anchor, sessionId: 'foreign-session' }, question: '越界' })).status, 'rejected')
  // Real second old page: selection from A cannot remain while viewing/loading/failed B (#19).
  await debug('set_fake_model', { script: [{ text: '第二页合成回应。', toolCalls: [], delayMs: 0 }] })
  await send({ type: 'message.send', text: '第二页独立经历。' }); await waitFor((s) => s.task?.status === 'completed' && s.messages.some((m) => m.text === '第二页独立经历。'), 'SECOND_PAGE_CHAT_FAILED')
  const secondId = (await snapshot()).scope.sessionId
  await debug('set_clock', { nowMs: Date.parse('2026-10-18T12:00:00+08:00') }); await waitFor((s) => s.session.dayKey === '2026-10-18', 'THIRD_PAGE_ROLLOVER_FAILED')
  await page.locator('.turn-back').click(); await page.locator('.old-page .msg-text', { hasText: '第二页独立经历。' }).waitFor()
  const selectFirst = async () => {
    await page.locator('.old-page .msg[data-recallable="true"] .msg-text').first().evaluate((span) => { const range = document.createRange(); range.selectNodeContents(span); const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range); span.dispatchEvent(new MouseEvent('mouseup', { bubbles: true })) })
    await page.locator('.old-foot .quote-preview').waitFor()
  }
  await selectFirst(); await page.locator('.page-turn button').first().click(); await page.locator(`.old-page [data-message-id="${quotedMessage.id}"]`).waitFor()
  assert.equal(await page.locator('.old-foot .quote-preview').count(), 0, 'PREVIOUS_PAGE_SELECTION_SURVIVED')
  await selectFirst()
  // Fault injection on this isolated test's user-read IPC only, using actual archived page A.
  const firstPage = await page.evaluate((id) => window.lca.readSession(id), sessionId)
  await instance.evaluate(({ ipcMain }, { firstPage, secondId }) => {
    globalThis.historyReadMode = 'loading'; ipcMain.removeHandler('lca:user-session')
    ipcMain.handle('lca:user-session', (_event, id) => {
      if (id === firstPage.sessionId) return firstPage
      if (id !== secondId || globalThis.historyReadMode === 'failed') throw new Error('SYNTHETIC_HISTORY_READ_FAILURE')
      return new Promise((resolve) => { globalThis.historyReadResolve = () => resolve({ sessionId: secondId, dayKey: '2026-10-17', messages: [], recallableMessageIds: [], truncated: false }) })
    })
  }, { firstPage, secondId })
  await page.locator('.page-turn button').last().click(); await page.locator('.old-page [role="status"]').waitFor()
  assert.equal(await page.locator('.old-foot .quote-preview').count(), 0, 'LOADING_PAGE_RETAINED_SELECTION')
  await instance.evaluate(() => globalThis.historyReadResolve()); await page.locator('.old-page .sheet-empty').waitFor()
  assert.equal(await page.locator('.old-foot .quote-preview').count(), 0, 'EMPTY_PAGE_RETAINED_SELECTION')
  await page.locator('.page-turn button').first().click(); await page.locator(`.old-page [data-message-id="${quotedMessage.id}"]`).waitFor(); await selectFirst()
  await instance.evaluate(() => { globalThis.historyReadMode = 'failed' }); await page.locator('.page-turn button').last().click(); await page.locator('.old-page [role="alert"]').waitFor()
  assert.equal(await page.locator('.old-foot .quote-preview').count(), 0, 'FAILED_PAGE_RETAINED_SELECTION')
  await stop(); await launch(); assert.deepEqual((await snapshot()).history.photos[0], photo)
  const archive = join(data, 'history.lca-save'); await instance.evaluate(({ dialog }, file) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: file }) }, archive)
  await send({ type: 'backup.export' }); await waitFor((s) => s.backup.status === 'exported', 'HISTORY_EXPORT_FAILED')
  const zip = await JSZip.loadAsync(await readFile(archive)); const manifest = JSON.parse(await zip.file('manifest.json').async('string'))
  const sha = createHash('sha256').update(image).digest('hex'); const saved = manifest.files.find((file) => file.path === 'artifacts/' + sha + '.png'); assert.ok(saved); assert.deepEqual(await zip.file(saved.path).async('nodebuffer'), image)
  await stop(); sceneId = randomUUID(); await setupScene(); await launch()
  assert.equal((await snapshot()).history.photos.length, 0)
  await instance.evaluate(({ dialog, app }, file) => { app.relaunch = () => {}; dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }) }, archive)
  await send({ type: 'backup.import' }); await waitFor((s) => s.backup.status === 'awaiting-confirmation', 'HISTORY_IMPORT_FAILED')
  const restoreId = (await snapshot()).backup.restoreId; await client.close(); client = undefined; const closed = instance.waitForEvent('close'); await send({ type: 'backup.restore', restoreId }); await closed; instance = undefined; await launch()
  assert.deepEqual((await snapshot()).history.photos.find((entry) => entry.id === photo.id), photo)
  const restored = Buffer.from(await page.evaluate(async (url) => [...new Uint8Array(await (await fetch(url)).arrayBuffer())], photo.imageUrl)); assert.deepEqual(restored, image)
  await debug('set_fake_model', { script: [{ text: '恢复后合成回忆仍能定位周五桥。', toolCalls: [], delayMs: 0 }] })
  assert.equal((await send({ type: 'history.recall', anchor, question: '恢复后还记得吗？' })).status, 'accepted'); await waitFor((s) => s.history.recall.status === 'ready' && s.messages.some((message) => message.text.includes('恢复后合成回忆')), 'RECALL_RESTORE_FAILED')
  console.log('History Electron: real scene PNG excludes overlay/clock/sign pixels; archive/restart/exact private restore, UI quote (settings panel and book page-turn/quote chip with saved photo outside the capture root), grounded model context, bounded recall tool, ineligible historical references, foreign-scope rejection and recall after empty-profile restore verified; fake model/clock.')
} finally { await stop() }
