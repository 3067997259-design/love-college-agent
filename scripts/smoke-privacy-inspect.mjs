// 只读回归：--inspect 遇到非终态资料任务必须在启动应用前拒绝，不发任何模型请求。
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const id = randomUUID(); const data = join(root, '.local-data', 'privacy-live-' + id)
const owner = 'a'.repeat(64); const journalDir = join(data, 'journals', owner)
const report = join(root, 'test-results', 'privacy-inspect-refusal-' + id + '.json')
try {
  await mkdir(journalDir, { recursive: true })
  await writeFile(join(data, 'synthetic.txt'), 'synthetic-inspect-profile\n')
  await writeFile(join(journalDir, '2026-10-17.jsonl'), [
    JSON.stringify({ type: 'companion/mode', mode: 'quiet', requestId: 'fixture', commandHash: 'fixture' }),
    JSON.stringify({ type: 'document/job', job: { sourceRef: null, attempt: 0, view: { id: 'doc-inflight', displayName: '资料-deadbeef.md', format: 'markdown', origin: 'drop', source: 'real', status: 'staged', byteLength: 128, pageCount: null, deadlineIso: null, createdAtMs: 1, updatedAtMs: 1 } } }),
  ].join('\n') + '\n')
  const env = { ...process.env, LCA_PRIVACY_PROBE_REPORT: report }
  const child = spawnSync(process.execPath, [join(root, 'scripts/probe-privacy-live.mjs'), '--inspect', id], { env, encoding: 'utf8', timeout: 30_000 })
  assert.notEqual(child.status, 0, 'INSPECT_REFUSAL_EXIT')
  const parsed = JSON.parse(await readFile(report, 'utf8'))
  assert.equal(parsed.error, 'INSPECTION_REQUIRES_TERMINAL_DOCUMENTS'); assert.equal(parsed.nonTerminalDocuments, 1)
  assert.equal(parsed.inspectionOnly, undefined); assert.equal(parsed.realPrivacyRequests, undefined)
  console.log('privacy inspect refusal: non-terminal document profile rejected before app launch; no model requests')
} finally {
  await rm(report, { force: true }); await rm(data, { recursive: true, force: true })
}
