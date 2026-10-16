import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron } from 'playwright'
import electronPath from 'electron'
import { runtimeEnv, initializeTestBook } from './runtime-env.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const data = join(root, '.local-data', `smoke-${randomUUID()}`)
// Playwright enables a main inspector. Never load the user's credentials in this test.
const env = { ...runtimeEnv(root), LCA_DATA_DIR: data, LCA_PROVIDERS_FILE: join(data, 'absent-test-providers.json') }
async function verifyFonts(page) {
  const errors = []
  const onConsole = (message) => { if (message.type() === 'error') errors.push(message.text()) }
  page.on('console', onConsole)
  // Reload with listeners installed: launch may have already begun loading fonts before firstWindow resolves.
  await page.addInitScript(() => {
    window.__lcaCspViolations = []
    document.addEventListener('securitypolicyviolation', (event) => { window.__lcaCspViolations.push({ directive: event.effectiveDirective, kind: event.blockedURI.split(':')[0], line: event.lineNumber, column: event.columnNumber }) })
  })
  await page.reload()
  await page.locator('[data-mode][data-pose][data-location]').waitFor()
  const fonts = await page.evaluate(async () => {
    await document.fonts.ready
    // file:// fonts need not appear in Resource Timing. Inspect emitted CSS sources and actual FontFaceSet instead.
    const sources = [...document.styleSheets].flatMap((sheet) => [...sheet.cssRules].filter((rule) => rule instanceof CSSFontFaceRule)
      .flatMap((rule) => [...rule.style.getPropertyValue('src').matchAll(/url\(["']?([^"')]+)["']?\)/g)].map((match) => new URL(match[1], sheet.href ?? location.href))))
    return { violations: window.__lcaCspViolations, failed: [...document.fonts].filter((face) => face.status === 'error').length,
      loaded: [...document.fonts].filter((face) => face.status === 'loaded').length, sources: sources.length,
      local: sources.every((url) => url.protocol === location.protocol && url.origin === location.origin) }
  })
  page.off('console', onConsole)
  assert.equal(fonts.violations.length, 0, 'Renderer must not violate CSP while loading fonts: ' + JSON.stringify(fonts.violations))
  assert.equal(errors.length, 0, 'Renderer console must not report errors during font loading')
  assert.equal(fonts.failed, 0, 'FontFaceSet must not contain failed fonts')
  assert.ok(fonts.loaded > 0 && fonts.sources > 0 && fonts.local, 'Fonts must load successfully and CSS must reference local files: ' + JSON.stringify(fonts))
}
let instance = await _electron.launch({ executablePath: electronPath, args: [root], env, timeout: 30_000 })
try {
  const page = await instance.firstWindow(); await initializeTestBook(page)
  await verifyFonts(page)
  await page.locator('h1').waitFor()
  assert.match(await page.title(), /Love, College/)
  const settings = await instance.evaluate(({ BrowserWindow }) => {
    const preferences = BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences()
    return { sandbox: preferences.sandbox, contextIsolation: preferences.contextIsolation, nodeIntegration: preferences.nodeIntegration }
  })
  assert.deepEqual(settings, { sandbox: true, contextIsolation: true, nodeIntegration: false })
  await page.locator('[data-mode][data-pose][data-location]').waitFor()
  await page.getByRole('textbox').fill('synthetic unsent draft')
  await page.getByRole('button', { name: '发送', exact: true }).click()
  await page.getByRole('alert').waitFor()
  assert.equal(await page.getByRole('textbox').inputValue(), 'synthetic unsent draft')
  assert.equal((await page.evaluate(() => window.lca.getSnapshot())).messages.length, 0)
  const original = await page.evaluate(() => window.lca.getSnapshot())
  await page.evaluate(async () => {
    const snapshot = await window.lca.getSnapshot()
    await window.lca.dispatch({ protocolVersion: 1, epoch: snapshot.epoch, requestId: crypto.randomUUID(), type: 'mode.set', mode: 'quiet' })
  })
  await page.locator('[data-mode="quiet"][data-pose="desk-writing"]').waitFor()
  const contract = await page.evaluate(async () => {
    const snapshot = await window.lca.getSnapshot()
    let count = 0
    const firstId = crypto.randomUUID()
    const secondId = crypto.randomUUID()
    const off = window.lca.subscribe((event) => { if ([firstId, secondId].includes(event.requestId)) count++ })
    const first = await window.lca.dispatch({ protocolVersion: 1, epoch: snapshot.epoch, requestId: firstId, type: 'mode.set', mode: 'rest' })
    off()
    await window.lca.dispatch({ protocolVersion: 1, epoch: snapshot.epoch, requestId: secondId, type: 'mode.set', mode: 'quiet' })
    const unknown = await window.lca.dispatch({ protocolVersion: 1, epoch: snapshot.epoch, requestId: crypto.randomUUID(), type: 'unknown' })
    const evidenceRejected = await window.lca.readEvidence('../secrets/providers.json').then(() => false, () => true)
    return { accepted: first.status, eventCount: count, unknown: unknown.status, evidenceRejected,
      methods: Object.keys(window.lca).sort(), requireType: typeof window.require, processType: typeof window.process }
  })
  assert.equal(contract.accepted, 'accepted')
  assert.equal(contract.eventCount, 1)
  assert.equal(contract.unknown, 'rejected')
  assert.equal(contract.evidenceRejected, true)
  assert.deepEqual(contract.methods, ['dispatch', 'getSnapshot', 'importFiles', 'readDiagnostics', 'readDiary', 'readEvidence', 'readSession', 'subscribe'])
  assert.equal(contract.requireType, 'undefined')
  assert.equal(contract.processType, 'undefined')
  await page.screenshot({ path: join(root, 'test-results', 'scaffold.png') })
  await instance.close()
  instance = await _electron.launch({ executablePath: electronPath, args: [root], env, timeout: 30_000 })
  const reopened = await instance.firstWindow(); await initializeTestBook(reopened)
  await verifyFonts(reopened)
  await reopened.locator('[data-mode="quiet"][data-pose="desk-writing"]').waitFor()
  const restored = await reopened.evaluate(() => window.lca.getSnapshot())
  assert.equal(restored.scope.sessionId, original.scope.sessionId)
  assert.notEqual(restored.epoch, original.epoch)
  const stale = await reopened.evaluate((epoch) => window.lca.dispatch({ protocolVersion: 1, epoch, requestId: crypto.randomUUID(), type: 'mode.set', mode: 'rest' }), original.epoch)
  assert.equal(stale.status, 'rejected')
  console.log('Electron smoke: local font assets loaded, no CSP violations or renderer console errors on initial/restarted book, isolation, IPC, unsubscribe, evidence restrictions and persisted restart verified.')
} finally {
  await instance.close()
}
