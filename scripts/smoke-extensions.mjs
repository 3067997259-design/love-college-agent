// P4: actual book controls -> main approvals -> pinned DSH / local pnpm. Synthetic loopback model only.
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile, unlink } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { _electron } from 'playwright'
import electronPath from 'electron'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { runtimeEnv, initializeTestBook } from './runtime-env.mjs'

const root = resolve(import.meta.dirname, '..'), id = randomUUID(), data = join(root, '.local-data', `p4-smoke-${id}`), scene = randomUUID()
const profile = join(data, 'developer', scene), dshProfile = join(profile, 'dsh-home', 'profiles', 'lca'), user = join(data, 'user')
const pictures = join(root, 'test-results', `p4-${id}`), bundle = join(data, 'fixture-bundle'), source = join(data, 'fixture-skill')
const checks = [], name = 'lca-p4-fixture'
let instance, page, client, center
const env = { ...runtimeEnv(root), LCA_DATA_DIR: data, LCA_PROVIDERS_FILE: join(data, 'absent.json'), LCA_CDP_PORT: '19593', LCA_MCP_PORT: '0',
  USERPROFILE: user, HOME: user, APPDATA: join(user, 'AppData', 'Roaming'), LOCALAPPDATA: join(user, 'AppData', 'Local') }
const snapshot = () => page.evaluate(() => window.lca.getSnapshot())
const send = (body) => page.evaluate(async (body) => { const s = await window.lca.getSnapshot(); return window.lca.dispatch({ protocolVersion: 1, epoch: s.epoch, requestId: crypto.randomUUID(), ...body }) }, body)
async function until(test, label) { for (let i = 0; i < 400; i++) { if (await test(await snapshot())) return; await new Promise((done) => setTimeout(done, 100)) }; throw new Error(label) }
async function debug(name, args = {}) { const result = await client.callTool({ name, arguments: args }); assert.ok(!result.isError); return JSON.parse(result.content[0].text) }
const record = (name) => { checks.push(name); console.log('P4_PASS', name) }
const row = () => center.locator(`[data-extension-id="${name}"]`)
const last = (s) => s.extensions.operations.at(-1)
async function allow(choice = '本次允许') { await center.locator('[data-kind="approval"]').getByRole('button', { name: choice, exact: true }).click() }
async function settle() { await until((s) => last(s)?.outcome !== 'pending' && s.extensions.status === 'ready', 'EXTENSION_NOT_SETTLED') }
async function restartRuntime() { await center.getByRole('button', { name: '重启扩展运行时', exact: true }).click(); await allow(); await settle(); assert.equal(last(await snapshot()).outcome, 'succeeded') }
async function tab(name) { await center.locator('.plugin-rail').getByRole('button', { name, exact: true }).click() }
async function launch() {
  instance = await _electron.launch({ executablePath: electronPath, args: [root], env, timeout: 30_000 })
  page = await instance.firstWindow(); await initializeTestBook(page)
  const config = JSON.parse(await readFile(join(profile, 'debug-connection.json'), 'utf8'))
  client = new Client({ name: 'p4-smoke', version: '1' })
  await client.connect(new StreamableHTTPClientTransport(new URL(config.url), { requestInit: { headers: { Authorization: `Bearer ${config.token}` } } }))
  await debug('set_clock', { frozen: true })
  await instance.evaluate(({ dialog }, paths) => {
    dialog.showOpenDialog = async (options) => ({ canceled: false, filePaths: [options.title.includes('技能') ? paths.source : options.title.includes('项目') ? paths.project : paths.bundle] })
    dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false })
  }, { source, bundle, project: join(data, 'other-project') })
  await page.locator('.bookmarks').getByRole('button', { name: '插件', exact: true }).click()
  center = page.getByRole('region', { name: '插件', exact: true }); await center.waitFor()
  await until((s) => s.extensions.status === 'ready', 'EXTENSIONS_UNAVAILABLE')
}
async function modelSkill(skill, marker) {
  await debug('set_fake_model', { script: [{ text: '', toolCalls: [{ id: 'skill', name: 'skill', arguments: JSON.stringify({ name: skill }) }], delayMs: 0 }, { text: marker, toolCalls: [], delayMs: 0 }] })
  assert.equal((await send({ type: 'message.send', text: `Synthetic skill check ${marker}` })).status, 'accepted')
  await until((s) => s.task?.status === 'completed' && s.messages.some((m) => m.text === marker), 'MODEL_SKILL_FAILED')
  return JSON.stringify(await debug('get_context'))
}
try {
  for (const dir of [data, profile, pictures, bundle, source, dshProfile, user, env.APPDATA, env.LOCALAPPDATA, join(user, 'Documents'), join(user, 'Desktop'), join(user, 'Downloads'), join(data, 'other-project'), join(user, '.agents', 'skills')]) await mkdir(dir, { recursive: true })
  await writeFile(join(data, 'settings.json'), JSON.stringify({ version: 1, developer: true, booth: false, plugins: {}, sceneId: scene }))
  await writeFile(join(dshProfile, '.npmrc'), 'registry=http://127.0.0.1:9/\nfetch-retries=0\nmanage-package-manager-versions=false\n')
  await writeFile(join(bundle, 'package.json'), JSON.stringify({ name, version: '1.0.0', type: 'module', main: './index.js', dsh: { bundle: { patch: './cordis.patch.yml' } } }))
  await writeFile(join(bundle, 'cordis.patch.yml'), JSON.stringify([{ insert: [{ id: `${name}:skill`, name }] }]))
  await writeFile(join(bundle, 'index.js'), `export const inject=['skills']; export function apply(ctx){ctx.skills.register({name:'p4-bundle',description:'P4 bundle skill',source:'p4-fixture',content:'P4_BUNDLE_BODY'})}`)
  const skillText = (marker) => `---\nname: p4-skill\ndescription: P4 synthetic Markdown skill\n---\n${marker}\n`
  await writeFile(join(source, 'SKILL.md'), skillText('P4_PROFILE_BODY'))
  await writeFile(join(user, '.agents', 'skills', 'ambient.md'), '---\nname: forbidden-ambient\ndescription: Must not load\n---\nAMBIENT_BODY')
  await launch()
  await center.locator('.extension-core > summary').click()
  const protectedRow = center.locator('[data-extension-id="@lca/dsh-bridge"]'); await protectedRow.locator('summary').first().click()
  assert.equal(await protectedRow.getByRole('button').count(), 0)
  await center.locator('.extension-core > summary').click()
  record('protected-core-has-no-mutation-controls')

  await center.getByRole('button', { name: '添加 DSH 扩展', exact: true }).click()
  await center.getByRole('button', { name: '申请安装', exact: true }).click()
  await center.locator('[data-kind="approval"]').waitFor()
  await center.getByRole('button', { name: '取消操作', exact: true }).click(); await settle()
  assert.equal(last(await snapshot()).outcome, 'cancelled'); assert.equal((await snapshot()).extensions.items.some((item) => item.id === name), false)
  record('cancel-approval-without-installing')
  await center.getByRole('button', { name: '申请安装', exact: true }).click(); await allow(); await settle()
  assert.equal(last(await snapshot()).outcome, 'succeeded'); assert.equal((await snapshot()).extensions.items.find((item) => item.id === name).enabledIntent, false)
  await row().locator('summary').first().click()
  await row().getByRole('button', { name: '启用', exact: true }).click(); await allow('拒绝'); await settle()
  assert.equal(last(await snapshot()).outcome, 'cancelled')
  await row().getByRole('button', { name: '启用', exact: true }).click(); await allow(); await settle()
  assert.ok((await row().innerText()).includes('待重启')); assert.equal((await snapshot()).extensions.items.find((item) => item.id === name).applied, 'disabled')
  await restartRuntime(); assert.equal((await snapshot()).extensions.items.find((item) => item.id === name).applied, 'ready')
  assert.ok((await modelSkill('p4-bundle', 'P4_BUNDLE_DONE')).includes('P4_BUNDLE_BODY'))
  record('install-enable-restart-loads-real-bundle-skill')
  await center.screenshot({ path: join(pictures, 'extensions.png') })

  await tab('技能'); await until((s) => s.skills.status === 'ready', 'SKILLS_UNAVAILABLE')
  await center.getByRole('button', { name: '导入到此存档', exact: true }).click(); await allow()
  await until((s) => s.skills.status === 'ready' && s.skills.operation?.outcome === 'succeeded', 'SKILL_IMPORT_FAILED')
  const project = (await snapshot()).work.current.path
  for (const dir of [join(project, '.dsh', 'skills'), join(project, '.agents', 'skills'), join(project, '.dsh', 'skills', 'missing-skill')]) await mkdir(dir, { recursive: true })
  await writeFile(join(source, 'SKILL.md'), skillText('P4_PROJECT_BODY'))
  await center.getByRole('button', { name: '导入到当前项目', exact: true }).click(); await allow()
  await until((s) => s.skills.status === 'ready' && s.skills.items.some((row) => row.source === 'project-dsh'), 'PROJECT_SKILL_FAILED')
  await writeFile(join(project, '.agents', 'skills', 'alternate.md'), skillText('P4_SHADOWED_BODY'))
  await writeFile(join(project, '.dsh', 'skills', 'broken.md'), '---\nname: [broken\n---\n')
  await center.getByRole('button', { name: '刷新技能', exact: true }).click(); await until((s) => s.skills.items.filter((row) => row.status === 'shadowed').length === 2, 'SKILL_PRECEDENCE_FAILED')
  let skills = (await snapshot()).skills.items
  assert.ok(skills.some((row) => row.status === 'invalid')); assert.ok(skills.some((row) => row.status === 'missing'))
  assert.ok(!skills.some((row) => row.name === 'forbidden-ambient'))
  const context = await modelSkill('p4-skill', 'P4_PROJECT_DONE'); assert.ok(context.includes('P4_PROJECT_BODY')); assert.ok(!context.includes('P4_PROFILE_BODY'))
  record('markdown-import-scope-priority-invalid-missing-and-no-ambient-home')
  await center.screenshot({ path: join(pictures, 'skills.png') })
  const removable = center.locator('[data-skill-status="available"]').filter({ hasText: 'p4-skill' })
  await removable.locator('summary').first().click(); await removable.getByRole('button', { name: '移除技能', exact: true }).click(); await allow()
  await until((s) => s.skills.operation?.action === 'remove' && s.skills.operation.outcome === 'succeeded' && s.skills.status === 'ready', 'SKILL_REMOVE_FAILED')
  assert.ok((await modelSkill('p4-skill', 'P4_FALLBACK_DONE')).includes('P4_SHADOWED_BODY'))
  await unlink(join(project, '.agents', 'skills', 'alternate.md'))
  const deleted = await modelSkill('p4-skill', 'P4_DELETE_DONE')
  assert.ok(deleted.includes('P4_PROFILE_BODY')); assert.ok(!deleted.includes('P4_SHADOWED_BODY')); assert.ok(!deleted.includes('P4_PROJECT_BODY'))
  await writeFile(join(profile, 'dsh-home', 'skills', 'p4-skill', 'SKILL.md'), skillText('P4_EDITED_BODY'))
  const edited = await modelSkill('p4-skill', 'P4_EDIT_DONE')
  assert.ok(edited.includes('P4_EDITED_BODY')); assert.ok(!edited.includes('P4_PROFILE_BODY'))
  await center.getByRole('button', { name: '刷新技能', exact: true }).click(); await until((s) => s.skills.status === 'ready' && s.skills.items.some((row) => row.source === 'profile' && !row.removable), 'EDIT_NOT_INVALIDATED')
  record('remove-falls-back-delete-and-edit-refresh-model-content')
  assert.equal((await send({ type: 'project.pick' })).status, 'accepted')
  await until((s) => s.work.current.path === join(data, 'other-project') && s.skills.status === 'ready', 'PROJECT_SWITCH_NOT_REFRESHED')
  assert.ok((await snapshot()).skills.items.every((row) => !row.source.startsWith('project-')))
  record('cross-project-catalog-does-not-retain-old-project')

  await tab('插件'); await until((s) => s.extensions.status === 'ready', 'EXTENSIONS_REFRESH_FAILED')
  const mcp = center.locator('[data-plugin-id="synthetic-public"]'); await mcp.getByRole('switch').click()
  await mcp.getByRole('button', { name: '确认此配置并连接', exact: true }).click()
  await until((s) => s.mcp.servers.find((row) => row.id === 'synthetic-public')?.status === 'ready', 'MCP_NOT_CONNECTED')
  const publicName = 'mcp_synthetic-public_' + createHash('sha256').update('synthetic_public').digest('hex').slice(0, 12)
  await debug('set_fake_model', { script: [{ text: '', toolCalls: [{ id: 'mcp', name: publicName, arguments: '{}' }], delayMs: 0 }, { text: 'P4_MCP_DONE', toolCalls: [], delayMs: 0 }] })
  await send({ type: 'message.send', text: 'Synthetic MCP ping' }); await until((s) => s.task?.status === 'completed' && s.messages.some((m) => m.text === 'P4_MCP_DONE'), 'MCP_MODEL_FAILED')
  assert.ok(JSON.stringify(await debug('get_context')).includes('SYNTHETIC_MCP_PUBLIC'))
  record('mcp-page-connects-single-lca-owner-and-dsh-executes-tool')
  if (!await row().locator('details').first().evaluate((element) => element.open)) await row().locator('summary').first().click()
  assert.equal(await row().getByRole('button', { name: '移除', exact: true }).isEnabled(), false)
  await row().getByRole('button', { name: '停用', exact: true }).click(); await allow(); await settle(); await restartRuntime()
  await row().getByRole('button', { name: '移除', exact: true }).click(); await allow(); await settle()
  assert.ok(!(await snapshot()).extensions.items.some((item) => item.id === name)); record('disable-restart-remove-through-page')

  // Exercise the distinct build approval in this same page; refusal must not leave an installed bundle.
  const packagePath = join(bundle, 'package.json'), manifest = JSON.parse(await readFile(packagePath, 'utf8'))
  await writeFile(packagePath, JSON.stringify({ ...manifest, scripts: { postinstall: '.\\build.cmd' } }))
  await writeFile(join(bundle, 'build.cmd'), '@echo off\r\necho built>p4-built.txt\r\n')
  await center.getByRole('button', { name: '添加 DSH 扩展', exact: true }).click()
  await until((s) => s.extensions.proposal?.requiresBuildScripts, 'BUILD_PROPOSAL_MISSING')
  await center.getByRole('button', { name: '申请安装', exact: true }).click(); await allow()
  await until((s) => last(s)?.phase === 'awaiting-approval' && last(s)?.pendingBuilds?.length, 'BUILD_APPROVAL_MISSING')
  await center.locator('[data-kind="approval"]').waitFor()
  await center.screenshot({ path: join(pictures, 'build-approval.png') })
  await allow('拒绝'); await settle(); assert.equal(last(await snapshot()).outcome, 'cancelled')
  assert.ok(!(await snapshot()).extensions.items.some((item) => item.id === name && item.installation === 'installed'))
  record('separate-build-approval-visible-and-refusable')
  await writeFile(packagePath, JSON.stringify(manifest)); await unlink(join(bundle, 'build.cmd'))

  // Test-only transport fault, on the real spawned host. Drop one durably settled receipt.
  await instance.evaluate(() => {
    const cp = process.getBuiltinModule('child_process'), { syncBuiltinESMExports } = process.getBuiltinModule('module')
    const original = cp.spawn
    cp.spawn = (...args) => {
      const child = original(...args), emit = child.emit.bind(child)
      child.emit = (event, ...values) => {
        const message = values[0]
        if (event === 'message' && globalThis.p4DropReceipt && message?.t === 'extensions' && message.value?.operation?.outcome === 'succeeded') {
          globalThis.p4DropReceipt = false; child.disconnect(); return true
        }
        return emit(event, ...values)
      }
      return child
    }
    syncBuiltinESMExports()
  })
  await restartRuntime()
  await center.getByRole('button', { name: '添加 DSH 扩展', exact: true }).click()
  await until((s) => s.extensions.proposal && !s.extensions.proposal.requiresBuildScripts, 'CLEAN_PROPOSAL_MISSING')
  await instance.evaluate(() => { globalThis.p4DropReceipt = true })
  await center.getByRole('button', { name: '申请安装', exact: true }).click(); await allow()
  await until((s) => last(s)?.outcome === 'unknown', 'UNKNOWN_RECEIPT_MISSING')
  await center.getByText('结果未知，请核对后再操作', { exact: true }).waitFor()
  assert.equal(await center.getByRole('button', { name: '添加 DSH 扩展', exact: true }).isEnabled(), false)
  const opId = last(await snapshot()).id, opCount = (await snapshot()).extensions.operations.length
  await center.screenshot({ path: join(pictures, 'unknown.png') })
  await center.getByRole('button', { name: '核对这次操作', exact: true }).click(); await settle()
  assert.equal(last(await snapshot()).id, opId); assert.equal(last(await snapshot()).outcome, 'succeeded'); assert.equal((await snapshot()).extensions.operations.length, opCount)
  if (!await row().locator('details').first().evaluate((element) => element.open)) await row().locator('summary').first().click()
  await row().getByRole('button', { name: '移除', exact: true }).click(); await allow(); await settle()
  record('lost-receipt-unknown-ui-blocks-retry-and-reconciles-same-id')
  await client.close(); client = undefined; await instance.close(); instance = undefined
  await launch(); await tab('技能'); await until((s) => s.skills.status === 'ready', 'COLD_SKILLS_UNAVAILABLE')
  assert.ok((await snapshot()).skills.items.some((row) => row.name === 'p4-skill' && row.source === 'profile'))
  assert.ok((await snapshot()).mcp.servers.every((row) => row.status === 'disconnected'))
  assert.ok(!(await snapshot()).extensions.items.some((item) => item.id === name)); record('cold-restart-preserves-skill-and-removal-no-mcp-reconnect')
  const publicState = JSON.stringify(await snapshot()); assert.ok(!publicState.includes('P4_EDITED_BODY')); assert.ok(!publicState.includes('skill-candidates')); assert.ok(!publicState.includes('Bearer '))
  // Narrow width and keyboard access remain usable without changing character art.
  await instance.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((window) => !window.isDestroyed()).setSize(1100, 760))
  await center.screenshot({ path: join(pictures, 'skills-narrow.png') })
  assert.ok(await center.evaluate((element) => element.scrollWidth <= element.clientWidth + 1))
  record('safe-projection-and-narrow-page')
  await writeFile(join(pictures, 'evidence.json'), JSON.stringify({ ok: true, checks, data, screenshots: pictures, syntheticOnly: true }, null, 2))
  console.log(JSON.stringify({ ok: true, checks: checks.length, evidence: join(pictures, 'evidence.json') }))
} catch (error) {
  if (page && !page.isClosed()) { await writeFile(join(pictures, 'failure.json'), JSON.stringify({ error: String(error), snapshot: await snapshot() }, null, 2)); await page.screenshot({ path: join(pictures, 'failure.png') }) }
  throw error
} finally { await client?.close(); await instance?.close() }
