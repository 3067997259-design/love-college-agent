import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import { _electron } from 'playwright'
import electronPath from 'electron'
import { runtimeEnv, initializeTestBook, electronLaunchTarget } from './runtime-env.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const data = join(root, '.local-data', `student-hub-candidates-${randomUUID()}`)
const hub = join(root, '.local-data', `student-hub-fixture-${randomUUID()}`)
const pluginSource = join(root, 'plugin-packages', 'student-hub-candidates')
const dbPath = join(hub, 'var', 'student_hub.sqlite3')
const env = { ...runtimeEnv(root), LCA_DATA_DIR: data, LCA_PROVIDERS_FILE: join(data, 'absent-test-providers.json'),
  LCA_MCP_PORT: '0', LCA_CDP_PORT: '19583', LCA_STUDENT_HUB_ROOT: hub, LCA_STUDENT_HUB_DB: dbPath }
let instance
let page

async function waitFor(test, message) {
  for (let i = 0; i < 120; i++) {
    if (await test()) return
    await new Promise((done) => setTimeout(done, 100))
  }
  throw new Error(message)
}

try {
  await mkdir(join(hub, 'config'), { recursive: true })
  await mkdir(join(hub, 'var'), { recursive: true })
  await writeFile(join(hub, 'config', 'sources.toml'), '[database]\npath = "var/student_hub.sqlite3"\n')
  const db = new Database(dbPath)
  db.exec(`CREATE TABLE items (id TEXT PRIMARY KEY, item_type TEXT NOT NULL, title TEXT NOT NULL, course TEXT, status TEXT NOT NULL,
    deadline_at TEXT, event_start TEXT, event_end TEXT, calendar_role TEXT, source_summary TEXT, created_at TEXT NOT NULL);
    CREATE TABLE item_evidence (item_id TEXT NOT NULL, artifact_id INTEGER NOT NULL);
    CREATE TABLE raw_artifacts (id INTEGER PRIMARY KEY, subject TEXT, payload_json TEXT NOT NULL);`)
  db.prepare('INSERT INTO items VALUES (?,?,?,?,?,?,?,?,?,?,?)').run('item_fixture', 'deadline', '提交 Student Hub 候选测试', '测试课程', 'confirmed',
    '2027-01-05T23:00:00+08:00', null, null, null, 'PRIVATE_STUDENT_HUB_EXCERPT', '2026-10-18T00:00:00+08:00')
  db.close()

  instance = await _electron.launch({ ...electronLaunchTarget(root, electronPath), env })
  page = await instance.firstWindow()
  await initializeTestBook(page)
  await page.locator('[data-mode][data-pose]').waitFor()
  const snapshot = () => page.evaluate(() => window.lca.getSnapshot())

  await page.locator('.bookmarks').getByRole('button', { name: '插件', exact: true }).click()
  const center = page.getByRole('region', { name: '插件', exact: true })
  await center.getByRole('heading', { name: '插件', exact: true }).waitFor()
  await center.getByRole('button', { name: '+ 添加插件', exact: true }).click()
  await center.getByRole('menuitem', { name: '安装本地插件', exact: true }).click()
  const dialog = center.getByRole('dialog', { name: '添加插件', exact: true })
  await dialog.getByLabel('安装本地插件', { exact: true }).fill(pluginSource)
  await dialog.getByRole('button', { name: '安装', exact: true }).click()

  const row = center.locator('.plugin-row[data-plugin-id="student-hub-candidates"]')
  await row.waitFor()
  await row.getByRole('switch').click()
  const approval = row.getByRole('alertdialog', { name: '确认并启用', exact: true })
  await approval.waitFor()
  await approval.getByRole('button', { name: '确认并启用', exact: true }).click()
  await waitFor(async () => (await row.getByRole('switch').getAttribute('aria-checked')) === 'true', 'CANDIDATE_PLUGIN_NOT_ENABLED')

  await waitFor(async () => (await snapshot()).candidates.length === 1, 'CANDIDATE_NOT_INGESTED')
  const proposed = await snapshot()
  assert.equal(proposed.candidates[0].source, 'real')
  assert.equal(proposed.candidates[0].kind, 'deadline')
  assert.equal(proposed.candidates[0].sourceLabel, 'Student Hub · 测试课程')
  assert.ok(!JSON.stringify(proposed).includes('PRIVATE_STUDENT_HUB_EXCERPT'), 'EXCERPT_LEAKED_TO_SNAPSHOT')

  await page.locator('.bookmarks').getByRole('button', { name: /^对话/ }).click()
  const card = page.locator('.card-candidate[data-kind="deadline"]')
  await card.waitFor()
  assert.match(await card.locator('.card-title').innerText(), /Student Hub/)
  await card.getByRole('button', { name: '看原文', exact: true }).click()
  await card.locator('.evidence-body').waitFor()
  assert.match(await card.locator('.evidence-body').innerText(), /PRIVATE_STUDENT_HUB_EXCERPT/)

  await instance.close()
  instance = await _electron.launch({ ...electronLaunchTarget(root, electronPath), env })
  page = await instance.firstWindow()
  await initializeTestBook(page)
  await page.locator('[data-mode][data-pose]').waitFor()
  await waitFor(async () => (await snapshot()).candidates.length === 1, 'CANDIDATE_DUPLICATED_ON_RESTART')

  console.log(JSON.stringify({ ok: true, probe: 'student-hub-candidates', pluginInstalled: true, candidateCount: proposed.candidates.length,
    cardVisible: true, userEvidence: true, snapshotExcludesExcerpt: true, restartIdempotent: true, syntheticStudentHub: true }))
} finally {
  await instance?.close().catch(() => {})
  for (const path of [data, hub]) {
    if (path.startsWith(join(root, '.local-data', path.includes('student-hub-fixture-') ? 'student-hub-fixture-' : 'student-hub-candidates-'))) {
      await rm(path, { recursive: true, force: true }).catch(() => {})
    }
  }
}
