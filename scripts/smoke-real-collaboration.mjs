// Opt-in real-service selection probe. Only Electron main reads the authorized provider file.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, writeFile, unlink } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { _electron } from 'playwright'
import electronPath from 'electron'
import { runtimeEnv, initializeTestBook, electronLaunchTarget } from '../scripts/runtime-env.mjs'

assert.equal(process.env.LCA_REAL_MODEL, '1', 'REAL_MODEL_OPT_IN_REQUIRED')
assert.ok(process.env.LCA_PROVIDERS_FILE, 'AUTHORIZED_CONFIG_PATH_REQUIRED')
const root = resolve(import.meta.dirname, '..'), id = randomUUID(), data = join(root, '.local-data', 'real-collaboration-' + id), config = join(data, 'probe-providers.json'), out = join(root, 'test-results', 'real-collaboration-' + id)
const env = { ...runtimeEnv(root), LCA_DATA_DIR: data, LCA_PROVIDERS_FILE: config, LCA_MCP_PORT: '0', LCA_CDP_PORT: '0', LCA_TEST_SILENT: '1' }
delete env.LCA_BOOTH; delete env.ELECTRON_RENDERER_URL
const limits = { dailyTotalUnits: 480000, dailyAutonomousUnits: 0 }
const ledgerId = randomUUID(), atMs = Date.now()
await mkdir(join(data, 'runtime-resources'), { recursive: true }); await mkdir(out, { recursive: true })
await writeFile(join(data, 'runtime-resources/identity.json'), JSON.stringify({ id: ledgerId }))
await writeFile(join(data, 'runtime-resources/usage.jsonl'), [{ version: 1, seq: 1, atMs, kind: 'header', id: ledgerId }, { version: 1, seq: 2, atMs, kind: 'limits', ...limits }].map((x) => JSON.stringify(x)).join('\n') + '\n')
let instance, page, timer
const preflight = process.argv.includes('--preflight')
const cases = [], report = { realServices: !preflight, preflight, syntheticTaskInputs: true, cases, limits, maxWallMinutes: 12, capacityStress: 'synthetic-regression-only', selectedModel: 'existing-chat-and-work-slots', automaticApprovals: false }
const snapshot = () => page.evaluate(() => window.lca.getSnapshot())
const send = (body) => page.evaluate(async (body) => { const s = await window.lca.getSnapshot(); return window.lca.dispatch({ protocolVersion: 1, epoch: s.epoch, requestId: crypto.randomUUID(), ...body }) }, body)
async function launch() { instance = await _electron.launch({ ...electronLaunchTarget(root, electronPath), env, timeout: 30000 }); page = await instance.firstWindow(); await initializeTestBook(page); await send({ type: 'mode.set', mode: 'quiet' }) }
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
try {
  report.stage = 'bootstrap'
  await launch()
  // Copy only the already-selected model slots inside main; no credentials/URLs/models cross to the runner.
  report.stage = 'main-filtered-config'
  await instance.evaluate(async (_, { authorized, config }) => {
    const fs = process.mainModule.require('node:fs').promises
    const parsed = JSON.parse(await fs.readFile(authorized, 'utf8'))
    if (!parsed.providers?.chat) throw new Error('AUTHORIZED_CHAT_MISSING')
    await fs.writeFile(config, JSON.stringify({ providers: { chat: parsed.providers.chat, ...(parsed.providers.work ? { work: parsed.providers.work } : {}) } }), { mode: 0o600 })
  }, { authorized: resolve(process.env.LCA_PROVIDERS_FILE), config })
  report.stage = 'configured-launch'
  await instance.close(); instance = null; await launch()
  assert.equal((await snapshot()).runtime.developer.mode, 'normal'); assert.ok((await snapshot()).modelSettings.configuredSlots.includes('chat'))
  timer = setTimeout(() => { void instance?.close().catch(() => {}) }, 12 * 60000)
  for (const [name, text] of preflight ? [] : prompts) {
    report.stage = name
    const before = await snapshot(), old = new Set(before.collaboration.members.map((m) => m.address.sessionId))
    assert.equal((await send({ type: 'message.send', text })).status, 'accepted')
    const after = await settle(before.task?.id), added = after.collaboration.members.filter((m) => m.mode !== 'root' && !old.has(m.address.sessionId))
    const result = { name, addedModes: added.map((m) => m.mode), memberCount: after.collaboration.members.length, teamTasks: after.collaboration.tasks.length, dependentTasks: after.collaboration.tasks.filter((t) => t.blockedBy.length > 0).length, completedTasks: after.collaboration.tasks.filter((t) => t.status === 'completed').length, attempts: after.resources.model.attemptCount - before.resources.model.attemptCount, reservedUnits: after.resources.model.totalReservedUnits }
    result.selectionPassed = name === 'independent' ? added.some((m) => ['subagent', 'fork'].includes(m.mode) && m.usage.admittedUnits > 0) && !added.some((m) => m.mode === 'teammate') : name === 'team' ? added.filter((m) => m.mode === 'teammate').length === 2 && added.filter((m) => m.mode === 'teammate').every((m) => m.usage.admittedUnits > 0) && result.completedTasks >= 2 && result.dependentTasks > 0 : added.length === 0 && after.collaboration.members.some((m) => m.mode === 'teammate' && m.usage.admittedUnits > (before.collaboration.members.find((b) => b.address.sessionId === m.address.sessionId)?.usage.admittedUnits ?? 0))
    cases.push(result); console.log(JSON.stringify(result))
    if (!result.selectionPassed) throw new Error('MODEL_SELECTION_EXPECTATION_FAILED')
  }
  report.ok = true
  report.stage = 'completed'
} catch (error) { report.ok = false; report.error = /^[A-Z_]+$/.test(error.message) ? error.message : 'REAL_COLLABORATION_FAILED'; process.exitCode = 1 }
finally {
  clearTimeout(timer)
  if (instance) { try { const s = await snapshot(), member = s.collaboration.members.find((m) => m.mode === 'root'); if (member) await send({ type: 'agent.stop-family', target: { address: member.address, expectedRevision: member.revision } }) } catch { /* Closing main also closes its host; do not retry an unknown action. */ }; await instance.close().catch(() => {}) }
  // Only remove the known temporary credential file, never the authorized source or the evidence.
  await unlink(config).catch(() => {})
  await writeFile(join(out, 'report.json'), JSON.stringify(report, null, 2)); console.log('REAL_COLLABORATION_EVIDENCE', out)
}
