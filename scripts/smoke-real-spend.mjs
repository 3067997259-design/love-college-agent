import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron } from 'playwright'
import electronPath from 'electron'
import { runtimeEnv, initializeTestBook, electronLaunchTarget } from './runtime-env.mjs'

/**
 * Opt-in real-provider spending acceptance. Requires LCA_REAL_MODEL=1 and LCA_PROVIDERS_FILE
 * pointing at the user's own authorized provider config (for example the profile's
 * connections/providers.json). It makes one bounded chat request through the normal product path,
 * then reads LCA's own journal to prove the resource ledger recorded the spend.
 * Output contains booleans and counts only: assistant text, prompts and credentials never print.
 */
assert.equal(process.env.LCA_REAL_MODEL, '1', 'Set LCA_REAL_MODEL=1 to allow provider requests.')
assert.ok(process.env.LCA_PROVIDERS_FILE, 'Set LCA_PROVIDERS_FILE to an authorized provider config.')
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const data = join(root, '.local-data', `real-spend-${randomUUID()}`)
const env = { ...runtimeEnv(root), LCA_DATA_DIR: data, LCA_PROVIDERS_FILE: process.env.LCA_PROVIDERS_FILE, LCA_MCP_PORT: '0', LCA_CDP_PORT: '0', LCA_TEST_SILENT: '1' }
let instance
const snapshot = async (page) => page.evaluate(() => window.lca.getSnapshot())
async function waitFor(test, message, attempts = 1800) {
  for (let i = 0; i < attempts; i++) {
    if (await test()) return
    await new Promise((done) => setTimeout(done, 100))
  }
  throw new Error(message)
}
async function journalRows() {
  const rows = []
  for (const owner of await readdir(join(data, 'journals'))) for (const file of await readdir(join(data, 'journals', owner))) {
    if (!file.endsWith('.jsonl')) continue
    for (const line of (await readFile(join(data, 'journals', owner, file), 'utf8')).split('\n')) {
      if (!line.trim()) continue
      try { rows.push(JSON.parse(line)) } catch { /* an unreadable tail line is not evidence */ }
    }
  }
  return rows
}
try {
  await mkdir(data, { recursive: true })
  instance = await _electron.launch({ ...electronLaunchTarget(root, electronPath), env, timeout: 30_000 })
  const page = await instance.firstWindow()
  await initializeTestBook(page)
  await page.locator('[data-mode][data-pose]').waitFor()
  const before = await snapshot(page)
  assert.equal(before.runtime.developer.mode, 'normal')
  assert.ok(before.modelSettings.configuredSlots.includes('chat'), 'CHAT_NOT_CONFIGURED')
  const beforeMessages = before.messages.length
  const input = page.locator('.composer-input')
  await input.fill('这是自动验收。用一两句话回我就好：今天有点累，什么都不想做。不要调用工具。')
  await page.getByRole('button', { name: '发送', exact: true }).click()
  await waitFor(async () => {
    const current = await snapshot(page)
    return current.task?.status === 'completed' && current.messages.slice(beforeMessages).some((message) => message.role === 'assistant' && message.status === 'complete' && message.text.trim())
  }, 'REAL_SPEND_REPLY_TIMEOUT')
  const after = await snapshot(page)
  const reply = after.messages.slice(beforeMessages).find((message) => message.role === 'assistant' && message.status === 'complete' && message.text.trim())
  assert.ok(reply, 'REAL_SPEND_REPLY_MISSING')
  assert.ok(!reply.failure, 'REAL_SPEND_FAILED')
  const rows = await journalRows()
  const attempts = rows.filter((row) => row.type === 'model/attempt' && row.status === 'started')
  const successes = rows.filter((row) => row.type === 'model/attempt' && row.status === 'success')
  const reserved = attempts.reduce((sum, row) => sum + (Number.isSafeInteger(row.reservedTokens) ? row.reservedTokens : 0), 0)
  const usage = successes.reduce((sum, row) => sum + (row.inputTokens ?? 0) + (row.outputTokens ?? 0), 0)
  const ledger = after.resources?.model ?? null
  assert.ok(attempts.length >= 1, 'REAL_SPEND_ATTEMPT_NOT_RECORDED')
  assert.ok(reserved > 0, 'REAL_SPEND_RESERVATION_NOT_RECORDED')
  if (ledger) assert.ok(ledger.totalReservedUnits >= reserved, 'REAL_SPEND_LEDGER_BEHIND')
  const report = {
    ok: true,
    probe: 'real-spend',
    realModel: true,
    silentWindows: true,
    tempProfile: true,
    configuredChatSlot: true,
    assistantReply: true,
    replyChars: [...reply.text].length,
    replyMentionsControlProtocol: reply.text.includes('lca_state'),
    modelAttempts: attempts.length,
    modelSuccesses: successes.length,
    reservedUnits: reserved,
    reportedTokens: usage,
    ledgerTotalReservedUnits: ledger?.totalReservedUnits ?? null,
    ledgerAutonomousReservedUnits: ledger?.autonomousReservedUnits ?? null,
  }
  console.log(JSON.stringify(report))
  instance = (await instance.close().catch(() => {}), undefined)
  await rm(data, { recursive: true, force: true })
} finally {
  await instance?.close().catch(() => {})
}
