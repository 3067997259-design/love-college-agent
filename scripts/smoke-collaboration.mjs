// Actual book -> main projection/controls -> pinned DSH. No real providers or user data.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { _electron } from 'playwright'
import electronPath from 'electron'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { runtimeEnv, initializeTestBook, electronLaunchTarget } from './runtime-env.mjs'

const root = resolve(import.meta.dirname, '..'), id = randomUUID(), data = join(root, '.local-data', `p5-smoke-${id}`), scene = randomUUID()
const profile = join(data, 'developer', scene), user = join(data, 'user'), evidence = join(root, 'test-results', `p5-${id}`)
const env = { ...runtimeEnv(root), LCA_DATA_DIR: data, LCA_PROVIDERS_FILE: join(data, 'absent.json'), LCA_CDP_PORT: '19594', LCA_MCP_PORT: '0', USERPROFILE: user, HOME: user, APPDATA: join(user, 'AppData/Roaming'), LOCALAPPDATA: join(user, 'AppData/Local') }
let instance, page, client
const checks = []
const snapshot = () => page.evaluate(() => window.lca.getSnapshot())
const send = (body) => page.evaluate(async (body) => { const state = await window.lca.getSnapshot(); return window.lca.dispatch({ protocolVersion: 1, epoch: state.epoch, requestId: crypto.randomUUID(), ...body }) }, body)
async function until(test, label) { for (let i = 0; i < 400; i++) { if (await test(await snapshot())) return; await new Promise((done) => setTimeout(done, 100)) }; throw new Error(label) }
async function debug(name, args = {}) { const result = await client.callTool({ name, arguments: args }); assert.ok(!result.isError); return JSON.parse(result.content[0].text) }
const pass = (name) => { checks.push(name); console.log('P5_UI_PASS', name) }
async function launch() {
  instance = await _electron.launch({ ...electronLaunchTarget(root, electronPath), env, timeout: 30_000 }); page = await instance.firstWindow(); await initializeTestBook(page)
  const config = JSON.parse(await readFile(join(profile, 'debug-connection.json'), 'utf8'))
  client = new Client({ name: 'p5-smoke', version: '1' }); await client.connect(new StreamableHTTPClientTransport(new URL(config.url), { requestInit: { headers: { Authorization: `Bearer ${config.token}` } } }))
  await debug('set_clock', { frozen: true })
}
async function script(tool, args, label) {
  await debug('set_fake_model', { script: [{ text: '', toolCalls: [{ id: `p5-${tool}`, name: tool, arguments: JSON.stringify(args) }], delayMs: 0 }, { text: `${label} finished`, toolCalls: [], delayMs: 0 }, { text: `${label} delivered`, toolCalls: [], delayMs: 0 }] })
  assert.equal((await send({ type: 'message.send', text: `Synthetic P5 ${label}` })).status, 'accepted')
  await until((state) => state.task?.status === 'completed' && state.messages.some((message) => message.text.includes(label)), `TURN_${label}`)
}
try {
  for (const dir of [data, profile, user, env.APPDATA, env.LOCALAPPDATA, join(user, 'Documents'), join(user, 'Desktop'), join(user, 'Downloads'), evidence]) await mkdir(dir, { recursive: true })
  await writeFile(join(data, 'settings.json'), JSON.stringify({ version: 1, developer: true, booth: false, plugins: {}, sceneId: scene }))
  await launch()
  await page.getByRole('button', { name: '协作', exact: true }).click()
  await until((state) => state.collaboration?.status === 'ready', 'COLLABORATION_READY')
  const panel = page.getByRole('region', { name: '成员与共同任务', exact: true })
  assert.ok(await panel.isVisible()); pass('empty-catalog-refresh-through-book')
  await script('spawn_teammate', { name: 'reviewer', description: '持续核对结果', prompt: 'Synthetic member task; reply with a short result.' }, 'team')
  await until((state) => state.collaboration.members.some((member) => member.mode === 'teammate' && member.outcome === 'completed'), 'TEAM_VIEW')
  await script('subagent', { description: '独立资料核对', prompt: 'Synthetic helper task; reply with a short result.' }, 'helper')
  await until((state) => state.collaboration.members.some((member) => member.mode === 'subagent' && member.outcome === 'completed'), 'HELPER_VIEW')
  assert.equal(await panel.locator('.collaboration-member').count(), 2)
  for (const row of await panel.locator('.collaboration-member').all()) await row.locator('summary').click()
  await panel.screenshot({ path: join(evidence, 'members.png') }); pass('team-and-helper-states-results-and-capacity-visible')
  await script('team_task_create', { subject: '共同核对交付物', description: 'Verify the synthetic artifact before completion.', write_scopes: ['src/shared'] }, 'board')
  await until((state) => state.collaboration.tasks.length === 1, 'TASK_VIEW')
  await panel.getByRole('button', { name: '主角色领取', exact: true }).click()
  await until((state) => state.collaboration.tasks[0]?.status === 'claimed', 'TASK_CLAIM')
  await panel.getByRole('button', { name: '确认任务完成', exact: true }).click()
  await until((state) => state.collaboration.tasks[0]?.status === 'completed', 'TASK_COMPLETE')
  pass('task-claim-and-complete-with-revision-check')
  await debug('set_fake_model', { script: [{ text: 'P5 direct instruction handled', toolCalls: [], delayMs: 0 }] })
  const memberCard = panel.locator('.collaboration-member').first()
  const before = (await snapshot()).collaboration.members.find((member) => member.mode === 'teammate').usage.admittedUnits ?? 0
  await memberCard.getByRole('textbox').fill('P5 direct instruction; give a short result')
  await memberCard.getByRole('button', { name: '发送指令', exact: true }).click()
  await until((state) => state.collaboration.members.some((member) => member.mode === 'teammate' && (member.usage.admittedUnits ?? 0) > before && member.outcome === 'completed'), 'MEMBER_MESSAGE')
  pass('direct-member-message-runs-after-root-is-idle')
  // The member settlement wakes the lead too; let that consume its own scripted reply first.
  await until((state) => state.collaboration.members.every((member) => member.activity === 'inactive'), 'SETTLEMENT_DELIVERED')
  await new Promise((done) => setTimeout(done, 200))
  await debug('set_fake_model', { script: [{ text: 'must be interrupted', toolCalls: [], delayMs: 10000 }] })
  await memberCard.getByRole('textbox').fill('P5 interruptible work')
  await memberCard.getByRole('button', { name: '发送指令', exact: true }).click()
  await until((state) => state.collaboration.operation?.phase === 'settled' && state.collaboration.members.some((member) => member.mode === 'teammate' && member.activity === 'running'), 'MEMBER_RUNNING')
  // V1: a helper starting work pulls the left page back to the whole room; every helper stands there, the busy one drawn busy.
  await page.waitForFunction(() => document.querySelector('.room')?.dataset.shot === 'team')
  assert.equal(await page.locator('.team-room[data-visible="true"] .team-mini').count(), 2)
  assert.equal(await page.locator('.team-mini[data-busy]').count(), 1)
  await page.locator('.page-left').screenshot({ path: join(evidence, 'team-room.png') })
  // Clicking in the room is checked at the end: extra steps here shift the timing of the lost-receipt step below.
  await memberCard.getByRole('button', { name: '停止当前工作', exact: true }).click()
  await until((state) => state.collaboration.members.some((member) => member.mode === 'teammate' && member.activity === 'inactive' && member.outcome === 'aborted'), 'MEMBER_STOPPED')
  await page.waitForFunction(() => document.querySelector('.room')?.dataset.shot === 'close') // everyone stopped: back to the desk
  pass('single-member-interrupt-observes-real-aborted-outcome')
  const oldRuntime = (await snapshot()).collaboration.runtimeId
  // Fault injection only into the test app's own, already-started DSH child.
  assert.equal(await instance.evaluate((_electron, oldId) => {
    const children = process._getActiveHandles().filter((handle) => handle.connected && handle.spawnargs?.some((arg) => /[\\/]dsh[\\/]lib[\\/]bin\.js$/.test(arg)))
    for (const child of children) {
      const emit = child.emit.bind(child)
      child.emit = (event, ...values) => {
        const message = values[0], receipt = message?.view?.operation
        if (event === 'message' && ['collaboration', 'collaboration-reply'].includes(message?.t) && receipt?.outcome === 'accepted' && receipt.requestId !== oldId) { child.disconnect(); return true }
        return emit(event, ...values)
      }
    }
    return children.length
  }, (await snapshot()).collaboration.operation.requestId), 1)
  await panel.getByRole('button', { name: '重新打开', exact: true }).click()
  await until((state) => state.collaboration.status === 'failed' && state.collaboration.operation?.outcome === 'unknown', 'LOST_RECEIPT_UNKNOWN')
  const unknownId = (await snapshot()).collaboration.operation.requestId
  await panel.getByRole('button', { name: '刷新核对', exact: true }).click()
  await until((state) => state.collaboration.status === 'ready' && state.collaboration.operation?.outcome === 'accepted', 'READ_RECONNECT')
  const recovered = (await snapshot()).collaboration
  assert.equal(recovered.operation.requestId, unknownId); assert.notEqual(recovered.runtimeId, oldRuntime)
  assert.equal(recovered.tasks[0].status, 'open'); assert.ok(recovered.members.every((member) => member.activity === 'inactive'))
  pass('lost-receipt-refresh-reconnects-and-reconciles-same-operation-without-replay')
  await panel.getByRole('button', { name: '主角色领取', exact: true }).click()
  await until((state) => state.collaboration.tasks[0].status === 'claimed', 'RECLAIM')
  await panel.getByRole('button', { name: '确认任务完成', exact: true }).click()
  await until((state) => state.collaboration.tasks[0].status === 'completed', 'RECOMPLETE')
  await panel.getByRole('button', { name: '停止整组', exact: true }).click()
  await until((state) => state.collaboration.operation?.outcome === 'accepted' && state.collaboration.members.every((member) => !['running', 'stopping'].includes(member.activity)), 'FAMILY_STOP')
  assert.equal((await snapshot()).collaboration.capacity.teamUsed, 1)
  assert.equal(await memberCard.getByRole('button', { name: '发送指令', exact: true }).count(), 0)
  pass('family-stop-keeps-roster-and-revokes-continuation-until-new-work')
  await panel.screenshot({ path: join(evidence, 'tasks.png') })
  await instance.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((window) => !window.isDestroyed()).setSize(1100, 760))
  assert.ok(await panel.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)); await page.screenshot({ path: join(evidence, 'book-narrow.png') })
  const safe = JSON.stringify((await snapshot()).collaboration); assert.ok(!safe.includes('cwd')); assert.ok(!safe.includes('transcript')); assert.ok(!safe.includes('Bearer '))
  pass('narrow-page-and-safe-projection')
  await client.close(); client = null; await instance.close(); instance = null
  await launch(); await page.getByRole('button', { name: '协作', exact: true }).click()
  await until((state) => state.collaboration?.members.filter((member) => member.mode !== 'root').length === 2, 'COLD_RECOVERY')
  assert.equal((await snapshot()).collaboration.tasks[0].status, 'completed')
  pass('cold-recovery-restores-members-and-board-without-executing-them')
  // Nobody is working after recovery, so the desk stays; the room is one click away and every helper is still there.
  await page.getByRole('button', { name: '收起协作', exact: true }).click()
  await page.waitForFunction(() => document.querySelector('.room')?.dataset.shot === 'close')
  await page.getByRole('button', { name: '看看房间', exact: true }).click()
  await page.waitForFunction(() => document.querySelector('.room')?.dataset.shot === 'team')
  assert.equal(await page.locator('.team-room[data-visible="true"] .team-mini').count(), 2)
  const teammate = (await snapshot()).collaboration.members.find((member) => member.mode === 'teammate')
  await page.getByRole('button', { name: new RegExp(`^${teammate.name}：`) }).click()
  const card = page.getByRole('dialog', { name: teammate.name, exact: true })
  const ended = { completed: '本次运行已结束', aborted: '已中止', failed: '执行失败', refused: '未获批准', unknown: '结果待核对' }[teammate.outcome]
  if (ended) assert.ok((await card.textContent()).includes(ended))
  await page.locator('.page-left').screenshot({ path: join(evidence, 'team-card.png') })
  await card.getByRole('button', { name: '更多', exact: true }).click()
  await page.getByRole('region', { name: '成员与共同任务', exact: true }).waitFor()
  await page.getByRole('button', { name: '回到桌前', exact: true }).click()
  await page.waitForFunction(() => document.querySelector('.room')?.dataset.shot === 'close')
  pass('team-room-toggle-and-card-follow-recovered-members')
  await writeFile(join(evidence, 'evidence.json'), JSON.stringify({ checks, syntheticOnly: true, executable: process.env.LCA_TEST_EXECUTABLE ?? electronPath, data, evidence }, null, 2)); console.log('P5_UI_EVIDENCE', evidence)
} catch (error) {
  if (page && !page.isClosed()) { await writeFile(join(evidence, 'failure.json'), JSON.stringify({ error: String(error), snapshot: await snapshot() }, null, 2)); await page.screenshot({ path: join(evidence, 'failure.png') }) }
  throw error
} finally { await client?.close(); await instance?.close() }
