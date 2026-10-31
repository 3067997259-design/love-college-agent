// Complete book/main/DSH path with loopback HTTP and synthetic credentials only.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { join, resolve } from 'node:path'
import { _electron } from 'playwright'
import electronPath from 'electron'
import { runtimeEnv, electronLaunchTarget, initializeTestBook, openSettings, closeSettings } from './runtime-env.mjs'

const root = resolve(import.meta.dirname, '..'), data = join(root, 'test-results', 'model-capabilities-' + randomUUID()), user = join(data, 'user')
for (const name of ['Documents', 'Desktop', 'Downloads', 'AppData/Roaming', 'AppData/Local']) mkdirSync(join(user, name), { recursive: true })
const requests = [], checks = []
const textOf = (c) => typeof c === 'string' ? c : (c ?? []).filter((b) => b.type === 'text').map((b) => b.text ?? '').join('')
const frame = (delta, finish_reason) => `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason }] })}\n\n`
const server = createServer(async (req, res) => {
  let body = ''; for await (const part of req) body += part
  const input = JSON.parse(body), messages = input.messages ?? []
  const marker = messages.findLastIndex((m) => m.role === 'user' && /caps-wire:[a-z-]+/.test(textOf(m.content)))
  const task = textOf(messages[marker]?.content).match(/caps-wire:[a-z-]+/)?.[0] ?? 'unexpected'
  const imageCount = messages.flatMap((m) => Array.isArray(m.content) ? m.content : []).filter((b) => b.type === 'image_url').length
  requests.push({ task, model: input.model, outputLimit: input.max_completion_tokens ?? input.max_tokens, reasoning: input.reasoning_effort ?? null, imageCount })
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  const toolSeen = messages.slice(marker + 1).some((m) => m.role === 'tool')
  if (task.includes('image') && !toolSeen) res.end(frame({ tool_calls: [{ index: 0, id: 'image-' + requests.length, type: 'function', function: { name: 'read_image', arguments: '{"file_path":"capability.png"}' } }] }, 'tool_calls') + 'data: [DONE]\n\n')
  else res.end(frame({ content: task + ' done' }, 'stop') + 'data: [DONE]\n\n')
})
await new Promise((done) => server.listen(0, '127.0.0.1', done))
const env = { ...runtimeEnv(root), LCA_DATA_DIR: data, LCA_PROVIDERS_FILE: join(data, 'absent.json'), LCA_MCP_PORT: '0', LCA_CDP_PORT: '0', LCA_TEST_SILENT: '1',
  HOME: user, USERPROFILE: user, APPDATA: join(user, 'AppData/Roaming'), LOCALAPPDATA: join(user, 'AppData/Local') }
delete env.LCA_BOOTH; delete env.ELECTRON_RENDERER_URL
let instance, page
const snapshot = () => page.evaluate(() => window.lca.getSnapshot())
const dispatch = (body) => page.evaluate(async (body) => { const s = await window.lca.getSnapshot(); return window.lca.dispatch({ protocolVersion: 1, epoch: s.epoch, requestId: crypto.randomUUID(), ...body }) }, body)
const wait = async (test, label) => { for (let i = 0; i < 450; i++) { const s = await snapshot(); if (test(s)) return s; await new Promise((r) => setTimeout(r, 100)) } throw Error(label) }
const card = () => page.locator('.provider-card[data-slot="chat"]')
const caps = () => card().locator('.model-capabilities')
const start = async () => { instance = await _electron.launch({ ...electronLaunchTarget(root, electronPath), env, timeout: 30000 }); page = await instance.firstWindow(); page.setDefaultTimeout(30000); await initializeTestBook(page) }
const expand = async () => { if (!await caps().evaluate((e) => e.open)) await caps().locator('summary').click() }
const setEfforts = async (value = 'medium') => {
  for (const role of ['chat', 'work']) { await page.locator(`.provider-card[data-slot="${role}"]`).getByLabel('思考强度', { exact: true }).selectOption(value); await wait((s) => s.modelSettings.efforts[role] === value, 'EFFORT_NOT_SAVED') }
}
const sendTask = async (task) => {
  const previous = (await snapshot()).task?.id
  assert.equal((await dispatch({ type: 'message.send', text: task + (task.includes('image') ? ' 请读取 capability.png。' : '') })).status, 'accepted')
  const settled = await wait((s) => s.task?.id !== previous && ['completed', 'failed', 'aborted'].includes(s.task?.status), 'TASK_NOT_SETTLED_' + task)
  assert.equal(settled.task.status, 'completed', 'TASK_FAILED_' + task)
  return settled
}
try {
  await start(); await openSettings(page)
  await card().getByLabel('接口地址', { exact: true }).fill(`http://127.0.0.1:${server.address().port}/v1`)
  await card().getByLabel('模型', { exact: true }).fill('caps-model-a')
  await card().getByLabel('API 密钥', { exact: true }).fill('only-synthetic-capability-key')
  await card().getByRole('button', { name: '保存', exact: true }).click()
  await wait((s) => s.modelSettings.details?.chat?.model === 'caps-model-a', 'PROVIDER_NOT_SAVED')
  for (const slot of ['background', 'privacy']) { assert.equal((await dispatch({ type: 'models.routing.set', slot, mode: 'independent' })).status, 'accepted'); await wait((s) => s.modelSettings.routing[slot] === 'independent' && s.modelSettings.status === 'saved', 'ROUTING_NOT_SAVED') }
  await wait((s) => s.modelSettings.levels !== undefined, 'METADATA_NOT_READY')
  assert.equal(requests.length, 0)
  await expand()
  await caps().getByLabel('上下文窗口（token）', { exact: true }).fill('65536')
  await caps().getByLabel('最大输出 token 数', { exact: true }).fill('512')
  await caps().getByLabel('输入类型', { exact: true }).selectOption('images')
  await caps().getByLabel('思考能力', { exact: true }).selectOption('levels')
  await caps().getByLabel('API 参数值 1', { exact: true }).fill('vendor_medium')
  await caps().getByRole('button', { name: '添加档位', exact: true }).click()
  await caps().getByRole('button', { name: '保存能力声明', exact: true }).click()
  await wait((s) => s.modelSettings.status === 'saved' && s.modelSettings.details.chat.capabilities.resolved?.maxOutputTokens === 512, 'CAPABILITIES_NOT_APPLIED')
  const info = (await snapshot()).modelSettings.details.chat.capabilities
  assert.deepEqual(info.declared, { contextWindow: 65536, maxOutputTokens: 512, inputModalities: ['text', 'image'], reasoning: { off: null, medium: 'vendor_medium' } })
  assert.equal(info.resolved.contextWindow, 65536); assert.deepEqual(info.resolved.inputModalities, ['text', 'image'])
  assert.equal(requests.length, 0)
  await setEfforts(); await page.screenshot({ path: join(data, 'manual-capabilities.png') })
  checks.push('saved declaration reported separately from actual DSH metadata without a probe')
  await instance.evaluate(() => {
    const fs = process.mainModule.require('node:fs'), path = process.mainModule.require('node:path'), rooms = path.join(process.env.LCA_DATA_DIR, 'rooms')
    const owner = fs.readdirSync(rooms).find((name) => /^[a-f0-9]{64}$/.test(name))
    if (!owner) throw Error('TEST_ROOM_MISSING')
    const { nativeImage } = process.mainModule.require('electron')
    fs.writeFileSync(path.join(rooms, owner, '书桌', 'capability.png'), nativeImage.createFromBitmap(Buffer.from([255, 255, 255, 255]), { width: 1, height: 1 }).toPNG())
  })
  assert.equal((await dispatch({ type: 'mode.set', mode: 'work' })).status, 'accepted')
  await closeSettings(page)
  await sendTask('caps-wire:text')
  assert.equal(requests.at(-1).reasoning, 'vendor_medium'); assert.equal(requests.at(-1).outputLimit, 512)
  checks.push('actual HTTP reasoning value mapped and output bounded')
  await openSettings(page); await setEfforts('off'); await closeSettings(page)
  await sendTask('caps-wire:off-omitted'); assert.equal(requests.at(-1).reasoning, null)
  await openSettings(page); await expand()
  const offIndex = await caps().locator('.capability-level select').evaluateAll((elements) => elements.findIndex((e) => e.value === 'off'))
  assert.ok(offIndex >= 0)
  await caps().getByLabel(`API 参数值 ${offIndex + 1}`, { exact: true }).fill('vendor_off')
  await caps().getByRole('button', { name: '保存能力声明', exact: true }).click()
  await wait((s) => s.modelSettings.status === 'saved' && s.modelSettings.details.chat.capabilities.declared?.reasoning?.off === 'vendor_off', 'OFF_MAPPING_NOT_APPLIED')
  await closeSettings(page); await sendTask('caps-wire:off-mapped'); assert.equal(requests.at(-1).reasoning, 'vendor_off')
  checks.push('off can omit the parameter or send the explicitly declared API value')
  await openSettings(page); await setEfforts(); await closeSettings(page)
  await sendTask('caps-wire:image')
  assert.ok(requests.filter((r) => r.task === 'caps-wire:image').some((r) => r.imageCount > 0))
  checks.push('declared image capability reaches a real multimodal HTTP request')
  await openSettings(page); await expand(); await caps().getByLabel('输入类型', { exact: true }).selectOption('text')
  await caps().getByRole('button', { name: '保存能力声明', exact: true }).click()
  await wait((s) => s.modelSettings.status === 'saved' && s.modelSettings.details.chat.capabilities.declared.inputModalities.join() === 'text', 'TEXT_ONLY_NOT_SAVED')
  await closeSettings(page); const denied = await sendTask('caps-wire:image-denied')
  assert.ok(denied.activities.some((a) => a.taskId === denied.task.id && a.templateId === 'dsh.read' && a.status === 'failed'))
  assert.ok(requests.filter((r) => r.task === 'caps-wire:image-denied').every((r) => r.imageCount === 0))
  checks.push('text-only declaration rejects image tool locally and sends only its text error')
  await openSettings(page)
  await card().getByRole('button', { name: '修改连接', exact: true }).click()
  await card().getByLabel('模型', { exact: true }).fill('caps-model-b')
  await card().getByRole('button', { name: '保存', exact: true }).click()
  await wait((s) => s.modelSettings.details.chat.model === 'caps-model-b', 'MODEL_B_NOT_SAVED')
  assert.equal((await snapshot()).modelSettings.details.chat.capabilities.declared, undefined)
  await card().getByRole('button', { name: '修改连接', exact: true }).click()
  await card().getByLabel('模型', { exact: true }).fill('caps-model-a')
  await card().getByRole('button', { name: '保存', exact: true }).click()
  await wait((s) => s.modelSettings.details.chat.model === 'caps-model-a' && s.modelSettings.details.chat.capabilities.declared?.contextWindow === 65536, 'MODEL_A_NOT_RESTORED')
  checks.push('model switch does not inherit declarations; switching back restores its saved declaration')
  await wait((s) => s.modelSettings.levels?.chat?.includes('medium'), 'MODEL_A_LEVELS_NOT_READY')
  await card().getByLabel('思考强度', { exact: true }).getByText('DSH 默认（使用关闭档位映射）', { exact: true }).waitFor({ state: 'attached' })
  await closeSettings(page); await sendTask('caps-wire:default-mapped-off')
  assert.equal(requests.at(-1).reasoning, 'vendor_off')
  checks.push('runtime default off mapping is stated in UI and verified on the wire')
  await openSettings(page)
  const beforeRestart = requests.length
  await instance.close(); await start(); await openSettings(page)
  await wait((s) => s.modelSettings.details.chat.capabilities.resolved?.contextWindow === 65536, 'RESTART_METADATA_NOT_READY')
  await expand()
  assert.equal(await caps().getByLabel('上下文窗口（token）', { exact: true }).inputValue(), '65536')
  assert.equal(requests.length, beforeRestart)
  const safe = JSON.stringify(await snapshot()); assert.ok(!safe.includes('only-synthetic-capability-key') && !safe.includes(`127.0.0.1:${server.address().port}`))
  checks.push('restart persistence, zero replay and credential-safe projection')
  await caps().getByLabel('上下文窗口（token）', { exact: true }).fill('invalid')
  await caps().getByRole('button', { name: '恢复自动设置', exact: true }).click()
  await wait((s) => s.modelSettings.status === 'saved' && !s.modelSettings.details.chat.capabilities.declared && s.modelSettings.levels !== undefined, 'RESET_NOT_APPLIED')
  assert.deepEqual((await snapshot()).modelSettings.efforts, {})
  await closeSettings(page); await sendTask('caps-wire:reset')
  assert.notEqual(requests.at(-1).outputLimit, 512); assert.equal(requests.at(-1).reasoning, null)
  checks.push('reset removes manual request behavior even when the unsaved draft is invalid')
  writeFileSync(join(data, 'report.json'), JSON.stringify({ ok: true, synthetic: true, checks, requests }, null, 2))
  console.log(JSON.stringify({ ok: true, data, checks, requests }, null, 2))
} catch (error) {
  writeFileSync(join(data, 'report.json'), JSON.stringify({ ok: false, synthetic: true, checks, requests, error: error.message }, null, 2)); throw error
} finally {
  await instance?.close().catch(() => {}); server.closeAllConnections(); await new Promise((r) => server.close(r))
}
