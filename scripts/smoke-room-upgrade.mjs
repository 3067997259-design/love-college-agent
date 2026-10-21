import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile, unlink } from 'node:fs/promises'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron } from 'playwright'
import electronPath from 'electron'
import { runtimeEnv, initializeTestBook } from './runtime-env.mjs'
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..'); const cwd = join(root, '.local-data', 'upgrade-' + randomUUID())
const data = join(cwd, '.local-data'); const docs = join(cwd, 'Documents'); const owner = ['local-user', 'default-character']
const sha = (text) => createHash('sha256').update(text).digest('hex'); const ownerKey = sha('text:' + JSON.stringify(owner)); const legacy = join(data, 'rooms', ownerKey, '书桌')
const env = { ...runtimeEnv(root), LCA_PROVIDERS_FILE: join(cwd, 'absent.json') }; delete env.LCA_DATA_DIR; delete env.LCA_BOOTH; delete env.ELECTRON_RENDERER_URL
let instance; let page
const noteId = randomUUID(); const deletedId = randomUUID()
const snapshot = () => page.evaluate(() => window.lca.getSnapshot())
async function launch() { instance = await _electron.launch({ executablePath: electronPath, args: [join(cwd, 'entry.cjs')], cwd, env }); page = await instance.firstWindow(); await initializeTestBook(page) }
try {
  await mkdir(legacy, { recursive: true }); await mkdir(docs, { recursive: true })
  // Bootstrap only redirects Documents into this isolated test directory; the app uses its ordinary
  // unpackaged cwd data-root branch, with no LCA_DATA_DIR and no developer/booth mode.
  await writeFile(join(cwd, 'entry.cjs'), `const {app}=require('electron');app.setPath('documents',${JSON.stringify(docs)});require(${JSON.stringify(join(root, 'out/main/index.cjs'))});`)
  const atMs = Date.now(); const day = new Date(atMs + 4 * 3600000).toISOString().slice(0, 10)
  const folder = join(data, 'journals', sha(JSON.stringify(owner))); await mkdir(folder, { recursive: true })
  const rows = [{ type: 'session/header', userId: owner[0], characterId: owner[1], sessionId: randomUUID() }, { type: 'flow/open', id: 'upgrade-flow', prefix: [], mode: 'execute' }]
  for (const [path, id] of [['note.md', noteId], ['deleted-after-upgrade.md', deletedId]]) {
    rows.push({ type: 'desk/change', id, flowId: 'upgrade-flow', path, before: null, after: 'UPGRADE_OLD', pending: true }, { type: 'desk/settled', id, status: 'applied' }); await writeFile(join(legacy, path), 'UPGRADE_OLD')
  }
  await writeFile(join(legacy, 'unlogged.md'), 'UNREGISTERED_FILE')
  await writeFile(join(folder, day + '.jsonl'), rows.map((row, index) => JSON.stringify({ ...row, version: 1, atMs, seq: index + 1 })).join('\n') + '\n')
  await launch(); assert.equal((await snapshot()).runtime.developer.mode, 'normal')
  const settings = JSON.parse(await readFile(join(data, 'settings.json'), 'utf8')); assert.ok(settings.roomLayout.root.startsWith(docs)); const desk = join(settings.roomLayout.root, '书桌')
  assert.equal(await readFile(join(desk, 'note.md'), 'utf8'), 'UPGRADE_OLD'); assert.equal(await readFile(join(legacy, 'note.md'), 'utf8'), 'UPGRADE_OLD')
  // The old flow stays readable as history: its diff shows the migrated file as current.
  const inspect = await page.evaluate(() => window.lca.readHeartFlow({ section: 'diff', flowId: 'upgrade-flow' })); assert.ok(inspect.changes.find((row) => row.id === noteId)?.current)
  await assert.rejects(readFile(join(desk, 'unlogged.md')))
  await unlink(join(desk, 'deleted-after-upgrade.md')); await instance.close(); instance = undefined; await launch()
  await assert.rejects(readFile(join(desk, 'deleted-after-upgrade.md'))); assert.equal(await readFile(join(desk, 'note.md'), 'utf8'), 'UPGRADE_OLD')
  assert.equal(await readFile(join(legacy, 'note.md'), 'utf8'), 'UPGRADE_OLD')
  console.log('Room upgrade Electron PASS: normal startup without LCA_DATA_DIR/developer/booth, real old journal and files, ordinary Documents layout, old flow diff readable, original retained, unlogged file excluded, and restart does not resurrect a user deletion. No model/service calls.')
} finally { await instance?.close() }
