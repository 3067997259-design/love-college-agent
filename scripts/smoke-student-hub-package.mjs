import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron } from 'playwright'
import electronPath from 'electron'
import { runtimeEnv, initializeTestBook, electronLaunchTarget } from './runtime-env.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const data = join(root, '.local-data', `student-hub-package-${randomUUID()}`)
const packageConfig = join(root, 'plugin-packages', 'student-hub', 'mcp.json')
const env = { ...runtimeEnv(root), LCA_DATA_DIR: data, LCA_PROVIDERS_FILE: join(data, 'absent.json'), LCA_MCP_PORT: '0', LCA_CDP_PORT: '19576' }
let instance; let page
const snapshot = () => page.evaluate(() => window.lca.getSnapshot())
async function waitFor(test, message) { for (let i = 0; i < 120; i++) { if (await test()) return; await new Promise((done) => setTimeout(done, 100)) } throw new Error(message) }

try {
  await mkdir(data, { recursive: true })
  instance = await _electron.launch({ ...electronLaunchTarget(root, electronPath), env })
  page = await instance.firstWindow(); await initializeTestBook(page)
  await page.locator('.bookmarks').getByRole('button', { name: '插件', exact: true }).click()
  const center = page.getByRole('region', { name: '插件', exact: true }); await center.waitFor()
  await center.getByRole('button', { name: '+ 添加插件', exact: true }).click()
  await center.getByRole('menuitem', { name: '添加自定义 MCP 服务器', exact: true }).click()
  const dialog = center.getByRole('dialog', { name: '添加插件', exact: true })
  await dialog.getByLabel('添加自定义 MCP 服务器', { exact: true }).fill(packageConfig)
  await dialog.getByRole('button', { name: '安装', exact: true }).click()
  const row = center.locator('.plugin-row[data-plugin-id="student-hub"]'); await row.waitFor()
  assert.ok((await row.innerText()).includes('Student Hub'))
  assert.ok((await row.innerText()).includes('校园邮箱、日程与资料'))
  await waitFor(async () => (await snapshot()).mcp.servers.some((server) => server.id === 'student-hub'), 'PACKAGE_NOT_INSTALLED')
  const server = (await snapshot()).mcp.servers.find((item) => item.id === 'student-hub')
  assert.equal(server.status, 'disconnected'); assert.equal(server.privacy, 'always')
  assert.equal(await row.getByRole('switch').getAttribute('aria-checked'), 'false')
  console.log(JSON.stringify({ ok: true, probe: 'student-hub-package', imported: true, displayName: true, disabledByDefault: true, privacyAlways: true, noProcessStarted: true }))
} finally {
  await instance?.close().catch(() => {})
  if (resolve(data).startsWith(join(resolve(root), '.local-data', 'student-hub-package-'))) await rm(data, { recursive: true, force: true })
}
