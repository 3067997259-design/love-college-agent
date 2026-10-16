import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron } from 'playwright'
import electronPath from 'electron'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { runtimeEnv, initializeTestBook, electronLaunchTarget } from './runtime-env.mjs'
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..'); const data = join(root, '.local-data', 'shadow-smoke-' + randomUUID()); const sceneId = randomUUID(); const profile = join(data, 'developer', sceneId)
const env = { ...runtimeEnv(root), LCA_DATA_DIR: data, LCA_PROVIDERS_FILE: join(data, 'absent.json'), LCA_CDP_PORT: '19550', LCA_MCP_PORT: '0' }
let instance; let page; let client
function git(args) { const result = spawnSync('git', ['-c', 'core.longpaths=true', ...args], { windowsHide: true }); assert.equal(result.status, 0, 'SYNTHETIC_GIT_FAILED'); return result.stdout.toString().trim() }
const snapshot = () => page.evaluate(() => window.lca.getSnapshot())
const send = (body) => page.evaluate(async (body) => { const s = await window.lca.getSnapshot(); return window.lca.dispatch({ protocolVersion: 1, epoch: s.epoch, requestId: crypto.randomUUID(), ...body }) }, body)
async function waitFor(test, message) { for (let i = 0; i < 100; i++) { if (test(await snapshot())) return; await new Promise((done) => setTimeout(done, 100)) }; throw new Error(message) }
const debug = async (name, args = {}) => { const result = await client.callTool({ name, arguments: args }); assert.ok(!result.isError); return JSON.parse(result.content[0].text) }
async function launch() {
  instance = await _electron.launch({ ...electronLaunchTarget(root, electronPath), env }); page = await instance.firstWindow(); await initializeTestBook(page)
  const config = JSON.parse(await readFile(join(profile, 'debug-connection.json'), 'utf8')); client = new Client({ name: 'shadow-smoke', version: '1.0.0' })
  await client.connect(new StreamableHTTPClientTransport(new URL(config.url), { requestInit: { headers: { Authorization: 'Bearer ' + config.token } } })); await debug('set_clock', { frozen: true })
}
async function close() { await client?.close(); client = undefined; await instance?.close(); instance = undefined }
async function write(text) { await debug('set_fake_model', { script: [{ text: '', toolCalls: [{ id: 'write', name: 'desk_write', arguments: JSON.stringify({ path: 'project.md', text }) }], delayMs: 0 }, { text: 'synthetic write done', toolCalls: [], delayMs: 0 }] }); await send({ type: 'message.send', text: 'Write the synthetic project.md version.' }); await waitFor((s) => s.task?.status === 'completed', 'WRITE_NOT_DONE') }
try {
  await mkdir(data, { recursive: true }); await writeFile(join(data, 'settings.json'), JSON.stringify({ version: 1, developer: true, booth: false, plugins: {}, sceneId }))
  await launch(); await send({ type: 'mode.set', mode: 'quiet' }); await send({ type: 'flow.enter' }); await waitFor((s) => s.heartFlow.activeId, 'FLOW_MISSING'); await send({ type: 'flow.mode', mode: 'execute' })
  await write('BEFORE_GIT'); assert.equal((await snapshot()).heartFlow.changes[0].shadow.status, 'not-git')
  const owner = (await readdir(join(profile, 'rooms')))[0]; const desk = join(profile, 'rooms', owner, '书桌'); git(['init', '--quiet', desk])
  const head = await readFile(join(desk, '.git', 'HEAD')); const config = await readFile(join(desk, '.git', 'config'))
  await write('REAL_SHADOW_VERSION'); let change = (await snapshot()).heartFlow.changes.at(-1); assert.equal(change.shadow.status, 'committed'); const sha = change.shadow.commit
  const gitRoot = join(profile, 'desk-shadows', owner, 'repository.git'); const repo = '--git-dir=' + gitRoot
  assert.equal(git([repo, 'show', sha + ':project.md']), 'REAL_SHADOW_VERSION'); assert.equal(git([repo, 'show', sha + '^:project.md']), 'BEFORE_GIT')
  const inspection = instance.waitForEvent('window'); await send({ type: 'flow.inspect', section: 'diff' }); const preview = await inspection; const diff = JSON.parse(await preview.locator('pre').innerText()); assert.equal(diff.changes[0].shadow.commit, sha); await preview.close()
  await close(); const privateRoot = resolve(profile, 'desk-shadows'); assert.ok(privateRoot.startsWith(resolve(data) + sep)); await rm(privateRoot, { recursive: true, force: true })
  await launch(); change = (await snapshot()).heartFlow.changes.at(-1); assert.equal(change.shadow.commit, sha); assert.equal(git([repo, 'show', sha + ':project.md']), 'REAL_SHADOW_VERSION')
  await send({ type: 'flow.undo', changeId: change.id }); assert.equal(await readFile(join(desk, 'project.md'), 'utf8'), 'BEFORE_GIT')
  assert.deepEqual(await readFile(join(desk, '.git', 'HEAD')), head); assert.deepEqual(await readFile(join(desk, '.git', 'config')), config); assert.ok(!(await readdir(join(desk, '.git'))).includes('index'))
  await send({ type: 'flow.exit' }); await waitFor((s) => !s.heartFlow.activeId, 'FLOW_NOT_CLOSED')
  const archive = join(data, 'shadow.lca-save'); await instance.evaluate(({ dialog }, file) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: file }) }, archive); await send({ type: 'backup.export' }); await waitFor((s) => s.backup.status === 'exported', 'ARCHIVE_FAILED')
  await instance.evaluate(({ dialog }, file) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }) }, archive); await send({ type: 'backup.import' }); await waitFor((s) => s.backup.status === 'awaiting-confirmation', 'RESTORE_NOT_READY')
  await instance.evaluate(({ app }) => { app.relaunch = () => {} }); const restoreId = (await snapshot()).backup.restoreId; const closed = instance.waitForEvent('close'); await send({ type: 'backup.restore', restoreId }); await closed; client = undefined; instance = undefined
  assert.ok(privateRoot.startsWith(resolve(data) + sep)); await rm(privateRoot, { recursive: true, force: true }); await launch()
  assert.equal((await snapshot()).backup.status, 'restored'); assert.equal(git([repo, 'show', sha + ':project.md']), 'REAL_SHADOW_VERSION'); assert.equal(await readFile(join(desk, 'project.md'), 'utf8'), 'BEFORE_GIT')
  console.log('Desk shadow Electron: non-Git fallback, actual private Git before/after objects and native diff evidence, unchanged original HEAD/config/index, exact undo, journal rebuild and private-save recovery with identical SHA; synthetic desk/fake model only.')
} finally { await close() }
