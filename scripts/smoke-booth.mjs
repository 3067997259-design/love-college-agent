import assert from 'node:assert/strict'
import { randomUUID, createHash } from 'node:crypto'
import { mkdir, writeFile, readFile, readdir } from 'node:fs/promises'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron } from 'playwright'
import electronPath from 'electron'
import { runtimeEnv, initializeTestBook, electronLaunchTarget } from './runtime-env.mjs'
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..'); const data = join(root, '.local-data', 'booth-' + randomUUID())
const env = { ...runtimeEnv(root), LCA_DATA_DIR: data, LCA_PROVIDERS_FILE: join(data, 'absent.json') }; delete env.LCA_BOOTH
const owner = ['local-user', 'default-character']; const hash = (text) => createHash('sha256').update(text).digest('hex'); let instance; let page
const snapshot = () => page.evaluate(() => window.lca.getSnapshot())
const send = (body) => page.evaluate(async (body) => { const s = await window.lca.getSnapshot(); return window.lca.dispatch({ ...body, protocolVersion: 1, epoch: s.epoch, requestId: crypto.randomUUID() }) }, body)
async function launch(booth) { instance = await _electron.launch({ ...electronLaunchTarget(root, electronPath), env: { ...env, ...(booth ? { LCA_BOOTH: '1' } : {}) } }); page = await instance.firstWindow(); await initializeTestBook(page) }
async function stop() { await instance?.close(); instance = undefined }
try {
  const atMs = Date.now(); const day = new Date(atMs + 4 * 3600000).toISOString().slice(0, 10); const folder = join(data, 'journals', hash(JSON.stringify(owner))); await mkdir(folder, { recursive: true })
  const personalFile = join(folder, day + '.jsonl')
  const rows = [{ type: 'session/header', userId: owner[0], characterId: owner[1], sessionId: randomUUID() }, { type: 'user/message', id: 'private', text: 'PERSONAL_BOOK_SENTINEL', requestId: 'private', commandHash: 'private' }, { type: 'inbox/drain', ids: ['private'] }]
  await writeFile(personalFile, rows.map((row, index) => JSON.stringify({ ...row, version: 1, seq: index + 1, atMs })).join('\n') + '\n')
  await launch(false); assert.equal((await snapshot()).runtime.developer.mode, 'normal'); assert.ok((await snapshot()).messages.some((message) => message.text === 'PERSONAL_BOOK_SENTINEL'))
  assert.equal((await send({ type: 'onboarding.profile', userName: '个人姓名', characterName: '个人称呼' })).status, 'accepted'); await stop()
  const personalBefore = await readFile(personalFile)
  await launch(true); let view = await snapshot(); assert.equal(view.runtime.developer.mode, 'booth'); assert.equal(view.onboarding.status, 'completed'); assert.equal(view.onboarding.userName, null); assert.equal(view.onboarding.characterName, '桃子')
  assert.ok(!JSON.stringify(view).includes('PERSONAL_BOOK_SENTINEL')); assert.equal(view.runtime.developer.mcpPort, undefined); assert.equal(view.runtime.developer.cdpPort, undefined)
  assert.equal((await send({ type: 'developer.set', enabled: true })).status, 'rejected')
  assert.equal((await send({ type: 'onboarding.profile', userName: '展位姓名', characterName: '展位称呼' })).status, 'accepted')
  assert.equal((await send({ type: 'pomodoro.plan', plan: { label: 'BOOTH_ONLY_PLAN', plannedCount: 2, focusDurationMs: 60000, shortBreakDurationMs: 20000, longBreakDurationMs: 20000, longBreakEvery: 4, timing: 'demo' } })).status, 'accepted')
  assert.equal((await send({ type: 'pomodoro.confirm', planId: (await snapshot()).pomodoro.proposal.id })).status, 'accepted'); await stop()
  assert.deepEqual(await readFile(personalFile), personalBefore)
  const boothOwner = join(data, 'booth', 'journals', (await readdir(join(data, 'booth', 'journals')))[0]); const boothText = (await Promise.all((await readdir(boothOwner)).map((name) => readFile(join(boothOwner, name), 'utf8')))).join('\n')
  assert.ok(boothText.includes('BOOTH_ONLY_PLAN')); assert.ok(!boothText.includes('PERSONAL_BOOK_SENTINEL'))
  await launch(true); view = await snapshot(); assert.equal(view.onboarding.userName, '展位姓名'); assert.equal(view.pomodoro.plan.label, 'BOOTH_ONLY_PLAN'); await stop()
  await launch(false); view = await snapshot(); assert.equal(view.onboarding.userName, '个人姓名'); assert.equal(view.onboarding.characterName, '个人称呼'); assert.equal(view.pomodoro.plan ?? null, null); assert.ok(view.messages.some((message) => message.text === 'PERSONAL_BOOK_SENTINEL'))
  console.log('Booth Electron PASS: same configured data root switches into a separate booth profile, personal journal unchanged during exhibition, no private name/messages/plan in booth, booth persistence, developer/CDP/MCP refusal, and return to the original personal book. Synthetic local data; no providers contacted.')
} finally { await stop() }
