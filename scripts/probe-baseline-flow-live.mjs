import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron } from 'playwright'
import electronPath from 'electron'
import { runtimeEnv, initializeTestBook, electronLaunchTarget } from './runtime-env.mjs'

/**
 * D0 baseline: fixed scenario against the current heart flow with one authorized real-model turn.
 * Requires `pnpm build` first, explicit LCA_REAL_MODEL=1 and an authorized provider file.
 * The scenario uses the same renderer bridge commands as the UI (goal create, flow enter, plan
 * approval, one fixed work message, flow exit). Evidence contains counts, token numbers, hashes and
 * enums only; response text and credentials never enter the report. The temporary profile is deleted.
 */
assert.equal(process.env.LCA_REAL_MODEL, '1', 'Set LCA_REAL_MODEL=1 to allow real provider requests.')
assert.ok(process.env.LCA_PROVIDERS_FILE, 'Set LCA_PROVIDERS_FILE to an authorized provider config.')
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const data = join(root, '.local-data', 'baseline-flow-' + randomUUID())
const reportPath = process.env.LCA_BASELINE_REPORT ?? join(root, 'test-results', 'd0-baseline', `live-flow-${Date.now()}.json`)
const env = { ...runtimeEnv(root), LCA_DATA_DIR: data, LCA_PROVIDERS_FILE: process.env.LCA_PROVIDERS_FILE, LCA_MCP_PORT: '0', LCA_CDP_PORT: '0', LCA_TEST_SILENT: '1' }
const FIXED_PROMPT = '合成基线测试：请只做这一步——用 desk_write 工具在书桌创建 answer.js，内容为 return 42。完成后只回复 COMPLETE，不要调用其他工具。'
const hash = (value) => createHash('sha256').update(value).digest('hex')
const startedAt = Date.now()
const sleep = (ms) => new Promise((done) => setTimeout(done, ms))
let instance
let page
let turnStatus
const snapshot = async () => page ? page.evaluate(() => window.lca.getSnapshot()) : null
const dispatch = async (body) => page.evaluate(async (body) => {
  const state = await window.lca.getSnapshot()
  return window.lca.dispatch({ protocolVersion: 1, epoch: state.epoch, requestId: crypto.randomUUID(), ...body })
}, body)
async function waitFor(test, message, attempts = 2400) {
  for (let index = 0; index < attempts; index++) {
    if (await test(await snapshot())) return
    await sleep(100)
  }
  throw new Error(message)
}
async function journalRows() {
  const found = []
  const walk = async (folder) => {
    let entries
    try { entries = await readdir(folder, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      const path = join(folder, entry.name)
      if (entry.isDirectory()) await walk(path)
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) found.push(path)
    }
  }
  await walk(join(data, 'journals'))
  const rows = []
  for (const file of found) {
    const content = await readFile(file, 'utf8')
    for (const line of content.split(/\r?\n/)) if (line.trim()) { try { rows.push(JSON.parse(line)) } catch { /* Ignore a torn tail; the store already validated the journal. */ } }
  }
  return rows
}
const report = { ok: false, probe: 'baseline-flow-live', realModel: true, syntheticPrompt: true, scenario: 'D0-S0: create goal, enter flow, approve plan, one fixed desk_write work message, exit flow', startedAtIso: new Date(startedAt).toISOString(), engine: 'electron-main+renderer-bridge' }
const flowState = { goalCreated: false, entered: false, planApproved: false, exited: false }
try {
  await mkdir(data, { recursive: true })
  instance = await _electron.launch({ ...electronLaunchTarget(root, electronPath), env, timeout: 30_000 })
  page = await instance.firstWindow()
  await initializeTestBook(page)
  await page.waitForFunction(() => !!window.lca)
  const before = await snapshot()
  assert.ok(before.modelSettings.configuredSlots.includes('chat'), 'CHAT_NOT_CONFIGURED')
  report.providerSlots = before.modelSettings.configuredSlots
  assert.equal((await dispatch({ type: 'flow.goal.set', text: 'D0 baseline synthetic goal' })).status, 'accepted')
  flowState.goalCreated = (await snapshot()).heartFlow.goalId !== undefined
  assert.equal((await dispatch({ type: 'flow.enter' })).status, 'accepted')
  await waitFor((state) => !!state.heartFlow.activeId, 'FLOW_ENTER_FAILED', 300)
  flowState.entered = true
  assert.equal((await dispatch({ type: 'flow.mode', mode: 'execute' })).status, 'accepted')
  flowState.planApproved = (await snapshot()).heartFlow.mode === 'execute'
  assert.equal((await dispatch({ type: 'message.send', text: FIXED_PROMPT })).status, 'accepted')
  try {
    await waitFor((state) => state.task?.status === 'completed' || state.task?.status === 'failed', 'FLOW_TURN_TIMEOUT')
    turnStatus = (await snapshot()).task?.status ?? 'unknown'
  } catch { turnStatus = 'timeout' }
  const afterTurn = await snapshot()
  const deskWriteObserved = (afterTurn.heartFlow?.files ?? []).some((file) => file.path === 'answer.js')
  report.turn = { status: turnStatus, deskWriteObserved, completed: turnStatus === 'completed' }
  try {
    assert.equal((await dispatch({ type: 'flow.exit' })).status, 'accepted')
    await waitFor((state) => !state.heartFlow.activeId, 'FLOW_EXIT_FAILED', 300)
    flowState.exited = true
  } catch { /* The report records the unfinished exit. */ }
  report.flow = flowState
} catch (error) {
  report.error = error instanceof Error ? error.message : 'BASELINE_FLOW_FAILED'
} finally {
  await instance?.close().catch(() => {})
}
try {
  const rows = await journalRows()
  const attempts = rows.filter((row) => row.type === 'model/attempt')
  const successAttempts = attempts.filter((row) => row.status === 'success')
  const seen = rows.filter((row) => row.type === 'model/seen')
  const approvals = {
    plan: rows.filter((row) => row.type === 'flow/mode' && row.mode === 'execute').length,
    run: rows.filter((row) => row.type === 'flow/run' && row.status === 'approved').length,
    command: rows.filter((row) => row.type === 'flow/command' && row.status === 'approved').length,
  }
  approvals.total = approvals.plan + approvals.run + approvals.command
  const requests = seen.map((row) => {
    const messages = Array.isArray(row.messages) ? row.messages : []
    return { messageCount: messages.length, roles: messages.map((message) => message.role), hashes: messages.map((message) => hash(JSON.stringify(message))), eligibleIndexes: Array.isArray(row.eligibleIndexes) ? row.eligibleIndexes.length : 0 }
  })
  let stablePrefix = 0
  if (requests.length > 1) {
    stablePrefix = requests[0].hashes.length
    for (let index = 1; index < requests.length; index++) {
      let common = 0
      while (common < stablePrefix && common < requests[index].hashes.length && requests[0].hashes[common] === requests[index].hashes[common]) common++
      stablePrefix = Math.min(stablePrefix, common)
    }
  }
  const totals = successAttempts.reduce((sum, row) => ({
    inputTokens: sum.inputTokens + (row.inputTokens ?? 0),
    outputTokens: sum.outputTokens + (row.outputTokens ?? 0),
    cachedInputTokens: sum.cachedInputTokens + (row.cachedInputTokens ?? 0),
    uncachedInputTokens: sum.uncachedInputTokens + (row.uncachedInputTokens ?? 0),
  }), { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, uncachedInputTokens: 0 })
  report.attempts = attempts.map((row) => ({ slot: row.slot, status: row.status, inputTokens: row.inputTokens ?? null, outputTokens: row.outputTokens ?? null, cachedInputTokens: row.cachedInputTokens ?? null, uncachedInputTokens: row.uncachedInputTokens ?? null, error: row.error ?? null }))
  report.attemptTotals = totals
  report.approvals = approvals
  report.requests = requests.map((request, index) => ({ index, messageCount: request.messageCount, roles: request.roles, hashes: request.hashes, eligibleIndexes: request.eligibleIndexes }))
  report.cache = { requestCount: requests.length, stablePrefixHashes: stablePrefix, firstRequestCached: successAttempts[0]?.cachedInputTokens ?? null, laterRequestCached: successAttempts.slice(1).map((row) => row.cachedInputTokens ?? null), cacheFieldsObserved: successAttempts.some((row) => row.cachedInputTokens !== undefined) }
  report.journal = {
    rows: rows.length, attempts: attempts.length, requests: seen.length,
    toolCalls: rows.filter((row) => row.type === 'tool/call').map((row) => row.name),
    deskChanges: rows.filter((row) => row.type === 'desk/change').map((row) => row.path),
    userMessages: rows.filter((row) => row.type === 'user/message').length,
    assistantMessages: rows.filter((row) => row.type === 'assistant/message').length,
    flowOpen: rows.filter((row) => row.type === 'flow/open').length,
    flowClose: rows.filter((row) => row.type === 'flow/close').length,
  }
  report.ok = report.turn?.completed === true && report.turn?.deskWriteObserved === true && approvals.total >= 1 && successAttempts.length >= 1 && report.cache.cacheFieldsObserved === true
  report.finishedAtIso = new Date().toISOString()
  report.durationMs = Date.now() - startedAt
  await mkdir(dirname(reportPath), { recursive: true })
  await writeFile(reportPath, JSON.stringify(report, null, 2), { mode: 0o600 })
  console.log(JSON.stringify({ ok: report.ok, report: reportPath, turn: report.turn, flow: report.flow, approvals: report.approvals, attemptTotals: report.attemptTotals, requests: report.cache.requestCount, stablePrefixHashes: report.cache.stablePrefixHashes, toolCalls: report.journal?.toolCalls }))
} finally {
  if (data.startsWith(join(root, '.local-data', 'baseline-flow-'))) await rm(data, { recursive: true, force: true }).catch(() => {})
}
