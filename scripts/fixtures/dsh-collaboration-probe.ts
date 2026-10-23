import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import childProcess from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
import { startDshHost, prepareDshProfile, type DshHost, type DshEvent } from '../../src/main/dsh/host'
import { systemClock } from '../../src/main/clock'
import type { CollaborationView, CollaborationCommand } from '../../src/shared/collaboration'

const [, , root, repo] = process.argv
const user = join(root, 'user'), dataDir = join(root, 'data'), workspace = join(root, 'work')
for (const dir of [user, dataDir, workspace, join(user, 'AppData/Roaming'), join(user, 'AppData/Local')]) mkdirSync(dir, { recursive: true })
Object.assign(process.env, { USERPROFILE: user, HOME: user, APPDATA: join(user, 'AppData/Roaming'), LOCALAPPDATA: join(user, 'AppData/Local'), LCA_DSH_NODE: process.execPath, Path: `${process.env.SystemRoot}\\System32;${process.env.SystemRoot}` })
const events: DshEvent[] = [], requests: { phase: string; request: unknown }[] = [], checks: string[] = []
const admissions: { phase: string; bucket: string }[] = []
let host: DshHost, sessionId = '', phase = 'COEXIST', ordinary = '', teammate = '', taskId = '', taskRevision = 0, boardTask = '', dependent = '', dropReceipt = ''
const originalSpawn = childProcess.spawn
childProcess.spawn = ((...args: Parameters<typeof childProcess.spawn>) => {
  const child = originalSpawn(...args), emit = child.emit.bind(child)
  child.emit = ((event: string, ...values: unknown[]) => {
    const message = values[0] as { t?: string; view?: CollaborationView } | undefined
    if (event === 'message' && dropReceipt && message?.t === 'collaboration-reply' && message.view?.operation?.requestId === dropReceipt) { dropReceipt = ''; child.disconnect(); return true }
    return emit(event, ...values)
  }) as typeof child.emit
  return child
}) as typeof childProcess.spawn
syncBuiltinESMExports()
const text = (value: unknown): string => typeof value === 'string' ? value : Array.isArray(value) ? value.map((entry) => text(entry.text)).join('') : ''
let holdChildren = false
const heldReplies: (() => void)[] = []
const call = (name: string, id: string, args = {}) => ({ content: '', tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] })
const server = createServer((req, res) => {
  let body = ''; req.on('data', (part) => { body += part }); req.on('end', () => {
    try {
      if (req.url !== '/v1/chat/completions') { res.writeHead(404).end(); return }
      const request = JSON.parse(body), messages = request.messages
      requests.push({ phase, request })
      const markerIndex = messages.findLastIndex((message: { role: string; content: unknown }) => message.role === 'user' && /\[\[(COEXIST|BOARD|SOURCE|RETIRE|CAPACITY|STOPPED|CHILD|CONTINUE|FORBIDDEN|AUTO|AUTOCHILD)\]\]/.test(text(message.content)))
      const marker = text(messages[markerIndex]?.content).match(/\[\[(\w+)\]\]/)?.[1]
      const results = messages.slice(markerIndex + 1).filter((message: { role: string }) => message.role === 'tool'), last = results.at(-1), id = last?.tool_call_id
      let reply: Record<string, unknown> = { content: `${marker ?? 'notification'} done` }
      if (marker === 'COEXIST') {
        if (!id) reply = call('spawn_teammate', 'team', { name: 'reviewer', description: 'Stable review responsibility', prompt: '[[CHILD]] team fixture' })
        else if (id === 'team') { teammate = JSON.parse(text(last.content)).member.target; reply = call('subagent', 'helper', { description: 'Independent helper', prompt: '[[CHILD]] ordinary fixture' }) }
        else if (id === 'helper') reply = call('list_agents', 'list')
        else if (id === 'list') { const rows = JSON.parse(text(last.content)).members; ordinary = rows.find((row: { target: string }) => row.target.startsWith('agent:')).target; reply = call('team_task_create', 'task', { subject: 'Verified shared work', description: 'Check fixture output', write_scopes: ['src/shared'] }) }
        else if (id === 'task') { const task = JSON.parse(text(last.content)); taskId = task.id; taskRevision = task.revision; reply = call('team_task_update', 'claim', { task_id: taskId, expected_revision: taskRevision, action: 'claim' }) }
      } else if (marker === 'BOARD') {
        if (!id) reply = call('team_task_create', 'board-create', { subject: 'Board primary', description: 'Synthetic primary task', write_scopes: ['shared'] })
        else if (id === 'board-create') { boardTask = JSON.parse(text(last.content)).id; reply = call('team_task_update', 'board-claim', { task_id: boardTask, expected_revision: 1, action: 'claim' }) }
        else if (id === 'board-claim') reply = call('team_task_update', 'stale-revision', { task_id: boardTask, expected_revision: 1, action: 'release' })
        else if (id === 'stale-revision') reply = call('team_task_create', 'overlap-create', { subject: 'Overlap', description: 'Synthetic overlap warning', write_scopes: ['shared/file.ts'] })
        else if (id === 'overlap-create') reply = call('team_task_update', 'overlap-claim', { task_id: JSON.parse(text(last.content)).id, expected_revision: 1, action: 'claim' })
        else if (id === 'overlap-claim') reply = call('team_task_get', 'overlap-read', { task_id: boardTask })
        else if (id === 'overlap-read') reply = call('team_task_create', 'dependency-create', { subject: 'Dependent', description: 'Needs primary', blocked_by: [boardTask] })
        else if (id === 'dependency-create') { dependent = JSON.parse(text(last.content)).id; reply = call('team_task_update', 'dependency-claim', { task_id: dependent, expected_revision: 1, action: 'claim' }) }
        else if (id === 'dependency-claim') reply = call('team_task_update', 'cycle', { task_id: boardTask, expected_revision: 2, action: 'edit', blocked_by: [dependent] })
      } else if (marker === 'CHILD' && text(messages[markerIndex]?.content).includes('ordinary fixture') && !id) {
        reply = call('team_task_list', 'ordinary-not-team')
      } else if (marker === 'SOURCE') {
        if (!id) reply = call('lca_probe_source', 'source')
        else if (id === 'source') reply = call('team_task_create', 'sourced-task', { subject: 'P5_PRIVATE_SOURCE', description: 'P5_PRIVATE_SOURCE', write_scopes: ['P5_PRIVATE_SOURCE'] })
        else if (id === 'sourced-task') { const task = JSON.parse(text(last.content)); taskId = task.id; taskRevision = task.revision }
      } else if (marker === 'RETIRE') {
        if (!id) reply = call('team_task_get', 'read', { task_id: taskId })
        else if (id === 'read') reply = call('team_task_update', 'claim', { task_id: taskId, expected_revision: taskRevision, action: 'claim' })
        else if (id === 'claim') reply = call('team_task_list', 'list')
      } else if (marker === 'CAPACITY') {
        if (!id) reply = call('spawn_teammate', 'second', { name: 'builder', description: 'Another stable role', prompt: '[[CHILD]] second team fixture' })
        else if (id === 'second') reply = call('send_message', 'wake-team', { target: teammate, message: '[[CONTINUE]] hold team' })
        else if (id === 'wake-team') reply = call('send_message', 'wake-helper', { target: ordinary, message: '[[CONTINUE]] hold helper' })
        else if (id === 'wake-helper') reply = call('subagent', 'over-active', { description: 'Must exceed resident capacity', prompt: '[[FORBIDDEN]]' })
        else if (id === 'over-active') reply = call('spawn_teammate', 'over-roster', { name: 'overflow', description: 'Must exceed roster capacity', prompt: '[[FORBIDDEN]]' })
        else if (id === 'over-roster') reply = call('send_message', 'reuse', { target: teammate, message: '[[CONTINUE]] reuse same member' })
      } else if (marker === 'AUTO' && !id) {
        reply = call('subagent', 'auto-spawn', { description: 'Bounded autonomous helper', prompt: '[[AUTOCHILD]] synthetic bounded loop' })
      } else if (marker === 'AUTOCHILD') {
        reply = call('list_agents', `auto-${results.length}`)
      } else if (marker === 'STOPPED') {
        if (!id) reply = call('spawn_teammate', 'still-full', { name: 'replacement', description: 'Stopping did not free roster', prompt: '[[FORBIDDEN]]' })
      }
      const base = { id: `synthetic-${requests.length}`, object: 'chat.completion.chunk', created: 1, model: 'p5-model' }
      const respond = () => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: 'assistant', ...reply }, finish_reason: null }] })}\n\n`)
      res.end(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: reply.tool_calls ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 12, completion_tokens: 7, total_tokens: 19 } })}\n\ndata: [DONE]\n\n`)
      }
      if (holdChildren && ['CHILD', 'CONTINUE', 'AUTOCHILD'].includes(marker ?? '')) heldReplies.push(respond); else respond()
    } catch (error) { res.writeHead(500).end(); console.error(error) }
  })
})
await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
const port = (server.address() as { port: number }).port
const endpoint = `http://127.0.0.1:${port}/v1`
const routes = { chat: { provider: 'lca-p5', model: 'p5-model' }, work: { provider: 'lca-p5', model: 'p5-model' }, env: { LCA_CHAT_API_KEY: 'synthetic', LCA_DSH_ROUTES: JSON.stringify({ providers: { 'lca-p5': { baseURL: endpoint, api: 'openai-completions', apiKeyEnv: 'LCA_CHAT_API_KEY', models: [{ id: 'p5-model', name: 'p5-model', reasoning: false, input: ['text'], contextWindow: 32768, maxTokens: 2048, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] } }, chat: { provider: 'lca-p5', model: 'p5-model' }, work: { provider: 'lca-p5', model: 'p5-model' } }) } }
const options = { clock: systemClock, dshRoot: join(repo, 'dsh/runtime'), bridge: join(repo, 'dsh/lca-bridge'), dataDir, workspace, routes, guardedRoots: [dataDir], persona: 'Synthetic collaboration validation.', tools: [{ name: 'lca_probe_source', description: 'Synthetic source', parameters: { type: 'object', properties: {} }, source: 'web' as const }],
  onEvent: (event: DshEvent) => { events.push(event) }, onCall: async () => ({ value: 'P5_PRIVATE_SOURCE', source: 'web' as const }), onApproval: async () => 'allowed-once' as const,
  onAdmit: (input: { bucket: string }) => { admissions.push({ phase, bucket: input.bucket }); return true } }
const { profile } = prepareDshProfile(options)
writeFileSync(join(profile, 'cordis.patch.yml'), JSON.stringify([{ id: 'agent-team', config: { maxMembers: 2 } }, { id: 'subagent', config: { maxActiveSubagents: 3 } }]))
async function until(test: () => boolean, message: string) { for (let i = 0; i < 400; i++) { if (test()) return; await new Promise((done) => setTimeout(done, 50)) }; throw new Error(message) }
async function turn(next: string) { phase = next; const at = events.length; host.send(sessionId, `[[${next}]] synthetic test`); await until(() => events.slice(at).some((event) => event.t === 'message' && String(event.text).includes(`${next} done`)), `TURN_${next}`); await until(() => events.slice(at).some((event) => event.t === 'turn-end'), `END_${next}`) }
async function view(): Promise<CollaborationView> { return (await host.collaboration({ rootSessionId: sessionId, command: { type: 'agent.refresh' } })).view }
async function control(command: CollaborationCommand, requestId = randomUUID()) { return host.collaboration({ rootSessionId: sessionId, command, requestId }) }
function pass(name: string) { checks.push(name); console.log('P5_PASS', name) }
try {
  host = startDshHost(options); await host.started; sessionId = await host.open(workspace)
  await turn('COEXIST')
  let snapshot = await view()
  assert.equal(snapshot.members.filter((member) => member.mode === 'teammate').length, 1)
  assert.equal(snapshot.members.filter((member) => member.mode === 'subagent').length, 1)
  assert.equal(snapshot.tasks[0].status, 'claimed')
  for (const name of ['subagent', 'subagent_fork', 'spawn_teammate', 'send_message', 'list_agents', 'interrupt_agent']) assert.equal((requests[0].request as { tools: { function: { name: string } }[] }).tools.filter((tool) => tool.function.name === name).length, 1)
  assert.ok(JSON.stringify(requests[0]).includes('choose by coordination needs'))
  pass('ordinary-and-team-coexist-with-single-controls-and-selection-guidance')
  const member = snapshot.members.find((row) => row.mode === 'subagent')!
  await assert.rejects(control({ type: 'agent.message', target: { address: { ...member.address, projectId: 'other' }, expectedRevision: member.revision }, text: 'must fail' }))
  await assert.rejects(control({ type: 'agent.message', target: { address: member.address, expectedRevision: member.revision - 1 }, text: 'must fail' }))
  pass('main-rejects-cross-project-and-stale-targets')
  await turn('BOARD')
  for (const id of ['stale-revision', 'dependency-claim', 'cycle']) assert.ok(events.some((event) => event.t === 'tool-result' && event.callId === id && event.isError), id)
  assert.ok((await view()).tasks.some((task) => task.scopeOverlap))
  assert.ok(JSON.stringify(requests).includes('TEAM_NOT_MEMBER'))
  pass('team-revision-dependency-cycle-and-write-overlap-with-helper-membership-denied')
  await turn('SOURCE'); snapshot = await view()
  assert.ok(!JSON.stringify(snapshot).includes('P5_PRIVATE_SOURCE'))
  await turn('RETIRE')
  const retiredRequests = requests.filter((row) => row.phase === 'RETIRE')
  assert.ok(!JSON.stringify(retiredRequests).includes('P5_PRIVATE_SOURCE'))
  assert.ok(JSON.stringify(retiredRequests).includes('retired source-derived task text'))
  pass('task-text-retired-before-model-read-and-stays-retired-after-claim')
  holdChildren = true; await turn('CAPACITY'); holdChildren = false; for (const reply of heldReplies.splice(0)) reply()
  snapshot = await view(); assert.equal(snapshot.capacity?.teamUsed, 2); assert.equal(snapshot.capacity?.activeLimit, 3)
  assert.ok(events.some((event) => event.t === 'tool-result' && event.callId === 'over-active' && event.isError))
  assert.ok(events.some((event) => event.t === 'tool-result' && event.callId === 'over-roster' && event.isError))
  assert.ok(!requests.some((row) => (row.request as { messages: { role: string; content: unknown }[] }).messages.some((message) => message.role === 'user' && text(message.content) === '[[FORBIDDEN]]')))
  pass('distinct-roster-and-resident-limits-and-existing-member-reuse')
  await new Promise((done) => setTimeout(done, 350))
  snapshot = await view()
  const lead = snapshot.members.find((row) => row.mode === 'root')!
  await control({ type: 'agent.stop-family', target: { address: lead.address, expectedRevision: lead.revision } })
  await turn('STOPPED'); assert.ok(events.some((event) => event.t === 'tool-result' && event.callId === 'still-full' && event.isError))
  pass('family-stop-does-not-free-roster')
  snapshot = await view()
  const current = snapshot.members.find((row) => `agent:${row.address.sessionId}` === ordinary)!
  const requestId = randomUUID(), command: CollaborationCommand = { type: 'agent.message', target: { address: current.address, expectedRevision: current.revision }, text: '[[CONTINUE]] explicit human instruction' }
  await control(command, requestId)
  await until(() => events.some((event) => event.t === 'collaboration' && (event.view as CollaborationView).members.some((row) => row.address.sessionId === current.address.sessionId && row.outcome === 'completed' && (row.usage.outputTokens ?? 0) > (current.usage.outputTokens ?? 0))), 'HUMAN_CONTINUATION')
  await new Promise((done) => setTimeout(done, 200))
  const latest = (await view()).members.find((row) => row.address.sessionId === current.address.sessionId)!
  const lostId = randomUUID()
  dropReceipt = lostId
  await assert.rejects(control({ type: 'agent.message', target: { address: latest.address, expectedRevision: latest.revision }, text: '[[CONTINUE]] accepted before transport loss' }, lostId), /DSH_HOST_EXITED/)
  // Reconcile by reading after cold recovery. An old address must never execute in a new runtime.
  assert.equal(await host.close(), 0)
  host = startDshHost(options); await host.started; await host.open(workspace, sessionId)
  snapshot = await view()
  assert.equal(snapshot.operation?.requestId, lostId); assert.equal(snapshot.operation?.outcome, 'accepted')
  assert.ok(!JSON.stringify(snapshot).includes('P5_PRIVATE_SOURCE'))
  await assert.rejects(control(command, requestId))
  pass('cold-recovery-keeps-source-retirement-and-operation-receipt-without-replay')
  sessionId = await host.open(workspace)
  phase = 'AUTO'; holdChildren = true
  const beforeAuto = events.length
  host.send(sessionId, '[[AUTO]] synthetic autonomous event', 'followup', null, 'event')
  await until(() => events.slice(beforeAuto).some((event) => event.t === 'turn-end'), 'AUTO_LEAD_IDLE')
  holdChildren = false; for (const reply of heldReplies.splice(0)) reply()
  await until(() => admissions.filter((entry) => entry.phase === 'AUTO').length === 6, 'AUTO_FAMILY_CAP')
  await new Promise((done) => setTimeout(done, 400))
  assert.equal(admissions.filter((entry) => entry.phase === 'AUTO').length, 6)
  assert.ok(admissions.filter((entry) => entry.phase === 'AUTO').every((entry) => entry.bucket === 'autonomous'))
  snapshot = await view()
  assert.ok(snapshot.members.filter((row) => row.mode !== 'root').every((row) => row.activity === 'inactive' && !row.controls.message))
  pass('autonomous-family-shares-six-step-cap-and-bucket-after-lead-is-idle')
  const failedDir = join(root, 'failed-data')
  const failureOptions = { ...options, dataDir: failedDir }
  const failureProfile = prepareDshProfile(failureOptions).profile
  writeFileSync(join(failureProfile, 'cordis.patch.yml'), JSON.stringify([{ id: 'agent-team', config: { maxMembers: 1 } }, { id: 'subagent-spawn-in-process', disabled: true }]))
  assert.equal(await host.close(), 0)
  host = startDshHost(failureOptions); await host.started; sessionId = await host.open(workspace)
  // COEXIST expects successful creation; use STOPPED's single spawn to exercise provider failure.
  await turn('STOPPED'); snapshot = await view()
  assert.equal(snapshot.capacity?.teamUsed, 1); assert.equal(snapshot.members.find((row) => row.mode === 'teammate')?.outcome, 'failed')
  pass('failed-creation-retains-roster-slot')
  assert.equal(await host.close(), 0)
  writeFileSync(join(root, 'report.json'), JSON.stringify({ checks, requests: requests.length, admissions, runtime: JSON.parse(readFileSync(join(repo, 'dsh/runtime/package.json'), 'utf8')), realServices: false }, null, 2))
  writeFileSync(join(root, 'requests.json'), JSON.stringify(requests))
  console.log('P5_EVIDENCE', root)
} finally { writeFileSync(join(root, 'events.json'), JSON.stringify(events)); writeFileSync(join(root, 'requests.json'), JSON.stringify(requests)); console.log('P5_ARTIFACTS', root); await host?.close(); await new Promise<void>((done) => server.close(() => done())) }
