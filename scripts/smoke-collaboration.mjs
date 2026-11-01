// Real product lanes and the existing collaboration sheet, with local scripted models only.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { _electron } from 'playwright'
import electronPath from 'electron'
import JSZip from 'jszip'
import { runtimeEnv, testDataRoot, initializeTestBook, electronLaunchTarget, openSettings } from './runtime-env.mjs'

const root = resolve(import.meta.dirname, '..'), id = randomUUID(), data = join(testDataRoot(root), `work-family-${id}`)
const evidence = join(root, 'test-results', `work-family-${id}`)
const env = { ...runtimeEnv(root), LCA_DATA_DIR: data, LCA_PROVIDERS_FILE: join(data, 'absent.json'), LCA_CDP_PORT: '0', LCA_MCP_PORT: '0' }
const textOf = value => typeof value === 'string' ? value : (value ?? []).map(part => part.text ?? '').join('')
const checks = [], requests = []
const recovery = process.env.LCA_CONTINUITY_RECOVERY === '1'
let instance, page, held, workerStep = 0, childRead = false, failure
const answer = (response, model, reply) => {
  if (response.destroyed) return
  response.writeHead(200, { 'content-type': 'text/event-stream' })
  const chunk = (delta, finish_reason) => response.write(`data: ${JSON.stringify({ id: randomUUID(), object: 'chat.completion.chunk', created: 0, model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`)
  chunk(reply.tool ? { role: 'assistant', content: null, tool_calls: [{ index: 0, id: randomUUID(), type: 'function', function: { name: reply.tool, arguments: JSON.stringify(reply.args) } }] } : { role: 'assistant', content: reply.text }, null)
  chunk({}, reply.tool ? 'tool_calls' : 'stop'); response.end('data: [DONE]\n\n')
}
const server = createServer((req, res) => {
  let body = ''; req.on('data', chunk => { body += chunk }); req.on('end', () => {
    try {
      const input = JSON.parse(body), messages = input.messages ?? [], model = input.model
      if (!input.tools?.length) { res.writeHead(503).end(); return } // No synthetic background summarizer in this scenario.
      const child = messages.some(message => message.role === 'user' && textOf(message.content).startsWith('UI_CHILD_A'))
      requests.push({ model, child, count: messages.length })
      if (child) {
        if (!childRead) { childRead = true; answer(res, model, { tool: 'read', args: { file_path: 'family-note.txt' } }); return }
        held = { response: res, model }; return
      }
      if (model === 'work-script') {
        workerStep++
        if (workerStep === 1) { answer(res, model, { tool: 'team_task_create', args: { subject: 'Verify fixture', description: 'Read the synthetic note', write_scopes: [] } }); return }
        if (workerStep === 2) { answer(res, model, { tool: 'spawn_teammate', args: { name: 'reviewer', description: 'Read fixture', prompt: 'UI_CHILD_A Read family-note.txt and wait for your response fixture.' } }); return }
        answer(res, model, { text: 'My helper is still working. No verified completion checkpoint exists.' }); return
      }
      const index = messages.findLastIndex(message => message.role === 'user' && /\[\[(START|CHAT)\]\]/.test(textOf(message.content)))
      const current = textOf(messages[index]?.content), toolCalled = messages.slice(index + 1).some(message => message.role === 'tool')
      const marker = [...current.matchAll(/\[\[(START|CHAT)\]\]/g)].at(-1)?.[1]
      if (marker === 'START' && !toolCalled) { answer(res, model, { tool: 'lca_start_work', args: { objective: 'UI_WORK_A Coordinate the synthetic review.', acceptance: ['Read the note and verify a real result'] } }); return }
      answer(res, model, { text: 'FOREGROUND_READY while the review continues.' })
    } catch (error) { failure = error; res.writeHead(500).end() }
  })
})
await new Promise(done => server.listen(0, '127.0.0.1', done))
const snapshot = () => page.evaluate(() => window.lca.getSnapshot())
const send = body => page.evaluate(async body => { const s = await window.lca.getSnapshot(); return window.lca.dispatch({ protocolVersion: 1, epoch: s.epoch, requestId: crypto.randomUUID(), ...body }) }, body)
async function until(test, label) { for (let i = 0; i < 400; i++) { if (failure) throw failure; if (await test(await snapshot())) return; await new Promise(done => setTimeout(done, 100)) } throw new Error(label) }
async function launch() { instance = await _electron.launch({ ...electronLaunchTarget(root, electronPath), env, timeout: 30000 }); page = await instance.firstWindow(); page.setDefaultTimeout(15000); await initializeTestBook(page) }
const pass = name => { checks.push(name); console.log('WORK_FAMILY_PASS', name) }
async function chat(text) { const before = (await snapshot()).task?.id; assert.equal((await send({ type: 'message.send', text })).status, 'accepted'); await until(s => s.task?.id !== before && s.task?.status === 'completed', 'FOREGROUND_NOT_COMPLETE') }
try {
  await mkdir(data, { recursive: true }); await mkdir(evidence, { recursive: true }); await launch()
  for (const slot of ['chat', 'work']) {
    assert.equal((await send({ type: 'models.provider.save', slot, baseUrl: `http://127.0.0.1:${server.address().port}/v1`, model: slot + '-script', apiKey: 'synthetic-family-secret' })).status, 'accepted')
    await until(s => s.modelSettings.status === 'saved' && s.modelSettings.configuredSlots.includes(slot), 'CONFIG_NOT_APPLIED')
  }
  const project = (await snapshot()).work.current.path
  await writeFile(join(project, 'family-note.txt'), 'ONLY_SYNTHETIC_FAMILY_NOTE')
  await send({ type: 'mode.set', mode: 'rest' }); await chat('[[START]] Please coordinate this review as a persistent work.')
  await until(s => held && s.continuousWorks.items[0]?.status === 'running', 'WORKER_OR_CHILD_NOT_RUNNING')
  const workId = (await snapshot()).continuousWorks.items[0].identity.workId
  await chat('[[CHAT]] Can we talk while the reviewer is still thinking?')
  assert.equal((await snapshot()).continuousWorks.items[0].status, 'running'); pass('foreground-and-worker-family-independent')
  await page.getByRole('button', { name: /^协作/ }).click()
  await page.getByLabel('协作工作', { exact: true }).selectOption(workId)
  await until(s => s.collaboration.workSelection?.workId === workId && s.collaboration.members.some(m => m.mode === 'teammate'), 'WORK_FAMILY_NOT_VISIBLE')
  const member = (await snapshot()).collaboration.members.find(m => m.mode === 'teammate')
  assert.equal(member.activity, 'running'); assert.equal((await snapshot()).collaboration.tasks.length, 1)
  const steps = await page.evaluate(address => window.lca.readMemberSteps(address), member.address)
  assert.ok(steps.steps.some(step => step.templateId === 'dsh.read' && step.status === 'completed'))
  assert.equal(JSON.stringify((await snapshot()).collaboration).includes('family-note.txt'), false)
  pass('selected-worker-members-and-on-demand-steps-without-raw-target-leak')
  await page.getByRole('button', { name: '主角色领取', exact: true }).click(); await until(s => s.collaboration.tasks[0]?.status === 'claimed', 'CLAIM_FAILED')
  await page.getByRole('button', { name: '确认任务完成', exact: true }).click(); await until(s => s.collaboration.tasks[0]?.status === 'completed', 'COMPLETE_FAILED')
  assert.equal((await snapshot()).continuousWorks.items[0].status, 'running'); pass('board-receipt-is-not-work-completion')
  await page.getByRole('region', { name: '成员与共同任务', exact: true }).screenshot({ path: join(evidence, 'members.png') })
  await page.getByLabel('协作工作', { exact: true }).selectOption('')
  await until(s => s.collaboration.workSelection?.workId === null && s.collaboration.status === 'ready', 'FRONT_SELECTION_FAILED')
  assert.ok((await snapshot()).collaboration.members.every(m => m.mode === 'root'))
  await page.getByLabel('协作工作', { exact: true }).selectOption(workId)
  await until(s => s.collaboration.workSelection?.workId === workId && s.collaboration.members.some(m => m.mode === 'teammate'), 'RESELECT_FAILED')
  pass('family-switch-does-not-merge-roots')
  if (recovery) {
    await instance.close(); instance = undefined; held.response.destroy(); held = undefined
    const callsBefore = requests.length; await launch()
    await until(s => s.continuousWorks.items[0]?.status === 'review_required', 'COLD_WORK_NOT_RECONCILED')
    assert.equal(requests.length, callsBefore)
    const savedWork = (await snapshot()).continuousWorks.items[0]
    assert.equal(savedWork.identity.workId, workId); pass('cold-start-reconciles-without-execution')
    const archiveFile = join(data, 'pending-work.lca-save')
    await instance.evaluate(({ dialog }, file) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: file }) }, archiveFile)
    assert.equal((await send({ type: 'backup.export' })).status, 'accepted'); await until(s => s.backup.status === 'exported', 'WORK_ARCHIVE_EXPORT_FAILED')
    const manifest = JSON.parse(await (await JSZip.loadAsync(await readFile(archiveFile))).file('manifest.json').async('string'))
    assert.equal(manifest.continuity.workCount, 1); assert.equal(manifest.formatVersion, 2)
    workerStep = 0; childRead = false
    assert.equal((await send({ type: 'work.resume', target: { identity: savedWork.identity, expectedRevision: savedWork.revision } })).status, 'accepted')
    await until(s => held && s.continuousWorks.items[0]?.status === 'running', 'FRESH_WORK_DID_NOT_RESUME')
    assert.ok((await snapshot()).continuousWorks.items[0].identity.generation > savedWork.identity.generation)
    pass('explicit-continue-starts-fresh-generation')
    const resumed = (await snapshot()).continuousWorks.items[0]
    await send({ type: 'work.stop', target: { identity: resumed.identity, expectedRevision: resumed.revision } })
    await until(s => s.continuousWorks.items[0]?.status === 'stopped', 'RESUMED_WORK_NOT_STOPPED')
    held.response.destroy(); held = undefined
    await instance.evaluate(({ dialog }, file) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }) }, archiveFile)
    await send({ type: 'backup.import' }); await until(s => s.backup.status === 'awaiting-confirmation', 'WORK_ARCHIVE_IMPORT_FAILED')
    await openSettings(page)
    const archiveGroup = page.locator('.settings-group').filter({ has: page.locator('[aria-label="私人存档控制"]') })
    if (!await archiveGroup.evaluate(element => element.open)) await archiveGroup.locator('summary').click()
    await instance.evaluate(({ app }) => { app.relaunch = () => {} })
    const closed = instance.waitForEvent('close')
    await page.getByRole('alertdialog', { name: '恢复私人存档确认' }).getByRole('button', { name: '备份当前数据并恢复', exact: true }).click()
    await closed; instance = undefined
    const beforeRestore = requests.length; await launch()
    await until(s => s.backup.status === 'restored', 'WORK_ARCHIVE_NOT_RESTORED')
    assert.equal((await snapshot()).continuousWorks.items[0].identity.workId, workId)
    assert.equal((await snapshot()).continuousWorks.items[0].status, 'review_required'); assert.equal(requests.length, beforeRestore)
    await instance.close(); instance = undefined; await launch()
    assert.equal((await snapshot()).continuousWorks.items[0].status, 'review_required'); assert.equal(requests.length, beforeRestore)
    pass('nonempty-work-restore-and-second-start-never-replay')
  } else {
  // Native root already ended while its teammate's request is held. Stop the owning work explicitly.
  const work = (await snapshot()).continuousWorks.items[0]
  assert.equal((await send({ type: 'work.stop', target: { identity: work.identity, expectedRevision: work.revision } })).status, 'accepted')
  await until(s => s.continuousWorks.items[0]?.status === 'stopped', 'WORK_STOP_FAILED')
  held.response.destroy(); held = undefined
  assert.equal((await snapshot()).collaboration.status, 'unavailable'); pass('work-stop-releases-only-its-family')
  await instance.close(); instance = undefined
  const count = requests.length; await launch()
  const restored = (await snapshot()).continuousWorks.items[0]
  assert.equal(restored.identity.workId, workId); assert.equal(restored.status, 'stopped'); assert.equal(requests.length, count)
  pass('restart-preserves-work-without-member-resurrection')
  }
  await writeFile(join(evidence, 'evidence.json'), JSON.stringify({ ok: true, checks, data, requests, recovery, syntheticOnly: true, executable: process.env.LCA_TEST_EXECUTABLE ?? electronPath }, null, 2))
  console.log('WORK_FAMILY_EVIDENCE', evidence)
} catch (error) {
  await writeFile(join(evidence, 'failure.json'), JSON.stringify({ error: String(error), checks, data, requests, snapshot: await snapshot().catch(() => null) }, null, 2)); throw error
} finally { held?.response.destroy(); await instance?.close(); server.closeAllConnections(); await new Promise(done => server.close(done)) }
