import assert from 'node:assert/strict'
import { copyFile, mkdir, stat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron } from 'playwright'
import electronPath from 'electron'
import { runtimeEnv, electronLaunchTarget } from './runtime-env.mjs'

/**
 * Install/enable the local Student Hub candidate plugin into an existing profile.
 * Usage: node scripts/install-student-hub-candidates.mjs "D:\lca-live-test\data-live-2"
 * This never starts a visible window: LCA_TEST_SILENT=1 makes the book transparent/inactive.
 */
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const profile = resolve(process.argv[2] ?? process.env.LCA_INSTALL_PROFILE ?? '')
assert.ok(profile, 'Provide the target data directory as the first argument.')
assert.ok((await stat(profile)).isDirectory(), 'Target data directory does not exist.')
const pluginSource = join(root, 'plugin-packages', 'student-hub-candidates')
const settingsPath = join(profile, 'settings.json')
await mkdir(join(profile, 'backups'), { recursive: true })
const backupPath = join(profile, 'backups', `settings-before-student-hub-${Date.now()}.json`)
await copyFile(settingsPath, backupPath).catch(() => {})
const env = {
  ...runtimeEnv(root),
  LCA_DATA_DIR: profile,
  LCA_PROVIDERS_FILE: join(profile, 'absent-install-providers.json'),
  LCA_MCP_PORT: '0',
  LCA_CDP_PORT: '0',
  LCA_TEST_SILENT: '1',
}
let instance
try {
  instance = await _electron.launch({ ...electronLaunchTarget(root, electronPath), env, timeout: 30_000 })
  const page = await instance.firstWindow()
  await page.waitForFunction(() => !!window.lca, null, { timeout: 20_000 })
  const before = await page.evaluate(() => window.lca.getSnapshot())
  assert.equal(before.onboarding?.status, 'completed', 'Target profile has not completed onboarding.')
  await page.locator('[data-mode][data-pose]').waitFor()
  await page.locator('.bookmarks').getByRole('button', { name: '插件', exact: true }).click()
  const center = page.getByRole('region', { name: '插件', exact: true })
  await center.getByRole('heading', { name: '插件', exact: true }).waitFor()
  const row = center.locator('.plugin-row[data-plugin-id="student-hub-candidates"]')
  if (!(await row.count())) {
    await center.getByRole('button', { name: '+ 添加插件', exact: true }).click()
    await center.getByRole('menuitem', { name: '安装本地插件', exact: true }).click()
    const dialog = center.getByRole('dialog', { name: '添加插件', exact: true })
    await dialog.getByLabel('安装本地插件', { exact: true }).fill(pluginSource)
    await dialog.getByRole('button', { name: '安装', exact: true }).click()
    await row.waitFor()
  }
  if ((await row.getByRole('switch').getAttribute('aria-checked')) !== 'true') {
    await row.getByRole('switch').click()
    const approval = row.getByRole('alertdialog', { name: '确认并启用', exact: true })
    if (await approval.count()) await approval.getByRole('button', { name: '确认并启用', exact: true }).click()
  }
  for (let i = 0; i < 100; i++) {
    if ((await row.getByRole('switch').getAttribute('aria-checked')) === 'true') break
    await new Promise((done) => setTimeout(done, 100))
  }
  assert.equal(await row.getByRole('switch').getAttribute('aria-checked'), 'true')
  // Activation is asynchronous (the local Student Hub reader is a short-lived child process).
  await new Promise((done) => setTimeout(done, 2500))
  const after = await page.evaluate(() => window.lca.getSnapshot())
  console.log(JSON.stringify({
    ok: true,
    profile,
    plugin: 'student-hub-candidates',
    installed: true,
    enabled: true,
    candidateCountBefore: before.candidates.length,
    candidateCountAfter: after.candidates.length,
    settingsBackup: backupPath,
    silent: true,
  }))
} finally {
  await instance?.close().catch(() => {})
}
