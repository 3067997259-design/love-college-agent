// Opt-in continuation of one known isolated probe. Preserve its ledger and member identities.
import assert from 'node:assert/strict'
import { randomUUID, createHash } from 'node:crypto'
import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { _electron } from 'playwright'
import electronPath from 'electron'
import { runtimeEnv, initializeTestBook, electronLaunchTarget } from './runtime-env.mjs'

assert.equal(process.env.LCA_REAL_MODEL, '1', 'REAL_MODEL_OPT_IN_REQUIRED')
assert.ok(process.env.LCA_PROVIDERS_FILE, 'AUTHORIZED_CONFIG_PATH_REQUIRED')
const sourceId = process.argv[2]
assert.match(sourceId ?? '', /^[0-9a-f-]{36}$/)
const root = resolve(import.meta.dirname, '..'), id = randomUUID(), data = join(root, '.local-data', 'real-collaboration-' + sourceId)
const sourceOut = join(root, 'test-results', 'real-collaboration-' + sourceId), out = join(root, 'test-results', 'real-collaboration-reuse-' + id)
const baseline = JSON.parse(readFileSync(join(sourceOut, 'report.json'), 'utf8'))
const team = baseline.cases.find((c) => c.name === 'team'), ruleId = team?.tasks.find((t) => t.id === 'task-1')?.ownerSessionId
const rootId = team?.members.find((m) => m.mode === 'root')?.sessionId
assert.ok(baseline.ok && ruleId && rootId, 'COMPLETED_TEAM_REQUIRED')
const config = join(data, 'probe-providers.json'), backup = data + '-before-reuse-' + id
assert.equal(existsSync(config), false, 'UNEXPECTED_EXISTING_CREDENTIAL_COPY')
mkdirSync(out, { recursive: true })
const hash = (file) => createHash('sha256').update(readFileSync(file)).digest('hex')
const copied = [], skipped = []
const preserve = (from, to, relative = '') => {
  mkdirSync(to, { recursive: true })
  for (const entry of readdirSync(from)) {
    const src = join(from, entry), dst = join(to, entry), rel = join(relative, entry), stat = lstatSync(src)
    if (stat.isSymbolicLink()) { skipped.push(rel); continue }
    if (stat.isDirectory()) preserve(src, dst, rel)
    else { copyFileSync(src, dst); const sha256 = hash(src); assert.equal(hash(dst), sha256); copied.push({ path: rel, sha256 }) }
  }
}
preserve(data, backup)
writeFileSync(join(out, 'backup-manifest.json'), JSON.stringify({ source: data, backup, files: copied, skippedLinks: skipped }, null, 2))
const user = join(data, 'user')
const env = { ...runtimeEnv(root), LCA_DATA_DIR: data, LCA_PROVIDERS_FILE: config, LCA_MCP_PORT: '0', LCA_CDP_PORT: '0', LCA_TEST_SILENT: '1',
  HOME: user, USERPROFILE: user, APPDATA: join(user, 'AppData/Roaming'), LOCALAPPDATA: join(user, 'AppData/Local') }
delete env.LCA_BOOTH; delete env.ELECTRON_RENDERER_URL
let instance, bootstrap, page, timer
const report = { sourceId, id, realServices: true, sourceRootSessionId: rootId, expectedRuleSessionId: ruleId, backup, automaticApprovals: false, cases: [], scriptSha256: hash(import.meta.filename), startedAtIso: new Date().toISOString() }
const snapshot = () => page.evaluate(() => window.lca.getSnapshot())
const send = (body) => page.evaluate(async (body) => { const s = await window.lca.getSnapshot(); return window.lca.dispatch({ protocolVersion: 1, epoch: s.epoch, requestId: crypto.randomUUID(), ...body }) }, body)
const members = (s) => s.collaboration.members.map((m) => ({ sessionId: m.address.sessionId, mode: m.mode, activity: m.activity, outcome: m.outcome, usage: m.usage }))
console.log('REAL_REUSE_START', out)
try {
  report.stage = 'configuration'
  const bootstrapData = join(root, '.local-data', 'reuse-bootstrap-' + id)
  bootstrap = await _electron.launch({ ...electronLaunchTarget(root, electronPath), env: { ...env, LCA_DATA_DIR: bootstrapData, LCA_PROVIDERS_FILE: join(bootstrapData, 'not-configured.json') }, timeout: 30000 })
  report.configuration = await bootstrap.evaluate(async (_, input) => {
    const fs = process.mainModule.require('node:fs'), parsed = JSON.parse(fs.readFileSync(input.authorized, 'utf8'))
    if (!parsed.providers?.chat || !parsed.providers?.work || new URL(parsed.providers.work.base_url).hostname !== 'api.deepseek.com') throw new Error('OFFICIAL_WORK_CONFIGURATION_REQUIRED')
    const workRouting = parsed.routing?.work ?? 'independent'
    if (workRouting !== 'independent') throw new Error('INDEPENDENT_WORK_REQUIRED')
    const efforts = Object.fromEntries(['chat', 'work'].filter((role) => Object.hasOwn(parsed.efforts ?? {}, role)).map((role) => [role, parsed.efforts[role]]))
    fs.writeFileSync(input.config, JSON.stringify({ providers: { chat: parsed.providers.chat, work: parsed.providers.work }, routing: { work: workRouting }, efforts, ...(parsed.modelCapabilities ? { modelCapabilities: parsed.modelCapabilities } : {}) }), { mode: 0o600 })
    return { officialWork: true, workRouting, efforts }
  }, { authorized: resolve(process.env.LCA_PROVIDERS_FILE), config })
  await bootstrap.close(); bootstrap = null
  report.stage = 'restore-roster'
  instance = await _electron.launch({ ...electronLaunchTarget(root, electronPath), env, timeout: 30000 })
  page = await instance.firstWindow(); await initializeTestBook(page)
  const initial = await snapshot()
  report.baselineUsage = initial.resources.model
  assert.equal(initial.resources.model.totalReservedUnits, baseline.finalState.usage.totalReservedUnits)
  assert.equal(initial.resources.model.totalLimitUnits, baseline.finalState.usage.totalLimitUnits)
  assert.equal(initial.resources.model.autonomousLimitUnits, 0)
  assert.equal((await send({ type: 'mode.set', mode: 'work' })).status, 'accepted')
  const refresh = await send({ type: 'agent.refresh' })
  assert.equal(refresh.status, 'accepted')
  report.refreshRequestId = refresh.requestId
  let before
  const observations = []
  for (let i = 0; i < 300; i++) {
    const s = await snapshot()
    const fact = { status: s.collaboration.status, operation: s.collaboration.operation, ids: s.collaboration.members.map((m) => m.address.sessionId) }
    if (JSON.stringify(fact) !== JSON.stringify(observations.at(-1))) observations.push(fact)
    if (s.collaboration.status === 'ready' && s.collaboration.members.some((m) => m.address.sessionId === rootId)) { before = s; break }
    if (s.collaboration.operation?.requestId === refresh.requestId && s.collaboration.operation?.outcome === 'failed') break
    await new Promise((done) => setTimeout(done, 100))
  }
  report.restoreObservations = observations
  if (!before) throw new Error('ROSTER_RECOVERY_FAILED')
  report.before = { members: members(before), tasks: before.collaboration.tasks, usage: before.resources.model, operation: before.collaboration.operation }
  assert.ok(before.collaboration.members.some((m) => m.mode === 'root' && m.address.sessionId === rootId), 'ROOT_ID_NOT_RECOVERED')
  assert.ok(before.collaboration.members.some((m) => m.mode === 'teammate' && m.address.sessionId === ruleId), 'RULE_MEMBER_NOT_RECOVERED')
  assert.equal(before.resources.model.attemptCount, initial.resources.model.attemptCount, 'RESTORE_MUST_NOT_CALL_MODEL')
  const oldIds = new Set(before.collaboration.members.map((m) => m.address.sessionId))
  const baselineRuleUsage = before.collaboration.members.find((m) => m.address.sessionId === ruleId).usage.admittedUnits
  report.stage = 'reuse'
  const text = `这是同一位规则员的续用验收。先 list_agents 核对原团队，明确只续用现有规则员 team:${ruleId}，不要新建成员或身份，不要找其他帮手。给它发送新的明确任务，等它实际回复后你再总结。新任务：甲=4、乙=1，核对总和是否仍为5；旧逐项登记值是甲=2、乙=3，请分别说明“总和仍为5”和“不满足旧逐项登记值”，不要把这两件事混成旧规则全部通过。无需改旧任务或建新任务。不要浏览网络、读写文件或执行命令。`
  timer = setTimeout(() => { report.timedOut = true; void instance?.close().catch(() => {}) }, 6 * 60000)
  assert.equal((await send({ type: 'message.send', text })).status, 'accepted')
  let after
  for (let i = 0; i < 1800; i++) {
    const s = await snapshot()
    if (s.question) throw new Error('INTERACTION_REQUIRED_NO_AUTO_APPROVAL')
    if (s.resources.model.totalReservedUnits > initial.resources.model.totalLimitUnits) throw new Error('BUDGET_BOUNDARY_FAILED')
    if (s.task?.id !== before.task?.id && ['failed', 'aborted'].includes(s.task?.status)) throw new Error('TURN_FAILED')
    if (s.task?.id !== before.task?.id && s.task?.status === 'completed' && s.collaboration.members.every((m) => !['starting', 'running', 'waiting', 'stopping'].includes(m.activity))) { after = s; break }
    await new Promise((done) => setTimeout(done, 100))
  }
  if (!after) throw new Error('CASE_TIMEOUT')
  const rule = after.collaboration.members.find((m) => m.address.sessionId === ruleId), priorMessages = new Set(before.messages.map((m) => m.id))
  const result = { name: 'same-rule-member-reuse', beforeSessionIds: [...oldIds], afterSessionIds: after.collaboration.members.map((m) => m.address.sessionId), members: members(after),
    addedSessionIds: after.collaboration.members.filter((m) => !oldIds.has(m.address.sessionId)).map((m) => m.address.sessionId),
    ruleSessionId: rule?.address.sessionId, ruleUsageBefore: baselineRuleUsage, ruleUsageAfter: rule?.usage.admittedUnits,
    attempts: after.resources.model.attemptCount - before.resources.model.attemptCount, usage: after.resources.model,
    responses: after.messages.filter((m) => m.role === 'assistant' && !priorMessages.has(m.id)).map((m) => m.text.slice(0, 4000)) }
  report.cases.push(result)
  result.passed = result.addedSessionIds.length === 0 && result.afterSessionIds.length === oldIds.size && rule?.mode === 'teammate' && rule.outcome === 'completed' && rule.usage.admittedUnits > baselineRuleUsage && result.responses.length > 0
  if (!result.passed) throw new Error('MEMBER_REUSE_EXPECTATION_FAILED')
  report.ok = true; report.stage = 'completed'
  console.log(JSON.stringify(result))
} catch (error) { report.ok = false; report.error = /^[A-Z_]+$/.test(error.message) ? error.message : 'REAL_REUSE_FAILED'; if (error.name === 'AssertionError') report.assertion = { actual: error.actual, expected: error.expected, operator: error.operator }; process.exitCode = 1 }
finally {
  clearTimeout(timer)
  if (instance) { try { const s = await snapshot(), root = s.collaboration.members.find((m) => m.mode === 'root'); report.finalUsage = s.resources.model; if (root) await send({ type: 'agent.stop-family', target: { address: root.address, expectedRevision: root.revision } }) } catch { /* no replay */ } await instance.close().catch(() => {}) }
  await bootstrap?.close().catch(() => {})
  try { unlinkSync(config); report.temporaryCredentialsRemoved = true } catch (error) { report.temporaryCredentialsRemoved = error.code === 'ENOENT' }
  if (!report.temporaryCredentialsRemoved) { report.ok = false; report.cleanupError = 'TEMPORARY_CONFIG_CLEANUP_FAILED'; process.exitCode = 1 }
  report.completedAtIso = new Date().toISOString()
  writeFileSync(join(out, 'report.json'), JSON.stringify(report, null, 2))
  console.log('REAL_REUSE_EVIDENCE', out)
}
