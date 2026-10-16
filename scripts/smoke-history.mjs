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
import { runtimeEnv, initializeTestBook } from './runtime-env.mjs'
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..'); const data = join(root, '.local-data', 'history-smoke-' + randomUUID()); let sceneId = randomUUID()
const env = { ...runtimeEnv(root), LCA_DATA_DIR: data, LCA_PROVIDERS_FILE: join(data, 'absent.json'), LCA_CDP_PORT: '19547', LCA_MCP_PORT: '0' }
let instance; let page; let client
const snapshot = () => page.evaluate(() => window.lca.getSnapshot())
const send = (body) => page.evaluate(async (body) => { const s = await window.lca.getSnapshot(); return window.lca.dispatch({ ...body, protocolVersion: 1, epoch: s.epoch, requestId: crypto.randomUUID() }) }, body)
async function waitFor(test, error) { for (let index = 0; index < 160; index++) { if (test(await snapshot())) return; await new Promise((resolve) => setTimeout(resolve, 100)) }; throw new Error(error) }
async function debug(name, args = {}) { const result = await client.callTool({ name, arguments: args }); assert.ok(!result.isError); return JSON.parse(result.content[0].text) }
async function setupScene() {
  await mkdir(join(data, 'developer', sceneId), { recursive: true }); await writeFile(join(data, 'settings.json'), JSON.stringify({ version: 1, developer: true, booth: false, plugins: {}, sceneId }))
  await writeFile(join(data, 'developer', sceneId, 'clock.json'), JSON.stringify({ nowMs: Date.parse('2026-10-16T20:00:00+08:00'), frozen: true, rate: 1 }))
}
async function launch() {
  instance = await _electron.launch({ executablePath: electronPath, args: [root], env }); page = await instance.firstWindow(); await page.emulateMedia({ reducedMotion: 'reduce' }); await initializeTestBook(page)
  const config = JSON.parse(await readFile(join(data, 'developer', sceneId, 'debug-connection.json'), 'utf8')); client = new Client({ name: 'history-smoke', version: '1.0.0' })
  await client.connect(new StreamableHTTPClientTransport(new URL(config.url), { requestInit: { headers: { Authorization: 'Bearer ' + config.token } } }))
  await page.locator('[data-photo-scene] canvas, [data-photo-scene] img').first().waitFor()
}
async function stop() { await client?.close(); client = undefined; await instance?.close(); instance = undefined }
try {
  await setupScene(); await launch()
  await debug('set_fake_model', { script: [{ text: '合成经历：周五桥放在窗边。', toolCalls: [], delayMs: 0 }] })
  await send({ type: 'message.send', text: '我把纸桥放在窗边，取名叫周五桥。' }); await waitFor((s) => s.task?.status === 'completed', 'HISTORY_CHAT_FAILED')
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
  const photo = (await snapshot()).history.photos[0]; assert.equal(photo.sessionId, sessionId); assert.ok(photo.width > 100 && photo.height > 100)
  assert.equal(await page.evaluate(() => !!document.getElementById('lca-photo-isolation')), false)
  const image = Buffer.from(await page.evaluate(async (url) => [...new Uint8Array(await (await fetch(url)).arrayBuffer())], photo.imageUrl)); assert.equal(image.subarray(0, 8).toString('hex'), '89504e470d0a1a0a')
  assert.equal(await countCanaryPixels(image), 0, 'PHOTO_RETAINED_CLOCK_OR_SIGN_PIXELS')
  await mkdir(join(root, 'test-results'), { recursive: true }); await writeFile(join(root, 'test-results/history-photo.png'), image)
  await page.getByRole('button', { name: '关闭', exact: true }).click()
  await debug('set_clock', { nowMs: Date.parse('2026-10-17T12:00:00+08:00') }); await waitFor((s) => s.session.dayKey === '2026-10-17', 'HISTORY_ROLLOVER_FAILED')
  assert.deepEqual((await page.evaluate((id) => window.lca.readSession(id), sessionId)).photo, photo)
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
  console.log('History Electron: scene-only real PNG with overlay/clock/sign excluded, daily archive lookup, restart, exact private-save bytes and empty-profile restore verified; fake model and clock.')
} finally { await stop() }
