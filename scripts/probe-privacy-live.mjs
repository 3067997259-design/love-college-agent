import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron } from 'playwright'
import electronPath from 'electron'
import { runtimeEnv, initializeTestBook, electronLaunchTarget } from './runtime-env.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const inspectId = process.argv[2] === '--inspect' ? process.argv[3] : undefined
if (inspectId) assert.match(inspectId, /^[a-f0-9-]{36}$/)
const data = join(root, '.local-data', 'privacy-live-' + (inspectId ?? randomUUID()))
// Credentials are read only by the application main process. No import/copy,
// renderer reads, real mail, ordinary conversation or repeated file submission.
const env = { ...runtimeEnv(root), LCA_DATA_DIR: data }; delete env.LCA_BOOTH
let marker = 'SYNTHETIC_PRIVATE_SOURCE_' + randomUUID()
async function records() {
  const rows = []
  for (const owner of await readdir(join(data, 'journals'))) for (const name of await readdir(join(data, 'journals', owner))) if (name.endsWith('.jsonl')) rows.push(...(await readFile(join(data, 'journals', owner, name), 'utf8')).trim().split('\n').map(JSON.parse))
  return rows
}
let instance; let page; let job; let report = { ok: false, probe: 'privacy-live', syntheticFile: true, mainProcessOnly: true }
try {
  await mkdir(data, { recursive: true })
  const file = join(data, 'synthetic.txt')
  if (inspectId) marker = (await readFile(file, 'utf8')).split('\n')[0]
  else await writeFile(file, marker + '\n合成课程阅读记录：周五桥。请整理阅读要点和下一步。\n报告截止时间：2026年10月24日 23:59。\n本文仅为合成验收材料。\n')
  const beforeAttempts = inspectId ? (await records()).filter((row) => row.type === 'model/attempt' && row.status === 'started').length : 0
  instance = await _electron.launch({ ...electronLaunchTarget(root, electronPath), env }); page = await instance.firstWindow(); await initializeTestBook(page)
  const snapshot = () => page.evaluate(() => window.lca.getSnapshot())
  let state = await snapshot()
  assert.ok(state.runtime.developer.mode === 'normal', 'NORMAL_PROFILE_REQUIRED')
  assert.ok(state.modelSettings.configuredSlots.includes('privacy'), 'PRIVACY_NOT_CONFIGURED')
  if (!inspectId) {
    const ack = await page.evaluate(async () => { const s = await window.lca.getSnapshot(); return window.lca.dispatch({ protocolVersion: 1, epoch: s.epoch, requestId: crypto.randomUUID(), type: 'privacy.set', enabled: true }) })
    assert.ok(ack.status === 'accepted', 'PRIVACY_SETTING_REFUSED')
    await page.getByLabel('选择资料文件', { exact: true }).setInputFiles(file)
  }
  for (let i = 0; i < 400; i++) { state = await snapshot(); job = state.documents.jobs[0]; if (job && ['ready', 'failed', 'cancelled'].includes(job.status)) break; await new Promise((done) => setTimeout(done, 100)) }
  assert.ok(job && ['ready', 'failed', 'cancelled'].includes(job.status), 'PRIVACY_DEADLINE')
  await instance.close(); instance = undefined
  const rows = await records()
  const attempts = rows.filter((row) => row.type === 'model/attempt' && row.status === 'started')
  assert.ok(attempts.length > 0 && attempts.length <= 4 && attempts.every((row) => row.slot === 'privacy'), 'PRIVACY_ROUTING_INVALID')
  assert.ok(!inspectId || attempts.length === beforeAttempts, 'INSPECTION_MUST_NOT_REQUEST_MODELS')
  assert.ok(!JSON.stringify(rows).includes(marker) && !JSON.stringify(state).includes(marker), 'PRIVATE_SOURCE_LEAK')
  assert.ok(!rows.some((row) => row.type === 'model/seen'), 'ORDINARY_CONTEXT_MUST_STAY_EMPTY')
  const outputs = job.status === 'ready' ? (await readdir(join(data, 'artifacts'))).filter((name) => name.endsWith('.md')) : []
  let factsPresent = false
  if (outputs.length === 1) { const output = await readFile(join(data, 'artifacts', outputs[0]), 'utf8'); factsPresent = output.includes('周五桥') && output.includes('2026') }
  const ok = job.status === 'ready' && job.deadlineIso === '2026-10-24T23:59:00+08:00' && outputs.length === 1 && factsPresent
  const failures = rows.filter((row) => row.type === 'model/attempt' && row.status === 'failed')
  const known = new Set(['configuration', 'network', 'timeout', 'upstream', 'quota', 'cancelled', 'invalid-output', 'interrupted', 'content-filtered'])
  report = { ...report, ok, inspectionOnly: !!inspectId, newRequests: attempts.length - beforeAttempts, realPrivacyRequests: attempts.length, failureKinds: [...new Set(failures.map((row) => known.has(row.error) ? row.error : 'unknown'))], privacyOnly: true, rawSourceExcluded: true, ordinaryContextEmpty: true, actualMarkdownFile: outputs.length === 1, basicFactsPresent: factsPresent,
    groundedDeadlineMatched: job.deadlineIso === '2026-10-24T23:59:00+08:00', status: job.status, ...(job.error ? { error: job.error.code } : {}), broadQualityAccepted: false }
} catch { report = { ...report, error: 'PRIVACY_LIVE_PROBE_FAILED' } }
finally { await instance?.close() }
await mkdir(join(root, 'test-results'), { recursive: true }); await writeFile(join(root, 'test-results/privacy-live-report.json'), JSON.stringify(report, null, 2))
console.log(JSON.stringify(report)); process.exitCode = report.ok ? 0 : 1
