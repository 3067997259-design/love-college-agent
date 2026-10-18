import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const referenceRoot = resolve(process.env.LCA_STUDENT_HUB_ROOT ?? 'D:\\student-hub')
if (process.env.LCA_STUDENT_HUB_LIVE !== '1') {
  console.log(JSON.stringify({ ok: false, probe: 'student-hub-live', error: 'EXPLICIT_CONSENT_REQUIRED' }))
  process.exit(1)
}
const reportDir = join(root, 'test-results')
const runDir = join(reportDir, `student-hub-live-${randomUUID()}`)
const referenceConfig = join(referenceRoot, 'config', 'sources.toml')
const packageFile = join(root, 'plugin-packages', 'student-hub', 'mcp.json')
const timeoutMs = Number(process.env.LCA_STUDENT_HUB_SCAN_TIMEOUT_MS ?? 15 * 60_000)
const limit = Number(process.env.LCA_STUDENT_HUB_SCAN_LIMIT ?? 3)
const sleep = (ms) => new Promise((done) => setTimeout(done, ms))
let client; let transport

function sanitizedConfig(text, dbPath, backupDir, keyPath) {
  let section = ''
  return text.split(/\r?\n/).map((line) => {
    const header = /^\s*\[([^\]]+)\]/.exec(line)
    if (header) { section = header[1].trim(); return line }
    if (section === 'database' && /^\s*path\s*=/.test(line)) return `path = ${JSON.stringify(dbPath)}`
    if (section === 'maintenance' && /^\s*backup_dir\s*=/.test(line)) return `backup_dir = ${JSON.stringify(backupDir)}`
    if (section === 'privacy' && /^\s*key_path\s*=/.test(line)) return `key_path = ${JSON.stringify(keyPath)}`
    if ((section.startsWith('portal.') || section === 'actions') && /^\s*enabled\s*=/.test(line)) return 'enabled = false'
    return line
  }).join('\n')
}

async function call(name, args = {}) {
  const result = await client.callTool({ name, arguments: args })
  if (result.isError) throw new Error('STUDENT_HUB_TOOL_FAILED')
  const text = result.content?.find((item) => item.type === 'text')?.text
  if (!text) return result.structuredContent ?? (name === 'list_review_cases' ? [] : {})
  return JSON.parse(text)
}

function scanCounts(result) {
  const payload = result.result && typeof result.result === 'object' ? result.result : {}
  return {
    reviewCount: Number(payload.review_count ?? 0),
    actionableReviewCount: Number(payload.actionable_review_count ?? 0),
    artifactCount: Array.isArray(payload.artifacts) ? payload.artifacts.length : 0,
    healthCount: Array.isArray(payload.health) ? payload.health.length : 0
  }
}
function dashboardSummary(value) {
  return {
    healthSources: Array.isArray(value.health) ? value.health.length : 0,
    activeCourses: Array.isArray(value.active_courses) ? value.active_courses.length : 0,
    pendingRevisions: Array.isArray(value.pending_revisions) ? value.pending_revisions.length : 0,
    safety: value.safety && typeof value.safety === 'object' ? { sourceAccess: value.safety.source_access, externalWrites: value.safety.external_writes } : null
  }
}

try {
  await mkdir(runDir, { recursive: true })
  const configText = await readFile(referenceConfig, 'utf8')
  const dbPath = join(runDir, 'student_hub.sqlite3')
  const backupDir = join(runDir, 'backups')
  await mkdir(backupDir, { recursive: true })
  const configPath = join(runDir, 'sources.toml')
  const keyPath = process.env.LCA_STUDENT_HUB_KEY_PATH ?? join(referenceRoot, 'var', 'evidence-key.dpapi')
  await writeFile(configPath, sanitizedConfig(configText, dbPath, backupDir, keyPath), { mode: 0o600 })

  const packageJson = JSON.parse(await readFile(packageFile, 'utf8'))
  const configured = packageJson.mcpServers['student-hub']
  const args = []
  for (let index = 0; index < configured.args.length; index++) {
    if (configured.args[index] === '--config') { args.push('--config', configPath); index++; continue }
    args.push(configured.args[index])
  }
  args.push('--db', dbPath)
  transport = new StdioClientTransport({ command: configured.command, args, env: configured.env, cwd: referenceRoot, stderr: 'pipe' })
  client = new Client({ name: 'lca-student-hub-live', version: '1.0.0' })
  await client.connect(transport)
  const tools = await client.listTools()
  const names = tools.tools.map((tool) => tool.name)
  const allowed = configured.allowTools
  if (!allowed.every((name) => names.includes(name))) throw new Error('STUDENT_HUB_ALLOWLIST_MISSING')

  const integrity = await call('integrity_check')
  const before = await call('get_dashboard')
  const startedAt = Date.now()
  const started = await call('scan_school_updates', { limit })
  const jobId = started.id
  if (!jobId) throw new Error('STUDENT_HUB_SCAN_NO_JOB')
  let job
  for (;;) {
    job = await call('get_school_update_scan', { job_id: jobId })
    if (['succeeded', 'failed', 'cancelled'].includes(job.status)) break
    if (Date.now() - startedAt > timeoutMs) throw new Error('STUDENT_HUB_SCAN_TIMEOUT')
    await sleep(2000)
  }
  const result = await call('get_school_update_scan_result', { job_id: jobId })
  const reviewCases = await call('list_review_cases', { actionable: true })
  const after = await call('get_dashboard')
  const errorText = String(job.error_message ?? '')
  if (process.env.LCA_STUDENT_HUB_DEBUG === '1' && errorText) await writeFile(join(reportDir, 'student-hub-live-error.txt'), errorText)
  const errorClass = /credential|keyring|password/i.test(errorText) ? 'credential'
    : /auth|login|two-factor/i.test(errorText) ? 'auth'
      : /config|toml/i.test(errorText) ? 'configuration'
        : /timeout|timed out/i.test(errorText) ? 'timeout'
          : job.error_code ? 'scan-error' : null
  const report = {
    ok: job.status === 'succeeded' && result.ready === true,
    probe: 'student-hub-live',
    realSchoolScan: true,
    emailOnly: true,
    toolCount: names.length,
    allowlistPresent: allowed.length,
    integrityOk: integrity.ok === true,
    before: dashboardSummary(before),
    after: dashboardSummary(after),
    scan: { status: job.status, ready: result.ready === true, noExternalWrite: result.external_write === false, errorCode: job.error_code ?? null, errorClass, durationMs: Date.now() - startedAt, counts: scanCounts(result) },
    actionableReviewCases: Array.isArray(reviewCases) ? reviewCases.length : 0,
    noContentReported: true
  }
  await writeFile(join(reportDir, 'student-hub-live-report.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report))
  if (!report.ok) process.exitCode = 1
} catch (error) {
  const report = { ok: false, probe: 'student-hub-live', error: error instanceof Error ? error.message : 'STUDENT_HUB_LIVE_FAILED', noContentReported: true }
  await writeFile(join(reportDir, 'student-hub-live-report.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report))
  process.exitCode = 1
} finally {
  await client?.close().catch(() => {})
  await transport?.close().catch(() => {})
  await rm(runDir, { recursive: true, force: true }).catch(() => {})
}
