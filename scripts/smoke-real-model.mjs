import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron } from 'playwright'
import electronPath from 'electron'
import { runtimeEnv, initializeTestBook, electronLaunchTarget } from './runtime-env.mjs'

/**
 * Opt-in real-model UI smoke. The desktop window stays transparent/inactive.
 * Requires LCA_REAL_MODEL=1 and LCA_PROVIDERS_FILE pointing at an authorized config.
 * Output contains only booleans and counts; assistant text and credentials are never printed.
 */
assert.equal(process.env.LCA_REAL_MODEL, '1', 'Set LCA_REAL_MODEL=1 to allow provider requests.')
assert.ok(process.env.LCA_PROVIDERS_FILE, 'Set LCA_PROVIDERS_FILE to an authorized provider config.')
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const data = join(root, '.local-data', `real-model-ui-${randomUUID()}`)
const env = {
  ...runtimeEnv(root),
  LCA_DATA_DIR: data,
  LCA_PROVIDERS_FILE: process.env.LCA_PROVIDERS_FILE,
  LCA_MCP_PORT: '0',
  LCA_CDP_PORT: '0',
  LCA_TEST_SILENT: '1',
}
let instance
const snapshot = async (page) => page.evaluate(() => window.lca.getSnapshot())
async function waitFor(test, message, attempts = 900) {
  for (let i = 0; i < attempts; i++) {
    if (await test()) return
    await new Promise((done) => setTimeout(done, 100))
  }
  throw new Error(message)
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
  await input.fill('这是自动测试。请只回复 OK，不要调用工具。')
  await page.getByRole('button', { name: '发送', exact: true }).click()
  await waitFor(async () => {
    const current = await snapshot(page)
    return current.task?.status === 'completed' && current.messages.slice(beforeMessages).some((message) => message.role === 'assistant' && message.status === 'complete' && message.text.trim())
  }, 'REAL_MODEL_UI_REPLY_TIMEOUT')
  const after = await snapshot(page)
  const reply = after.messages.slice(beforeMessages).find((message) => message.role === 'assistant' && message.status === 'complete' && message.text.trim())
  assert.ok(reply, 'REAL_MODEL_UI_REPLY_MISSING')
  assert.ok(!reply.failure, 'REAL_MODEL_UI_FAILED')
  console.log(JSON.stringify({
    ok: true,
    probe: 'real-model-ui',
    realModel: true,
    silentWindows: true,
    configuredChatSlot: true,
    assistantReply: true,
    replyChars: [...reply.text].length,
    tempProfile: true,
  }))
} finally {
  await instance?.close().catch(() => {})
  if (data.startsWith(join(root, '.local-data', 'real-model-ui-'))) await rm(data, { recursive: true, force: true }).catch(() => {})
}
