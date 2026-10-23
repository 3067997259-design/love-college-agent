// Real pinned DSH + real LCA bridge, scripted loopback provider, disposable HOME/profile/projects.
// Baseline assertions intentionally prove the two open 1.2 gaps. `*-seam` verifies an extension
// point only; passing this probe is not acceptance of a production safety fix.
import { spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { createServer } from 'node:http'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { prepareDshProfile } from '../dsh/profile.mjs'

const repo = resolve(import.meta.dirname, '..')
const artifactRoot = mkdtempSync(join(tmpdir(), 'lca-family-probe-'))
const textOf = (content) => typeof content === 'string' ? content : (content ?? []).map((part) => part?.text ?? '').join('')
const call = (tool, id, args = {}) => ({ tool, id, args })
const names = process.argv.slice(2).length ? process.argv.slice(2) : ['spawn', 'fork', 'team', 'spawn-seam', 'fork-seam', 'team-seam']
for (const name of names) if (!/^(spawn|fork|team)(-seam)?$/.test(name)) throw new Error(`Unknown scenario: ${name}`)

async function run(name) {
  const team = name.startsWith('team'), fork = name.startsWith('fork'), seam = name.endsWith('-seam')
  const dataDir = join(artifactRoot, name), work = join(dataDir, 'project'), userHome = join(dataDir, 'user')
  for (const dir of [work, userHome, join(userHome, 'AppData', 'Roaming'), join(userHome, 'AppData', 'Local')]) mkdirSync(dir, { recursive: true })
  const { home, profile, cli } = prepareDshProfile({ dshRoot: join(repo, 'dsh', 'runtime'), dataDir, bridge: join(repo, 'dsh', 'lca-bridge') })
  // Keep ordinary spawn/fork. Team tools replace ONLY the three colliding control names in this probe.
  const patch = [{ insert: [{ id: 'family-probe', name: pathToFileURL(join(repo, 'scripts', 'fixtures', 'dsh-family-probe.mjs')).href }] }]
  if (team) patch.push({ id: 'tool-subagent-control', disabled: true }, { id: 'tool-subagent-list-agents', disabled: true }, { insert: [
    { id: 'agent-team', name: '@deepseek-ai/dsh-experimental-agent-team', config: { maxMembers: 8, maxTasks: 256, maxMessageBytes: 65536, disposalTimeoutMs: 5000 } },
    { id: 'tool-agent-team', name: '@deepseek-ai/dsh-experimental-tool-agent-team', config: { freshProvider: 'spawn', forkProvider: 'fork' } },
  ] })
  writeFileSync(join(profile, 'cordis.patch.yml'), JSON.stringify(patch, null, 2))
  const events = [], requests = [], contexts = []
  let child, sessionId, memberId, phase = 1, restarting = false, timedOut = false, stderr = '', requestError = null
  const send = (value) => { if (child?.connected) child.send(value, () => {}) }
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => { body += chunk })
    req.on('end', () => {
      try {
        if (req.method !== 'POST' || req.url !== '/v1/chat/completions') { res.writeHead(404).end(); return }
        const request = JSON.parse(body), messages = request.messages ?? []
        const markerIndex = messages.findLastIndex((message) => message.role === 'user' && /\[\[(ROOT|CHILD)[123]\]\]/.test(textOf(message.content)))
        const marker = textOf(messages[markerIndex]?.content).match(/\[\[(ROOT|CHILD)([123])\]\]/)
        if (!marker) throw new Error('No fixture marker in request')
        const role = marker[1], turn = Number(marker[2])
        const last = messages.slice(markerIndex + 1).filter((message) => message.role === 'tool').at(-1)
        const lastId = last?.tool_call_id
        const allText = messages.map((message) => textOf(message.content)).join('\n')
        contexts.push({ role, turn, raw: allText.includes('FAMILY_RAW_SOURCE'), relay: allText.includes('FAMILY_RELAY_SOURCE'), settled: allText.includes('FAMILY_SETTLED_SOURCE'), acl: allText.includes('grantWrite(synthetic fixture)'), approved: messages.some((message) => message.role === 'tool' && textOf(message.content).includes('"approved":true')) })
        requests.push(request)
        let reply
        if (role === 'CHILD') {
          if (turn === 1 && !lastId) reply = call('mcp__family__read', 'read')
          else if (turn === 1 && lastId === 'read') reply = call('family_ask', 'ask')
          else if (turn === 1 && lastId === 'ask') reply = call('family_acl', 'acl')
          else if (turn === 1 && lastId === 'acl') reply = call('send_message', 'relay', team ? { target: 'lead', message: 'FAMILY_RELAY_SOURCE' } : { agent_id: sessionId, message: 'FAMILY_RELAY_SOURCE' })
          else if (turn === 1) reply = { text: 'FAMILY_SETTLED_SOURCE' }
          else reply = { text: `child continuation ${turn} done` }
        } else if (turn === 1 && !lastId) reply = call('family_inspect', 'inspect')
        else if (turn === 1 && lastId === 'inspect' && team) reply = call('team_task_create', 'task-create', { subject: 'fixture task', description: 'Synthetic shared task' })
        else if (turn === 1 && lastId === 'task-create') {
          const task = JSON.parse(textOf(last.content))
          reply = call('team_task_update', 'task-claim', { task_id: task.id, expected_revision: task.revision, action: 'claim' })
        }
        else if (turn === 1 && (lastId === 'inspect' || lastId === 'task-claim')) reply = call(team ? 'spawn_teammate' : fork ? 'subagent_fork' : 'subagent', 'spawn', team ? { name: 'peach', description: 'fixture', prompt: '[[CHILD1]] synthetic task', context: 'fresh' } : { description: 'fixture', prompt: '[[CHILD1]] synthetic task' })
        else if (turn > 1 && !lastId) reply = call('send_message', `continue-${turn}`, team ? { target: 'peach', message: `[[CHILD${turn}]] continue` } : { agent_id: memberId, message: `[[CHILD${turn}]] continue` })
        else if (lastId === 'spawn' || lastId === `continue-${turn}`) reply = call('family_wait', `wait-${turn}`, { id: memberId, count: turn === 3 ? 1 : turn })
        else reply = { text: `ROOT_DONE_${turn}` }
        const base = { id: `fixture-${requests.length}`, object: 'chat.completion.chunk', created: 0, model: 'fixture' }
        const chunk = (choices, extra = {}) => res.write(`data: ${JSON.stringify({ ...base, choices, ...extra })}\n\n`)
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        chunk([{ index: 0, delta: reply.tool ? { role: 'assistant', content: null, tool_calls: [{ index: 0, id: reply.id, type: 'function', function: { name: reply.tool, arguments: JSON.stringify(reply.args) } }] } : { role: 'assistant', content: reply.text }, finish_reason: null }])
        chunk([{ index: 0, delta: {}, finish_reason: reply.tool ? 'tool_calls' : 'stop' }]); chunk([], { usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }); res.end('data: [DONE]\n\n')
      } catch (error) { requestError = String(error); res.writeHead(500).end(); send({ t: 'shutdown' }) }
    })
  })
  await new Promise((done) => server.listen(0, '127.0.0.1', done))
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => ['systemroot', 'windir', 'path', 'pathext', 'comspec', 'temp', 'tmp'].includes(key.toLowerCase())))
  Object.assign(env, { HOME: userHome, USERPROFILE: userHome, APPDATA: join(userHome, 'AppData', 'Roaming'), LOCALAPPDATA: join(userHome, 'AppData', 'Local'), AGENTS_HOME: join(userHome, 'agents'), DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1', LCA_GUARDED_ROOTS: home, LCA_CHAT_API_KEY: 'synthetic', LCA_FAMILY_SEAM: seam ? 'candidate' : '', HTTP_PROXY: 'http://127.0.0.1:9', HTTPS_PROXY: 'http://127.0.0.1:9', NO_PROXY: '127.0.0.1,localhost',
    LCA_DSH_ROUTES: JSON.stringify({ providers: { fixture: { apiKeyEnv: 'LCA_CHAT_API_KEY', api: 'openai-completions', baseURL: `http://127.0.0.1:${server.address().port}/v1`, models: [{ id: 'fixture' }] } }, chat: { provider: 'fixture', model: 'fixture' }, work: { provider: 'fixture', model: 'fixture' } }) })
  const launch = () => new Promise((done) => {
    child = spawn(process.execPath, [cli, '--profile', 'lca'], { cwd: work, env, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] })
    child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-12000) })
    child.on('error', (error) => { requestError = String(error); done(-1) })
    let rootDone = false
    child.on('message', (message) => {
      events.push(message)
      if (message.t === 'probe' && message.event === 'created' && message.parent === sessionId) memberId = message.id
      if (message.t === 'hello') send({ t: 'init', persona: 'Synthetic local test agent.', suffix: '', tools: [] })
      if (message.t === 'init-ok') send({ t: 'open', ref: 'fixture', cwd: work, trusted: true, binding: { protocolVersion: 2, runtimeId: `fixture-runtime-${phase}`, projectId: 'fixture-project', cwd: work }, ...(sessionId ? { sessionId } : {}) })
      if (message.t === 'session') { sessionId = message.sessionId; send({ t: 'send', sessionId, text: `[[ROOT${phase}]] synthetic task`, mode: 'followup' }) }
      if (message.t === 'admit') send({ t: 'admit-answer', id: message.id, ok: true })
      if (message.t === 'approval') send({ t: 'approval-answer', id: message.id, outcome: 'allowed-once' })
      if (message.t === 'message' && message.text === `ROOT_DONE_${phase}`) rootDone = true
      if (message.t === 'turn-end' && rootDone) {
        rootDone = false
        if (phase === 1) { phase = 2; send({ t: 'send', sessionId, text: '[[ROOT2]] synthetic task', mode: 'followup' }) }
        else { restarting = phase === 2; send({ t: 'shutdown' }) }
      }
    })
    child.on('exit', (code) => done(code))
  })
  const timer = setTimeout(() => { timedOut = true; child?.kill() }, 60_000)
  const exits = [await launch()]
  if (restarting && !timedOut) { phase = 3; exits.push(await launch()) }
  clearTimeout(timer); await new Promise((done) => server.close(done))
  const children = events.filter((event) => event.t === 'probe' && event.event === 'created' && event.parent === sessionId)
  const steps = events.filter((event) => event.t === 'probe' && event.event === 'step' && event.id === memberId)
  const inspect = events.find((event) => event.t === 'probe' && event.event === 'inspect')
  const approvals = events.filter((event) => event.t === 'approval')
  const scoped = events.filter((event) => ['admit', 'approval', 'lca-call', 'question'].includes(event.t))
  const everyContext = (role, turn, check) => { const rows = contexts.filter((entry) => entry.role === role && entry.turn === turn); return rows.length > 0 && rows.every(check) }
  const retired = events.filter((event) => event.t === 'probe' && event.event === 'retirement-seam' && (event.results > 0 || event.messages > 0))
  const checks = {
    terminated: !timedOut && !requestError && exits.length === 2 && exits.every((code) => code === 0),
    originOnEveryRequest: scoped.length > 0 && scoped.every((event) => event.origin?.protocolVersion === 2 && event.origin.projectId === 'fixture-project' && event.origin.rootSessionId === sessionId && event.origin.sessionId && events.some((row) => row.t === 'member' && JSON.stringify(row.origin) === JSON.stringify(event.origin))),
    childCreatedAndColdResumed: children.length >= 2 && children.some((entry) => entry.source === 'resume') && contexts.some((entry) => entry.role === 'CHILD' && entry.turn === 3),
    policySeededNever: children[0]?.approval === 'never',
    seamBeforeEveryRequest: steps.length > 0 && steps.every((step) => step.approval === (seam ? 'ask' : 'never')),
    s1Approval: seam ? approvals.some((event) => event.toolName === 'family_ask') && contexts.some((entry) => entry.role === 'CHILD' && entry.approved) : !approvals.some((event) => event.toolName === 'family_ask') && !contexts.some((entry) => entry.role === 'CHILD' && entry.approved),
    s1ChildAclNotTranslated: contexts.some((entry) => entry.role === 'CHILD' && entry.acl) && !approvals.some((event) => event.kind === 'trust'),
    s2ChildContinuation: everyContext('CHILD', 2, (entry) => entry.raw === !seam),
    s2ColdResume: everyContext('CHILD', 3, (entry) => entry.raw === !seam),
    s2ParentRelayAndSettlement: everyContext('ROOT', 2, (entry) => entry.relay === !seam && entry.settled === !seam),
    retirementPreservesLog: !seam || retired.length > 0 && retired.every((event) => event.originalStillInLog),
    managerSeam: inspect?.manager.length === 9,
    toolsCoexist: ['subagent', 'subagent_fork', 'send_message', 'list_agents', ...(team ? ['spawn_teammate', 'team_task_create'] : [])].every((name) => requests[0]?.tools.filter((tool) => tool.function.name === name).length === 1),
    teamTaskClaim: !team || events.some((event) => event.t === 'probe' && event.event === 'tool/result' && event.id === sessionId && event.data.message.toolCallId === 'task-claim' && !event.data.message.isError),
  }
  const report = { name, ok: Object.values(checks).every(Boolean), checks, modelRequests: requests.length, exits, error: requestError, artifactDir: dataDir }
  writeFileSync(join(dataDir, 'evidence.json'), JSON.stringify({ report, contexts, events, requests, stderr }, null, 2))
  return report
}
const reports = []
for (const name of names) { const report = await run(name); reports.push(report); console.log(JSON.stringify(report)) }
writeFileSync(join(artifactRoot, 'report.json'), JSON.stringify(reports, null, 2))
console.log(`Synthetic evidence: ${artifactRoot}`)
process.exitCode = reports.every((report) => report.ok) ? 0 : 1
