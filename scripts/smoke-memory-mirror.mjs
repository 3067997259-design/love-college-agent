// Normal product settings and restore, real private Postgres, local vectors, no chat provider.
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { writeFileSync } from 'node:fs'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { build } from 'vite'
import postgres from 'postgres'
import JSZip from 'jszip'
import { _electron } from 'playwright'
import electronPath from 'electron'
import { runtimeEnv, testDataRoot, electronLaunchTarget, initializeTestBook, openSettings, openSettingsGroup } from './runtime-env.mjs'
import { candidateFingerprint } from './continuity-candidate.mjs'

const repo = resolve(import.meta.dirname, '..'), root = resolve(process.env.LCA_TEST_PG_REPORT ?? '')
const container = process.env.LCA_TEST_PG_CONTAINER, connectionString = process.env.LCA_MEMORY_TEST_DATABASE_URL
assert.ok(process.env.LCA_MEMORY_TEST_POSTGRES === '1' && process.env.LCA_TEST_PG_REPORT && process.env.LCA_TEST_DOCKER_CONFIG && /^lca-continuity-pg-[a-f0-9-]+$/.test(container ?? ''), 'PRIVATE_POSTGRES_GATE_REQUIRED')
const docker = (...args) => spawnSync('docker', ['--config', process.env.LCA_TEST_DOCKER_CONFIG, ...args], { encoding: 'utf8', windowsHide: true, timeout: 30000 })
assert.equal(docker('inspect', container, '--format', '{{index .Config.Labels "lca.continuity-test"}}').stdout.trim(), 'true')
const url = new URL(connectionString), vectorKey = 'synthetic-mirror-' + randomUUID(), profile = join(testDataRoot(repo), 'mirror-product-' + randomUUID())
assert.equal(url.hostname, '127.0.0.1'); assert.equal(url.pathname, '/lca_acceptance')
assert.equal(url.username, 'postgres')
assert.equal(docker('port', container, '5432/tcp').stdout.trim(), '127.0.0.1:' + url.port, 'PRIVATE_DATABASE_PORT_MISMATCH')
await mkdir(dirname(profile), { recursive: true }); await mkdir(profile)
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const report = { ok: false, source: candidateFingerprint(), target: process.env.LCA_TEST_EXECUTABLE ? 'unpacked' : 'source', profile, checks: [], realPostgres: true, realModels: false, realEmbedding: false, vectorCalls: 0 }
if (process.env.LCA_TEST_EXECUTABLE) report.asarSha256 = sha(await readFile(join(dirname(process.env.LCA_TEST_EXECUTABLE), 'resources/app.asar')))
const safe = value => { const text = JSON.stringify(value); for (const secret of [connectionString, url.password, vectorKey]) assert.ok(!text.includes(secret), 'MEMORY_CONNECTION_EXPOSED') }
const sanitize = text => [connectionString, url.password, vectorKey].reduce((value, secret) => value.replaceAll(secret, '[PRIVATE_TEST_CONNECTION]'), String(text))
const check = name => { report.checks.push(name); writeFileSync(join(root, 'progress.json'), JSON.stringify(report, null, 2)); console.log('MIRROR_PRODUCT_CHECK', name) }
const vectors = createServer((req, res) => {
  let body = ''; req.on('data', chunk => { body += chunk }); req.on('end', () => {
    try {
      const input = JSON.parse(body)
      assert.equal(req.url, '/v1/embeddings'); assert.equal(req.headers.authorization, 'Bearer ' + vectorKey); assert.equal(input.model, 'mirror-fixture-vector')
      assert.ok(++report.vectorCalls <= 40, 'LOCAL_VECTOR_LIMIT')
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ object: 'list', model: input.model, data: [{ object: 'embedding', index: 0, embedding: Array.from({ length: 768 }, (_, i) => i === 0 ? 1 : 0) }], usage: { prompt_tokens: 8, total_tokens: 8 } }))
    } catch { res.writeHead(400); res.end() }
  })
})
await new Promise(done => vectors.listen(0, '127.0.0.1', done))
const env = { ...runtimeEnv(repo), LCA_DATA_DIR: profile, LCA_PROVIDERS_FILE: join(root, 'absent-providers.json'), LCA_MCP_PORT: '0', LCA_CDP_PORT: '0' }
let app, page, sql, phase = 'initialize'
const snapshot = () => page.evaluate(() => window.lca.getSnapshot())
const send = body => page.evaluate(async body => { const state = await window.lca.getSnapshot(); return window.lca.dispatch({ ...body, protocolVersion: 1, epoch: state.epoch, requestId: crypto.randomUUID() }) }, body)
const wait = async (predicate, code, limit = 60000) => {
  const deadline = Date.now() + limit
  while (Date.now() < deadline) { const state = await snapshot(); safe(state); if (await predicate(state)) return state; await new Promise(done => setTimeout(done, 100)) }
  throw Error(code)
}
const launch = async () => {
  app = await _electron.launch({ ...electronLaunchTarget(repo, electronPath), env, timeout: 60000 })
  page = await app.firstWindow(); await initializeTestBook(page)
  assert.equal((await snapshot()).runtime.developer.mode, 'normal')
  assert.equal((await send({ type: 'life.schedule', schedule: 'work' })).status, 'accepted')
  assert.equal((await send({ type: 'mode.set', mode: 'rest' })).status, 'accepted')
}
const closeApp = async () => { await app?.close(); app = undefined; page = undefined }
const settings = async () => { await openSettings(page); await openSettingsGroup(page, '记忆与经历'); await page.getByRole('region', { name: '记忆连接设置', exact: true }).waitFor() }
const settingsIdle = () => wait(s => s.memorySettings.status !== 'saving', 'MEMORY_SETTINGS_NOT_SETTLED')
const ready = () => wait(s => s.memorySettings.status === 'idle' && s.memory.engine.mirror.state === 'ready' && s.memory.engine.mirror.pending === 0, 'MIRROR_DID_NOT_SETTLE')
const connectObserver = () => { sql = postgres(connectionString, { connect_timeout: 5, max: 1, connection: { statement_timeout: 10000 } }) }
const closeObserver = async () => { await sql?.end({ timeout: 1 }); sql = undefined }
const namespace = async () => {
  const identity = JSON.parse(await readFile(join(profile, 'continuity.json'), 'utf8')), scope = (await snapshot()).scope
  const epoch = identity.mirrorEpochs[sha(JSON.stringify([scope.userId, scope.characterId]))]
  assert.ok(epoch)
  return 'lca_memory_' + sha(JSON.stringify([scope.userId, scope.characterId, identity.dataRootId, epoch])).slice(0, 32)
}
const remote = async name => {
  assert.match(name, /^lca_memory_[a-f0-9]{32}$/)
  return sql.unsafe(`SELECT origin_id,content,review_status,fact_status,deleted_at,vector_dims(content_vector_768) AS dimensions FROM "${name}".memory_fragments ORDER BY origin_id`)
}
const retry = async () => { await page.getByRole('button', { name: '重试镜像同步', exact: true }).click(); await settingsIdle() }
const startDb = async () => {
  assert.equal(docker('start', container).status, 0)
  for (let i = 0; i < 60; i++) {
    if (docker('exec', container, 'pg_isready', '-U', 'postgres', '-d', 'lca_acceptance').status === 0) {
      assert.equal(docker('port', container, '5432/tcp').stdout.trim(), '127.0.0.1:' + url.port); return
    }
    await new Promise(done => setTimeout(done, 500))
  }
  throw Error('PRIVATE_DATABASE_NOT_READY')
}
const factRow = content => page.getByRole('region', { name: '事实记忆', exact: true }).locator('li').filter({ has: page.getByText(content, { exact: true }) })
try {
  await launch(); const initial = await snapshot(); await closeApp()
  phase = 'seed-existing-long-term-fixture'
  const compiled = join(root, 'fixture', 'mirror.cjs')
  await build({ configFile: false, logLevel: 'error', build: { ssr: resolve('scripts/fixtures/memory-mirror-product.ts'), outDir: dirname(compiled), emptyOutDir: false, minify: false,
    rollupOptions: { external: ['electron', '@duckdb/node-api', 'better-sqlite3'], output: { format: 'cjs', entryFileNames: 'mirror.cjs' } } } })
  const seed = await createRequire(import.meta.url)(compiled).seedMirrorProductFacts(profile, initial.scope, initial.clock.nowMs)
  report.fixture = { kind: 'pre-existing approved long-term facts; promotion not assessed', ids: Object.fromEntries(Object.entries(seed).map(([key, fact]) => [key, fact.id])) }
  await launch(); await settings()
  phase = 'configure-vectors'
  await page.getByLabel('向量服务地址', { exact: true }).fill(`http://127.0.0.1:${vectors.address().port}/v1`)
  await page.getByLabel('向量模型', { exact: true }).fill('mirror-fixture-vector')
  await page.getByLabel('向量密钥', { exact: true }).fill(vectorKey)
  await page.getByRole('button', { name: '保存并迁移向量', exact: true }).click()
  await wait(s => s.memorySettings.status === 'idle' && s.memory.engine.embedding.state === 'ready', 'LOCAL_VECTORS_NOT_READY')
  phase = 'configure-mirror'
  await page.getByLabel('镜像连接串', { exact: true }).fill(connectionString)
  await page.getByRole('button', { name: '保存并开启镜像', exact: true }).click(); await ready()
  assert.equal(await page.getByLabel('镜像连接串', { exact: true }).inputValue(), '')
  const beforeNamespace = await namespace(); connectObserver()
  const initialRows = await remote(beforeNamespace)
  assert.equal(initialRows.length, 3); assert.ok(initialRows.every(row => row.review_status === 'approved' && row.dimensions === 768 && row.deleted_at === null))
  check('settings_enable_and_original_outbox_reach_real_postgres')

  phase = 'offline-correction'
  await closeObserver(); assert.equal(docker('stop', container).status, 0)
  await factRow(seed.corrected.content).getByRole('button', { name: '纠正', exact: true }).click()
  const facts = page.getByRole('region', { name: '事实记忆', exact: true })
  await facts.getByRole('button', { name: '提出更正', exact: true }).waitFor()
  report.correctionLabel = await facts.getByRole('textbox').evaluate(element => element.labels[0].textContent)
  assert.ok(report.correctionLabel.startsWith('更正后的内容'))
  await facts.getByRole('textbox').fill('镜像夹具：任务目标已经改为咖啡。')
  await page.getByRole('button', { name: '提出更正', exact: true }).click()
  await page.getByRole('button', { name: '确认保存', exact: true }).click()
  await wait(s => s.memory.facts.some(f => f.id === seed.corrected.id && f.factStatus === 'superseded') && s.memory.engine.mirror.pending > 0, 'OFFLINE_CORRECTION_NOT_DURABLE')
  await retry(); assert.equal((await snapshot()).memorySettings.status, 'failed')
  await closeApp(); await launch(); await settings()
  await wait(s => s.memory.engine.mirror.pending > 0 && s.memory.facts.some(f => f.id === seed.corrected.id && f.factStatus === 'superseded'), 'OUTBOX_LOST_ON_OFFLINE_RESTART')
  check('offline_correction_and_pending_outbox_survive_restart')

  phase = 'reconnect'
  await startDb(); await retry(); await ready(); connectObserver()
  assert.equal((await remote(beforeNamespace)).find(row => row.origin_id === seed.corrected.id).fact_status, 'superseded')
  await retry(); await ready()
  assert.equal((await remote(beforeNamespace)).filter(row => row.origin_id === seed.corrected.id).length, 1)
  check('retry_invalidates_old_fact_without_duplicate_delivery')

  phase = 'offline-forget-and-save'
  await closeObserver(); assert.equal(docker('stop', container).status, 0)
  await factRow(seed.forgotten.content).getByRole('button', { name: '提出忘记', exact: true }).click()
  await page.getByRole('button', { name: '确认忘记', exact: true }).click()
  await wait(s => !s.memory.facts.some(f => f.id === seed.forgotten.id) && s.memory.engine.mirror.pending > 0, 'OFFLINE_FORGET_NOT_DURABLE')
  const save = join(root, 'mirror-pending.lca-save')
  await app.evaluate(({ dialog }, path) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: path }) }, save)
  assert.equal((await send({ type: 'backup.export' })).status, 'accepted')
  await wait(s => { assert.notEqual(s.backup.status, 'failed', 'PENDING_OUTBOX_SAVE_FAILED:' + s.backup.error?.code); return s.backup.status === 'exported' }, 'PENDING_OUTBOX_SAVE_FAILED')
  const bytes = await readFile(save), archive = await JSZip.loadAsync(bytes)
  assert.ok(bytes.length > 1000)
  assert.ok(!Object.keys(archive.files).some(path => /(^|\/)(connections|secrets)\/|providers\.json/.test(path)))
  for (const file of Object.values(archive.files).filter(file => !file.dir)) safe((await file.async('nodebuffer')).toString('utf8'))
  report.saveSha256 = sha(bytes)
  check('nonempty_save_with_pending_forget_excludes_connections')

  phase = 'restore-with-old-remote-fact'
  await app.evaluate(({ dialog }, path) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] }) }, save)
  assert.equal((await send({ type: 'backup.import' })).status, 'accepted')
  const pending = await wait(s => s.backup.status === 'awaiting-confirmation', 'PRIVATE_SAVE_NOT_VALIDATED')
  await app.evaluate(({ app }) => { app.relaunch = () => {} })
  const closed = app.waitForEvent('close')
  assert.equal((await send({ type: 'backup.restore', restoreId: pending.backup.incoming?.id ?? pending.backup.restoreId })).status, 'accepted')
  await closed; app = undefined; page = undefined
  await startDb(); await launch(); await settings(); await ready()
  const restored = await snapshot(), afterNamespace = await namespace()
  assert.equal(restored.backup.status, 'restored'); assert.notEqual(afterNamespace, beforeNamespace)
  assert.ok(restored.memory.facts.some(f => f.id === seed.kept.id && f.reviewStatus === 'approved'))
  assert.ok(!restored.memory.facts.some(f => f.id === seed.forgotten.id))
  connectObserver()
  const afterRows = await remote(afterNamespace), oldRows = await remote(beforeNamespace)
  assert.ok(afterRows.some(row => row.origin_id === seed.kept.id && row.deleted_at === null))
  assert.ok(!afterRows.some(row => row.origin_id === seed.forgotten.id && row.deleted_at === null))
  assert.ok(oldRows.some(row => row.origin_id === seed.forgotten.id && row.deleted_at === null), 'OLD_NAMESPACE_FIXTURE_DID_NOT_HOLD_STALE_FACT')
  report.namespaces = { before: beforeNamespace, after: afterNamespace }
  check('restore_rotates_mirror_epoch_and_stale_remote_fact_does_not_return')
  await retry(); await ready()
  assert.equal((await remote(afterNamespace)).filter(row => row.origin_id === seed.kept.id).length, 1)
  await page.getByRole('button', { name: '暂停镜像', exact: true }).click(); await settingsIdle()
  assert.equal((await snapshot()).memorySettings.mirror.enabled, false)
  await page.getByRole('button', { name: '保存并开启镜像', exact: true }).click(); await ready()
  assert.equal((await remote(afterNamespace)).filter(row => row.origin_id === seed.kept.id).length, 1)
  check('saved_connection_pause_resume_is_idempotent_and_private')
  await closeObserver(); await closeApp(); await launch(); await ready()
  assert.equal(await namespace(), afterNamespace)
  assert.ok(!(await snapshot()).memory.facts.some(f => f.id === seed.forgotten.id))
  check('restored_epoch_and_forget_survive_another_restart')
  for (const entry of await readdir(join(profile, 'journals'))) for (const file of await readdir(join(profile, 'journals', entry))) if (file.endsWith('.jsonl')) safe(await readFile(join(profile, 'journals', entry, file), 'utf8'))
  assert.equal(candidateFingerprint(), report.source, 'MIRROR_TEST_SOURCE_CHANGED')
  report.ok = true
} catch (error) {
  report.error = sanitize(error.message); report.phase = phase; process.exitCode = 1
  if (page && !page.isClosed()) {
    try {
      const state = await snapshot(), details = { phase, backup: state.backup, memory: state.memory, settings: state.memorySettings,
        facts: await page.getByRole('region', { name: '事实记忆', exact: true }).textContent({ timeout: 3000 }) }
      safe(details); await writeFile(join(root, 'failure-state.json'), JSON.stringify(details, null, 2))
    } catch { report.failureStateUnavailable = true }
  }
}
finally {
  await closeObserver().catch(() => { report.cleanupUncertain = true })
  await closeApp().catch(() => { report.cleanupUncertain = true })
  await new Promise(done => vectors.close(done))
  await writeFile(join(root, 'product.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report))
}
