import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron } from 'playwright'
import electronPath from 'electron'
import { runtimeEnv } from './runtime-env.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const env = { ...runtimeEnv(root), LCA_DATA_DIR: join(root, '.local-data', `smoke-${randomUUID()}`) }
const instance = await _electron.launch({ executablePath: electronPath, args: [root], env, timeout: 30_000 })
try {
  const page = await instance.firstWindow()
  await page.locator('h1').waitFor()
  assert.match(await page.title(), /Love, College/)
  const settings = await instance.evaluate(({ BrowserWindow }) => {
    const preferences = BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences()
    return { sandbox: preferences.sandbox, contextIsolation: preferences.contextIsolation, nodeIntegration: preferences.nodeIntegration }
  })
  assert.deepEqual(settings, { sandbox: true, contextIsolation: true, nodeIntegration: false })
  await page.screenshot({ path: join(root, 'test-results', 'scaffold.png') })
  console.log('Electron smoke: window loaded; renderer isolation verified.')
} finally {
  await instance.close()
}
