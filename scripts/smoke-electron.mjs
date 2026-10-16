import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron } from 'playwright'
import electronPath from 'electron'
import { runtimeEnv } from './runtime-env.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const data = join(root, '.local-data', `smoke-${randomUUID()}`)
// Playwright enables a main inspector. Never load the user's credentials in this test.
const env = { ...runtimeEnv(root), LCA_DATA_DIR: data, LCA_PROVIDERS_FILE: join(data, 'absent-test-providers.json') }
let instance = await _electron.launch({ executablePath: electronPath, args: [root], env, timeout: 30_000 })
try {
  const page = await instance.firstWindow()
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
  assert.deepEqual(contract.methods, ['dispatch', 'getSnapshot', 'readEvidence', 'subscribe'])
  assert.equal(contract.requireType, 'undefined')
  assert.equal(contract.processType, 'undefined')
  await page.screenshot({ path: join(root, 'test-results', 'scaffold.png') })
  await instance.close()
  instance = await _electron.launch({ executablePath: electronPath, args: [root], env, timeout: 30_000 })
  const reopened = await instance.firstWindow()
  await reopened.locator('[data-mode="quiet"][data-pose="desk-writing"]').waitFor()
  const restored = await reopened.evaluate(() => window.lca.getSnapshot())
  assert.equal(restored.scope.sessionId, original.scope.sessionId)
  assert.notEqual(restored.epoch, original.epoch)
  const stale = await reopened.evaluate((epoch) => window.lca.dispatch({ protocolVersion: 1, epoch, requestId: crypto.randomUUID(), type: 'mode.set', mode: 'rest' }), original.epoch)
  assert.equal(stale.status, 'rejected')
  console.log('Electron smoke: book UI, isolation, IPC, unsubscribe, evidence restrictions and persisted restart verified.')
} finally {
  await instance.close()
}
