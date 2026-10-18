import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron } from 'playwright'
import electronPath from 'electron'
import { runtimeEnv, initializeTestBook, electronLaunchTarget } from './runtime-env.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const data = join(root, '.local-data', `plugins-smoke-${randomUUID()}`)
const source = join(data, 'fixture-plugin')
const mcpFile = join(data, 'fixture-mcp.json')
const env = { ...runtimeEnv(root), LCA_DATA_DIR: data, LCA_PROVIDERS_FILE: join(data, 'absent.json'), LCA_MCP_PORT: '0', LCA_CDP_PORT: '19573' }
let instance; let page

async function waitFor(test, message) {
  for (let i = 0; i < 100; i++) {
    if (await test()) return
    await new Promise((done) => setTimeout(done, 100))
  }
  throw new Error(message)
}

try {
  await mkdir(source, { recursive: true })
  await writeFile(join(source, 'manifest.json'), JSON.stringify({
    apiVersion: 1, id: 'smoke-plugin', version: '1.0.0', name: 'Smoke Plugin', description: '本地插件验收',
    entry: 'index.cjs', privacy: 'none', permissions: ['local-code'],
    tools: [{ name: 'smoke_skill', description: 'Synthetic skill', templateId: 'smoke.skill', parameters: { type: 'object', properties: {}, additionalProperties: false } }],
  }))
  await writeFile(join(source, 'index.cjs'), 'module.exports={tools:{smoke_skill:async()=>({ok:true,raw:{},visible:{ok:true}})}}')
  await writeFile(mcpFile, JSON.stringify({ mcpServers: { 'local-mcp': { type: 'stdio', command: 'node', args: ['-e', ''], allowTools: ['ping'], privacy: 'none' } } }))

  instance = await _electron.launch({ ...electronLaunchTarget(root, electronPath), env })
  page = await instance.firstWindow(); await initializeTestBook(page)
  await page.locator('[data-mode][data-pose]').waitFor()

  await page.locator('.bookmarks').getByRole('button', { name: '插件', exact: true }).click()
  const center = page.getByRole('region', { name: '插件', exact: true })
  await center.waitFor()
  await center.getByRole('heading', { name: '插件', exact: true }).waitFor()

  await center.getByRole('button', { name: '+ 添加插件', exact: true }).click()
  await center.getByRole('menuitem', { name: '安装本地插件', exact: true }).click()
  const localDialog = center.getByRole('dialog', { name: '添加插件', exact: true })
  await localDialog.screenshot({ path: join(root, 'test-results', 'plugins-add.png') })
  await localDialog.getByLabel('安装本地插件', { exact: true }).fill(source)
  await localDialog.getByRole('button', { name: '安装', exact: true }).click()
  await center.locator('.plugin-row[data-plugin-id="smoke-plugin"]').waitFor()
  assert.ok((await center.locator('.plugin-row[data-plugin-id="smoke-plugin"]').innerText()).includes('本地插件验收'))

  const localRow = center.locator('.plugin-row[data-plugin-id="smoke-plugin"]')
  await localRow.getByRole('switch').click()
  await localRow.getByRole('alertdialog', { name: '确认并启用', exact: true }).waitFor()
  await localRow.getByRole('alertdialog', { name: '确认并启用', exact: true }).getByRole('button', { name: '确认并启用', exact: true }).click()
  await waitFor(async () => (await localRow.getByRole('switch').getAttribute('aria-checked')) === 'true', 'PLUGIN_NOT_ENABLED')
  await mkdir(join(root, 'test-results'), { recursive: true })
  await center.screenshot({ path: join(root, 'test-results', 'plugins-center.png') })

  await center.locator('.plugin-rail').getByRole('button', { name: '技能', exact: true }).click()
  await center.locator('.plugin-skills').getByText('smoke_skill', { exact: true }).waitFor()
  await center.screenshot({ path: join(root, 'test-results', 'plugins-skills.png') })

  await center.locator('.plugin-rail').getByRole('button', { name: '插件', exact: true }).click()
  await center.getByRole('button', { name: '+ 添加插件', exact: true }).click()
  await center.getByRole('menuitem', { name: '添加自定义 MCP 服务器', exact: true }).click()
  const mcpDialog = center.getByRole('dialog', { name: '添加插件', exact: true })
  await mcpDialog.getByLabel('添加自定义 MCP 服务器', { exact: true }).fill(mcpFile)
  await mcpDialog.getByRole('button', { name: '安装', exact: true }).click()
  const mcpRow = center.locator('.plugin-row[data-plugin-id="local-mcp"]')
  await mcpRow.waitFor()
  await mcpRow.getByRole('switch').click()
  const mcpConnectDialog = mcpRow.getByRole('alertdialog', { name: 'MCP 连接确认', exact: true })
  await mcpConnectDialog.waitFor()
  await mcpConnectDialog.getByRole('button', { name: '取消', exact: true }).click()
  await center.screenshot({ path: join(root, 'test-results', 'plugins-mcp.png') })

  // 设置里的快捷入口：关闭设置，切回第 6 书签；不是复制第二套插件页面。
  await page.locator('.bookmarks').getByRole('button', { name: '对话', exact: true }).click()
  await page.getByRole('button', { name: '工具与设置', exact: true }).click()
  await page.getByRole('button', { name: '打开插件中心', exact: true }).click()
  await center.waitFor()
  assert.equal(await page.getByRole('region', { name: '工具与设置', exact: true }).count(), 0)

  await page.locator('.bookmarks').getByRole('button', { name: '对话', exact: true }).click()
  await page.locator('.composer-plugin').click()
  await center.waitFor()

  console.log(JSON.stringify({ ok: true, probe: 'plugins', localInstall: true, codeApproval: true, skillsSeparate: true, mcpPathImport: true, mcpApproval: true, settingsShortcut: true, composerEntry: true, syntheticOnly: true }))
} finally {
  await instance?.close().catch(() => {})
  if (resolve(data).startsWith(join(resolve(root), '.local-data', 'plugins-smoke-'))) await rm(data, { recursive: true, force: true })
}
