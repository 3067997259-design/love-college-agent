import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, writeFile, stat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron } from 'playwright'
import electronPath from 'electron'
import { runtimeEnv, initializeTestBook, electronLaunchTarget, openSettings } from './runtime-env.mjs'
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..'); const data = join(root, '.local-data', 'settings-' + randomUUID())
const env = { ...runtimeEnv(root), LCA_DATA_DIR: data, LCA_PROVIDERS_FILE: join(data, 'absent.json'), LCA_MCP_PORT: '0', LCA_CDP_PORT: '19572' }; delete env.LCA_BOOTH
let instance; let page
const snapshot = () => page.evaluate(() => window.lca.getSnapshot())
async function waitFor(test, message) { for (let i = 0; i < 150; i++) { if (test(await snapshot())) return; await new Promise((done) => setTimeout(done, 100)) }; throw new Error(message) }
async function launch(booth = false) { instance = await _electron.launch({ ...electronLaunchTarget(root, electronPath), env: { ...env, ...(booth ? { LCA_BOOTH: '1' } : {}) } }); page = await instance.firstWindow(); await initializeTestBook(page); await openSettings(page) }
async function close() { await instance?.close(); instance = undefined }
async function group(name) { const element = page.locator('.settings-group').filter({ has: page.locator('summary', { hasText: name }) }).first(); if (!(await element.evaluate((node) => node.open))) await element.locator(':scope > summary').click(); return element }
try {
  await mkdir(data, { recursive: true }); await launch(); await page.screenshot({ path: join(root, 'test-results', 'settings-providers.png') }); assert.equal((await snapshot()).runtime.developer.mode, 'normal')
  const personalSessionId = (await snapshot()).scope.sessionId
  assert.equal(await page.locator('[data-settings="user"]').count(), 1)
  for (const name of ['冻结时钟', '快进一分钟', '刷新安全诊断', '暂存合成文本', '扫描合成邮件']) assert.equal(await page.getByRole('button', { name, exact: true }).count(), 0)
  assert.equal(await page.getByRole('combobox', { name: '合成邮件场景', exact: true }).count(), 0)
  assert.equal(await page.getByRole('button', { name: '导入模型配置', exact: true }).isVisible(), true)
  const invalid = join(data, 'invalid-providers.json'); await writeFile(invalid, JSON.stringify({ providers: { chat: { base_url: 'not-a-url', api_key: 'SYNTHETIC_SETTINGS_SECRET', model: 'synthetic' } } }))
  await instance.evaluate(({ dialog }, path) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] }) }, invalid)
  await page.getByRole('button', { name: '导入模型配置', exact: true }).click(); await waitFor((s) => s.modelSettings.status === 'failed', 'CONFIG_FAILURE_MISSING')
  const issue = page.locator('.settings-issue').filter({ hasText: '配置未能使用' }).first(); await issue.waitFor()
  assert.equal(await issue.locator('code').isVisible(), false); await issue.locator('summary').click(); assert.equal(await issue.locator('code').innerText(), 'configuration-failed')
  assert.ok(!JSON.stringify(await snapshot()).includes('SYNTHETIC_SETTINGS_SECRET')); assert.ok(!(await page.locator('[data-settings="user"]').innerText()).includes('SYNTHETIC_SETTINGS_SECRET'))
  await issue.locator('summary').click(); const campus = await group('邮箱与资料')
  assert.equal(await campus.getByRole('checkbox', { name: '文件隐私过滤 /privacy', exact: true }).isDisabled(), true)
  const book = await group('书本与角色'); const archive = join(data, 'settings.lca-save')
  await instance.evaluate(({ dialog }, path) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: path }) }, archive)
  await book.getByRole('button', { name: '导出私人存档', exact: true }).click(); await waitFor((s) => s.backup.status === 'exported', 'USER_EXPORT_FAILED'); assert.ok((await stat(archive)).size > 1000)
  // 本地插件列表已收进插件中心；设置只留快捷入口，不再复制第二套卡片。
  assert.equal(await page.getByRole('button', { name: '打开插件中心', exact: true }).isVisible(), true)
  await mkdir(join(root, 'test-results'), { recursive: true }); await page.screenshot({ path: join(root, 'test-results/settings-user.png') })
  await group('高级与开发'); await page.getByRole('checkbox', { name: '使用独立的假数据与假模型（重启生效）', exact: true }).click()
  await waitFor((s) => s.runtime.developer.restartRequired && s.runtime.developer.requestedEnabled, 'DEV_SWITCH_NOT_SAVED'); assert.equal((await snapshot()).runtime.developer.mode, 'normal'); assert.equal(await page.getByRole('checkbox', { name: '使用独立的假数据与假模型（重启生效）', exact: true }).isChecked(), true)
  await close(); await launch(); assert.equal((await snapshot()).runtime.developer.mode, 'developer'); assert.notEqual((await snapshot()).scope.sessionId, personalSessionId); assert.equal(await page.locator('[data-settings="user"]').count(), 0)
  assert.equal(await page.getByRole('button', { name: '冻结时钟', exact: true }).count(), 1); assert.equal(await page.getByRole('button', { name: '刷新安全诊断', exact: true }).count(), 1)
  await close(); await launch(true); assert.equal((await snapshot()).runtime.developer.mode, 'booth'); assert.equal(await page.locator('[data-settings="user"]').count(), 1)
  assert.equal(await page.getByRole('region', { name: '运行资源', exact: true }).isVisible(), true)
  await group('高级与开发'); assert.equal(await page.getByRole('checkbox', { name: '使用独立的假数据与假模型（重启生效）', exact: true }).isDisabled(), true)
  assert.equal(await page.getByRole('button', { name: '冻结时钟', exact: true }).count(), 0); assert.equal(await page.getByRole('button', { name: '刷新安全诊断', exact: true }).count(), 0)
  if ((await snapshot()).capabilities.some((capability) => capability.source === 'fake')) assert.equal(await page.locator('[data-synthetic-source]').isVisible(), true)
  console.log(JSON.stringify({ ok: true, probe: 'settings', nativeSQLite: true, userGroups: true, nativeConfigRefusal: true, privateExport: true, fixedDiagnosticDetails: true, noConfigValues: true, pluginCenterShortcut: true, separateDeveloperRestart: true, boothControls: true, noRealProviders: true }))
} finally { await close() }
