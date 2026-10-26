// Opt-in real-service selection probe. Only Electron main reads the authorized provider file.
import assert from 'node:assert/strict'
import { randomUUID, createHash } from 'node:crypto'
import { mkdir, readFile, writeFile, unlink } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { _electron } from 'playwright'
import electronPath from 'electron'
import { runtimeEnv, initializeTestBook, electronLaunchTarget } from '../scripts/runtime-env.mjs'

assert.equal(process.env.LCA_REAL_MODEL, '1', 'REAL_MODEL_OPT_IN_REQUIRED')
assert.ok(process.env.LCA_PROVIDERS_FILE, 'AUTHORIZED_CONFIG_PATH_REQUIRED')
const root = resolve(import.meta.dirname, '..'), id = randomUUID(), data = join(root, '.local-data', 'real-collaboration-' + id), config = join(data, 'probe-providers.json'), out = join(root, 'test-results', 'real-collaboration-' + id)
const user = join(data, 'user')
const env = { ...runtimeEnv(root), LCA_DATA_DIR: data, LCA_PROVIDERS_FILE: config, LCA_MCP_PORT: '0', LCA_CDP_PORT: '0', LCA_TEST_SILENT: '1',
  HOME: user, USERPROFILE: user, APPDATA: join(user, 'AppData/Roaming'), LOCALAPPDATA: join(user, 'AppData/Local') }
delete env.LCA_BOOTH; delete env.ELECTRON_RENDERER_URL
// An override represents a separately authorized run, never an automatic retry/reset.
const authorizedUnits = Number(process.env.LCA_REAL_MODEL_BUDGET_UNITS ?? '480000')
assert.ok(Number.isSafeInteger(authorizedUnits) && authorizedUnits >= 10000 && authorizedUnits <= 20000000, 'REAL_MODEL_BUDGET_INVALID')
const limits = { dailyTotalUnits: authorizedUnits, dailyAutonomousUnits: 0 }
const ledgerId = randomUUID(), atMs = Date.now()
await mkdir(join(data, 'runtime-resources'), { recursive: true }); await mkdir(out, { recursive: true })
for (const dir of [join(user, 'Documents'), join(user, 'Desktop'), join(user, 'Downloads'), env.APPDATA, env.LOCALAPPDATA]) await mkdir(dir, { recursive: true })
await writeFile(join(data, 'runtime-resources/identity.json'), JSON.stringify({ id: ledgerId }))
await writeFile(join(data, 'runtime-resources/usage.jsonl'), [{ version: 1, seq: 1, atMs, kind: 'header', id: ledgerId }, { version: 1, seq: 2, atMs, kind: 'limits', ...limits }].map((x) => JSON.stringify(x)).join('\n') + '\n')
let instance, page, timer
const preflight = process.argv.includes('--preflight')
const stateRouting = process.argv.includes('--state-routing')
const workOnly = process.argv.includes('--work-only')
const hash = async (path) => createHash('sha256').update(await readFile(path)).digest('hex')
const cases = [], report = { realServices: !preflight, preflight, syntheticTaskInputs: true, homeIsolated: true, cases, limits, maxWallMinutes: 12, capacityStress: 'synthetic-regression-only', selectedModel: 'existing-chat-and-work-slots', automaticApprovals: false,
  stateRouting, workOnly, precedingRun: process.env.LCA_REAL_MODEL_PRECEDING_RUN ?? null,
  scriptSha256: await hash(import.meta.filename), targetHelperSha256: await hash(join(root, 'scripts/runtime-env.mjs')) }
const memberEvidence = (s) => s.collaboration.members.map((m) => ({ sessionId: m.address.sessionId, mode: m.mode, name: m.name, activity: m.activity, outcome: m.outcome, waitingFor: m.waitingFor, usage: m.usage, errorCode: m.error?.code ?? null, resultText: m.resultText?.slice(0, 3000) ?? null }))
console.log('REAL_COLLABORATION_START', out)
const snapshot = () => page.evaluate(() => window.lca.getSnapshot())
const send = (body) => page.evaluate(async (body) => { const s = await window.lca.getSnapshot(); return window.lca.dispatch({ protocolVersion: 1, epoch: s.epoch, requestId: crypto.randomUUID(), ...body }) }, body)
async function launch() { instance = await _electron.launch({ ...electronLaunchTarget(root, electronPath), env, timeout: 30000 }); page = await instance.firstWindow(); await initializeTestBook(page); await send({ type: 'mode.set', mode: workOnly ? 'work' : 'quiet' }) }
async function settle(previous) {
  for (let i = 0; i < 1800; i++) {
    const s = await snapshot()
    if (s.question) throw new Error('INTERACTION_REQUIRED_NO_AUTO_APPROVAL')
    if (s.resources.model.totalReservedUnits > limits.dailyTotalUnits) throw new Error('BUDGET_BOUNDARY_FAILED')
    const idle = s.collaboration.members.every((m) => !['starting', 'running', 'waiting', 'stopping'].includes(m.activity))
    if (s.task?.id !== previous && ['failed', 'aborted'].includes(s.task?.status)) throw new Error('TURN_FAILED')
    if (s.task?.id !== previous && s.task?.status === 'completed' && idle) return s
    await new Promise((done) => setTimeout(done, 100))
  }
  throw new Error('CASE_TIMEOUT')
}
const prompts = [
  ['independent', '这是一个隔离验收任务。请找一位帮手做一次独立校验：清单为红3、蓝2、红4，分别合计红和蓝，再给出总数。工作一次交付即可，不需要固定角色或共同任务板。你负责整合它的实际结果。不要浏览网络、读写文件或执行命令。'],
  ['team', '继续隔离验收。现在需要两位固定职责的协作者持续配合：规则员定义小型验收规则，复核员等待规则再按规则检查。用共同任务板表达领取和依赖，让双方按职责完成后向你汇报。输入只有：甲=2、乙=3，总和应为5。不要浏览网络、读写文件或执行命令；无需再派独立的一次性帮手。'],
  ['reuse', '沿用刚才负责规则的同一位协作者，补充检查甲=4、乙=1是否仍符合规则，让它实际回复后你再总结。不要创建新成员或新身份，不要浏览网络、读写文件或执行命令。'],
]
if (stateRouting) {
  prompts.unshift(['handoff', '这是隔离验收的第一步。请先把门牌切换到“工作中”，交给工作模型在同一个回合里调用一次当前时间工具，最后告诉我本地几点。用程序提供的状态指令完成切换，不要只口头说开始。不要找帮手、浏览网络、读写文件或执行命令。'])
  // This authorization covers handoff, one ordinary delegation and one small team, not identity reuse.
  prompts.splice(prompts.findIndex(([name]) => name === 'reuse'), 1)
}
if (workOnly) { assert.ok(stateRouting, 'WORK_ONLY_REQUIRES_STATE_ROUTING'); prompts.splice(prompts.findIndex(([name]) => name === 'handoff'), 1) }
try {
  report.stage = 'bootstrap'
  await launch()
  // Copy only the already-selected model slots inside main; no credentials/URLs/models cross to the runner.
  report.stage = 'main-filtered-config'
  const selected = await instance.evaluate(async (_, { authorized, config }) => {
    const fs = process.mainModule.require('node:fs').promises
    const parsed = JSON.parse(await fs.readFile(authorized, 'utf8'))
    if (!parsed.providers?.chat) throw new Error('AUTHORIZED_CHAT_MISSING')
    const workRouting = parsed.routing?.work ?? (Object.hasOwn(parsed.providers, 'work') ? 'independent' : 'follow-main')
    const efforts = Object.fromEntries(['chat', 'work'].filter((role) => Object.hasOwn(parsed.efforts ?? {}, role)).map((role) => [role, parsed.efforts[role]]))
    await fs.writeFile(config, JSON.stringify({ providers: { chat: parsed.providers.chat, ...(parsed.providers.work ? { work: parsed.providers.work } : {}) }, routing: { work: workRouting }, efforts, ...(parsed.modelCapabilities ? { modelCapabilities: parsed.modelCapabilities } : {}) }), { mode: 0o600 })
    return { workRouting, efforts, independentWorkPresent: !!parsed.providers.work, officialWorkEndpoint: !!parsed.providers.work && new URL(parsed.providers.work.base_url).hostname === 'api.deepseek.com' }
  }, { authorized: resolve(process.env.LCA_PROVIDERS_FILE), config })
  report.stage = 'configured-launch'
  await instance.close(); instance = null; await launch()
  const initial = await snapshot()
  assert.equal(initial.runtime.developer.mode, 'normal'); assert.ok(initial.modelSettings.configuredSlots.includes('chat'))
  assert.equal(initial.modelSettings.routing.work, selected.workRouting); assert.deepEqual(initial.modelSettings.efforts, selected.efforts)
  assert.equal(initial.resources.status, 'ready'); assert.equal(initial.resources.model.totalLimitUnits, limits.dailyTotalUnits); assert.equal(initial.resources.model.autonomousLimitUnits, 0)
  report.configurationSelectionPreserved = true
  report.workConfiguration = { independent: selected.workRouting === 'independent' && selected.independentWorkPresent, officialDeepSeekEndpoint: selected.officialWorkEndpoint }
  if (stateRouting) assert.ok(report.workConfiguration.independent && report.workConfiguration.officialDeepSeekEndpoint, 'OFFICIAL_WORK_CONFIGURATION_REQUIRED')
  report.target = { executable: electronLaunchTarget(root, electronPath).executablePath, appVersion: await instance.evaluate(({ app }) => app.getVersion()), asarSha256: process.env.LCA_TEST_EXECUTABLE ? await hash(join(dirname(process.env.LCA_TEST_EXECUTABLE), 'resources/app.asar')) : null }
  report.startedAtIso = new Date().toISOString()
  timer = setTimeout(() => { report.timedOut = true; void instance?.close().catch(() => {}) }, 12 * 60000)
  for (const [name, text] of preflight ? [] : prompts) {
    report.stage = name
    console.log('REAL_COLLABORATION_CASE', name)
    const before = await snapshot(), old = new Set(before.collaboration.members.map((m) => m.address.sessionId))
    assert.equal((await send({ type: 'message.send', text })).status, 'accepted')
    const after = await settle(before.task?.id), added = after.collaboration.members.filter((m) => m.mode !== 'root' && !old.has(m.address.sessionId))
    const oldMessages = new Set(before.messages.map((m) => m.id))
    const result = { name, addedModes: added.map((m) => m.mode), memberCount: after.collaboration.members.length, teamTasks: after.collaboration.tasks.length, dependentTasks: after.collaboration.tasks.filter((t) => t.blockedBy.length > 0).length, completedTasks: after.collaboration.tasks.filter((t) => t.status === 'completed').length, attempts: after.resources.model.attemptCount - before.resources.model.attemptCount, reservedUnits: after.resources.model.totalReservedUnits,
      mode: after.companion.mode,
      activities: after.activities.filter((a) => a.taskId === after.task?.id).map((a) => ({ templateId: a.templateId, status: a.status })),
      members: memberEvidence(after), tasks: after.collaboration.tasks, responses: after.messages.filter((m) => m.role === 'assistant' && !oldMessages.has(m.id)).map((m) => m.text.slice(0, 3000)),
      resumedSessionIds: after.collaboration.members.filter((m) => m.mode === 'teammate' && old.has(m.address.sessionId) && m.usage.admittedUnits > (before.collaboration.members.find((b) => b.address.sessionId === m.address.sessionId)?.usage.admittedUnits ?? 0)).map((m) => m.address.sessionId) }
    if (stateRouting) {
      // Narrow, synthetic-run-only evidence. Never return private context, raw tool inputs or credentials.
      result.routeEvidence = await instance.evaluate(async (_, taskId) => {
        const fs = process.mainModule.require('node:fs'), path = process.mainModule.require('node:path')
        const dir = path.join(process.env.LCA_DATA_DIR, 'journals')
        const files = []
        const visit = (root) => { if (!fs.existsSync(root)) return; for (const entry of fs.readdirSync(root, { withFileTypes: true })) { const item = path.join(root, entry.name); if (entry.isDirectory()) visit(item); else if (entry.name.endsWith('.jsonl')) files.push(item) } }
        visit(dir)
        const rows = files.flatMap((file) => fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)))
        return { attempts: rows.filter((r) => r.type === 'model/attempt' && r.turnId === taskId).map((r) => ({ slot: r.slot, status: r.status, attempt: r.attempt })),
          modeChanges: rows.filter((r) => r.type === 'companion/mode' && r.requestId?.startsWith('model-state-' + taskId)).map((r) => ({ mode: r.mode, seq: r.seq })),
          sessions: rows.filter((r) => r.type === 'work/turn' && r.turnId === taskId).map((r) => r.sessionId) }
      }, after.task?.id)
    }
    result.selectionPassed = name === 'handoff' ? result.mode === 'work' && result.routeEvidence.modeChanges.some((r) => r.mode === 'work') && result.routeEvidence.sessions.length === 1 && ['chat', 'work'].every((slot) => result.routeEvidence.attempts.some((r) => r.slot === slot && r.status === 'success')) && result.activities.some((a) => a.templateId === 'clock.read' && a.status === 'completed') && added.length === 0
      : name === 'independent' ? added.some((m) => ['subagent', 'fork'].includes(m.mode) && m.usage.admittedUnits > 0 && m.outcome === 'completed') && !added.some((m) => m.mode === 'teammate') : name === 'team' ? added.filter((m) => m.mode === 'teammate').length === 2 && added.filter((m) => m.mode === 'teammate').every((m) => m.usage.admittedUnits > 0 && m.outcome === 'completed') && result.completedTasks >= 2 && result.dependentTasks > 0 : added.length === 0 && result.resumedSessionIds.length > 0 && after.collaboration.members.filter((m) => result.resumedSessionIds.includes(m.address.sessionId)).every((m) => m.outcome === 'completed')
    cases.push(result); console.log(JSON.stringify(result))
    if (!result.selectionPassed) throw new Error('MODEL_SELECTION_EXPECTATION_FAILED')
  }
  report.ok = true
  report.stage = 'completed'
} catch (error) { report.ok = false; report.error = /^[A-Z_]+$/.test(error.message) ? error.message : 'REAL_COLLABORATION_FAILED'; process.exitCode = 1 }
finally {
  clearTimeout(timer)
  if (instance) { try { const s = await snapshot(), member = s.collaboration.members.find((m) => m.mode === 'root'); report.finalState = { taskStatus: s.task?.status ?? null, errorCode: s.task?.error?.code ?? null, questionPending: !!s.question, members: memberEvidence(s), usage: s.resources.model }; if (member) await send({ type: 'agent.stop-family', target: { address: member.address, expectedRevision: member.revision } }) } catch { /* Closing main also closes its host; do not retry an unknown action. */ }; await instance.close().catch(() => {}) }
  // Only remove the known temporary credential file, never the authorized source or the evidence.
  try { await unlink(config); report.temporaryCredentialsRemoved = true } catch (error) { report.temporaryCredentialsRemoved = error.code === 'ENOENT'; if (!report.temporaryCredentialsRemoved) { report.ok = false; report.cleanupError = 'TEMPORARY_CONFIG_CLEANUP_FAILED'; process.exitCode = 1 } }
  report.completedAtIso = new Date().toISOString()
  await writeFile(join(out, 'report.json'), JSON.stringify(report, null, 2)); console.log('REAL_COLLABORATION_EVIDENCE', out)
}
