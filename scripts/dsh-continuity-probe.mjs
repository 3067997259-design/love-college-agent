// P0 experiments only: pinned real DSH and unchanged LCA bridge, synthetic loopback model.
// No Electron, real provider, user profile, shell tool or external side effect is involved.
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { prepareDshProfile } from '../dsh/profile.mjs'

const repo = resolve(import.meta.dirname, '..')
const names = process.argv.slice(2).length ? process.argv.slice(2) : ['serial-open', 'concurrent-open', 'inbox-crash', 'cancel-late']
for (const name of names) if (!['serial-open', 'concurrent-open', 'inbox-crash', 'cancel-late'].includes(name)) throw new Error(`Unknown scenario: ${name}`)
const evidenceRoot = join(repo, 'test-results', 'continuous-work-p0')
mkdirSync(evidenceRoot, { recursive: true })
const artifactRoot = mkdtempSync(join(evidenceRoot, 'run-'))
const textOf = (value) => typeof value === 'string' ? value : (value ?? []).map((part) => part?.text ?? '').join('')

async function run(name) {
  const dataDir = join(artifactRoot, name), userHome = join(dataDir, 'user')
  const projects = Object.fromEntries(['A', 'B'].map((key) => [key, join(dataDir, `project-${key}`)]))
  for (const dir of [...Object.values(projects), userHome, join(userHome, 'AppData', 'Roaming'), join(userHome, 'AppData', 'Local')]) mkdirSync(dir, { recursive: true })
  const { home, profile, cli } = prepareDshProfile({ dshRoot: join(repo, 'dsh', 'runtime'), dataDir, bridge: join(repo, 'dsh', 'lca-bridge') })
  writeFileSync(join(profile, 'cordis.patch.yml'), JSON.stringify([{ insert: [{ id: 'continuity-observer', name: pathToFileURL(join(repo, 'scripts', 'fixtures', 'dsh-continuity-observer.mjs')).href }] }]))
  const events = [], requests = [], failures = [], exits = [], sessions = {}, snapshots = []
  let child, phase = 1, pendingCall, bFinished = false, crashFlushed = false, timedOut = false, cancelled = false, postCancelRequests = 0, cancelEventOffset = 0
  const send = (message) => { if (child?.connected) child.send(message, () => {}) }
  const finish = (res, reply) => {
    const base = { id: `p0-${requests.length}`, object: 'chat.completion.chunk', created: 0, model: 'fixture' }
    const chunk = (choices, extra = {}) => res.write(`data: ${JSON.stringify({ ...base, choices, ...extra })}\n\n`)
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    chunk([{ index: 0, delta: reply.tool ? { role: 'assistant', content: null, tool_calls: [{ index: 0, id: reply.id, type: 'function', function: { name: reply.tool, arguments: '{}' } }] } : { role: 'assistant', content: reply.text }, finish_reason: null }])
    chunk([{ index: 0, delta: {}, finish_reason: reply.tool ? 'tool_calls' : 'stop' }])
    chunk([], { usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })
    res.end('data: [DONE]\n\n')
  }
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => { body += chunk })
    req.on('end', () => {
      try {
        if (req.method !== 'POST' || req.url !== '/v1/chat/completions') { res.writeHead(404).end(); return }
        const request = JSON.parse(body), messages = request.messages ?? []
        const index = messages.findLastIndex((message) => message.role === 'user' && /\[\[P0_[AB]_(FIRST|RESUME)\]\]/.test(textOf(message.content)))
        const marker = textOf(messages[index]?.content).match(/\[\[P0_([AB])_(FIRST|RESUME)\]\]/)
        if (!marker) throw new Error('No synthetic P0 marker')
        const key = marker[1], stage = marker[2]
        const after = messages.slice(index + 1), hadTool = after.some((message) => message.role === 'tool')
        if (cancelled && key === 'A') postCancelRequests++
        requests.push({ phase, key, stage, bFinished, request })
        finish(res, stage === 'FIRST' && !hadTool ? { tool: key === 'A' ? 'lca_p0_hold' : 'lca_p0_echo', id: `p0-${key}` } : { text: `P0_DONE_${key}_${stage}` })
      } catch (error) { failures.push(String(error)); res.writeHead(500).end(); send({ t: 'shutdown' }) }
    })
  })
  await new Promise((done) => server.listen(0, '127.0.0.1', done))
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => ['systemroot', 'windir', 'path', 'pathext', 'comspec', 'temp', 'tmp'].includes(key.toLowerCase())))
  Object.assign(env, { HOME: userHome, USERPROFILE: userHome, APPDATA: join(userHome, 'AppData', 'Roaming'), LOCALAPPDATA: join(userHome, 'AppData', 'Local'), AGENTS_HOME: join(userHome, 'agents'), DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1', LCA_GUARDED_ROOTS: home, LCA_CHAT_API_KEY: 'synthetic', HTTP_PROXY: 'http://127.0.0.1:9', HTTPS_PROXY: 'http://127.0.0.1:9', NO_PROXY: '127.0.0.1,localhost',
    LCA_DSH_ROUTES: JSON.stringify({ providers: { fixture: { apiKeyEnv: 'LCA_CHAT_API_KEY', api: 'openai-completions', baseURL: `http://127.0.0.1:${server.address().port}/v1`, models: [{ id: 'fixture' }] } }, chat: { provider: 'fixture', model: 'fixture' }, work: { provider: 'fixture', model: 'fixture' } }) })
  const open = (key) => send({ t: 'open', ref: key, cwd: projects[key], trusted: true, persona: `P0_PERSONA_${key}`, suffix: `P0_SUFFIX_${key}`, binding: { protocolVersion: 2, runtimeId: `p0-runtime-${phase}`, projectId: `p0-project-${key}`, cwd: projects[key] }, ...(sessions[key] ? { sessionId: sessions[key] } : {}) })
  const input = (key, stage) => send({ t: 'send', sessionId: sessions[key], text: `[[P0_${key}_${stage}]] Synthetic fixture only.`, mode: 'followup' })
  const launch = () => new Promise((done) => {
    let stderr = '', opened = new Set(), ended = new Set(), lateTimer
    child = spawn(process.execPath, [cli, '--profile', 'lca'], { cwd: projects.A, env, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] })
    child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-16000) })
    child.on('error', (error) => { failures.push(String(error)); done(-1) })
    child.on('message', (message) => {
      events.push({ phase, ...message })
      if (message.t === 'hello') send({ t: 'init', persona: 'P0_INITIAL', suffix: '', tools: [
        { name: 'lca_p0_hold', description: 'Hold an isolated fixture read.', parameters: {}, source: 'document' },
        { name: 'lca_p0_echo', description: 'Return an isolated fixture value.', parameters: {} },
      ] })
      if (message.t === 'init-ok') { open('A'); if (name === 'concurrent-open' && phase === 1) open('B') }
      if (message.t === 'session') {
        const key = message.ref; sessions[key] = message.sessionId; opened.add(key)
        if (key === 'A' && !(name === 'concurrent-open' && phase === 1)) open('B')
        if (opened.size === 2) {
          if (phase === 2 && name === 'inbox-crash') { send({ t: 'p0-flush', sessionId: sessions.A, ref: 'cold' }) }
          else { input('A', phase === 1 ? 'FIRST' : 'RESUME'); if (phase === 2) input('B', 'RESUME') }
        }
      }
      if (message.t === 'admit') send({ t: 'admit-answer', id: message.id, ok: !(name === 'inbox-crash' && phase === 2) })
      if (message.t === 'approval') send({ t: 'approval-answer', id: message.id, outcome: ['lca_p0_hold', 'lca_p0_echo'].includes(message.toolName) ? 'allowed-once' : 'rejected' })
      if (message.t === 'lca-call') {
        if (message.name === 'lca_p0_echo') send({ t: 'lca-result', id: message.id, ok: true, value: 'P0_ECHO_B' })
        else if (message.name === 'lca_p0_hold') {
          pendingCall = message
          if (name === 'inbox-crash') {
            send({ t: 'send', sessionId: sessions.A, mode: 'steer', origin: 'event', text: 'P0_PENDING_EVENT' })
            send({ t: 'p0-flush', sessionId: sessions.A, ref: 'before-crash' })
          } else if (name === 'cancel-late') {
            cancelled = true; cancelEventOffset = events.length; send({ t: 'cancel', sessionId: sessions.A }); input('B', 'FIRST')
          } else input('B', 'FIRST')
        } else { failures.push(`Unexpected tool ${message.name}`); send({ t: 'shutdown' }) }
      }
      if (message.t === 'turn-end') {
        const key = Object.keys(sessions).find((value) => sessions[value] === message.sessionId)
        ended.add(key)
        if (key === 'B' && phase === 1) {
          bFinished = true
          if (pendingCall) send({ t: 'lca-result', id: pendingCall.id, ok: true, value: 'P0_RAW_DOCUMENT_A', source: 'document' })
          if (name === 'cancel-late') lateTimer = setTimeout(() => send({ t: 'shutdown' }), 500)
        }
        if (ended.size === 2 && name !== 'cancel-late' && name !== 'inbox-crash') send({ t: 'shutdown' })
      }
      if (message.t === 'p0-observed') {
        snapshots.push({ phase, ...message })
        if (message.event === 'failed') { failures.push(message.message); send({ t: 'shutdown' }) }
        if (message.event === 'flushed' && message.ref === 'before-crash') { crashFlushed = true; child.kill('SIGKILL') }
        if (message.event === 'flushed' && message.ref === 'cold') send({ t: 'shutdown' })
      }
      // The test observer has its own control channel; production bridge correctly rejects that command.
      if (message.t === 'error' && message.message !== 'unknown command p0-flush') { failures.push(message.message); send({ t: 'shutdown' }) }
    })
    child.on('exit', (code, signal) => { clearTimeout(lateTimer); exits.push({ phase, code, signal, stderr }); done(code) })
  })
  const timer = setTimeout(() => { timedOut = true; child?.kill('SIGKILL') }, 60_000)
  try {
    await launch()
    if (!timedOut && !failures.length && name !== 'cancel-late') { phase = 2; await launch() }
  } finally { clearTimeout(timer); server.closeAllConnections(); await new Promise((done) => server.close(done)) }
  const text = (row) => JSON.stringify(row.request.messages)
  const first = requests.filter((row) => row.phase === 1)
  const resumed = requests.filter((row) => row.phase === 2)
  const scoped = events.filter((row) => ['admit', 'lca-call', 'approval'].includes(row.t))
  const beforeCrash = snapshots.find((row) => row.event === 'flushed' && row.ref === 'before-crash')
  const queued = beforeCrash && [...beforeCrash.nextTurn, ...beforeCrash.nextStep].find((message) => JSON.stringify(message.content).includes('P0_PENDING_EVENT'))
  const base = { noHarnessFailure: !timedOut && failures.length === 0, bothRootsOpened: Boolean(sessions.A && sessions.B) }
  const checks = name === 'inbox-crash' ? { ...base,
    flushBeforeCrash: crashFlushed,
    queuedBeforeCrash: snapshots.some((row) => row.ref === 'before-crash' && JSON.stringify([...row.nextTurn, ...row.nextStep]).includes('P0_PENDING_EVENT')),
    pendingSurvivesColdResume: snapshots.some((row) => row.phase === 2 && JSON.stringify([...row.nextTurn ?? [], ...row.nextStep ?? []]).includes('P0_PENDING_EVENT')),
    samePendingMessageId: Boolean(queued?.id) && snapshots.some((row) => row.phase === 2 && [...row.nextTurn ?? [], ...row.nextStep ?? []].some((message) => message.id === queued.id)),
    noColdModelRequests: resumed.length === 0,
  } : { ...base,
    ...(name === 'cancel-late' ? { bContinuesAfterACancel: bFinished && first.some((row) => row.key === 'B') }
      : { bCompletesWhileAHeld: bFinished && first.some((row) => row.key === 'B') && first.some((row) => row.key === 'A' && row.bFinished) }),
    personaIsolated: first.length > 0 && first.every((row) => text(row).includes(`P0_PERSONA_${row.key}`) && !text(row).includes(`P0_PERSONA_${row.key === 'A' ? 'B' : 'A'}`)),
    suffixIsolated: first.length > 0 && first.every((row) => text(row).includes(`P0_SUFFIX_${row.key}`) && !text(row).includes(`P0_SUFFIX_${row.key === 'A' ? 'B' : 'A'}`)),
    conversationIsolated: requests.every((row) => !text(row).includes(`[[P0_${row.key === 'A' ? 'B' : 'A'}_`)),
    callbacksBoundToOwner: scoped.length > 0 && scoped.every((row) => {
      const key = Object.keys(sessions).find((value) => sessions[value] === row.sessionId)
      return key && row.origin?.rootSessionId === row.sessionId && row.origin.projectId === `p0-project-${key}` && row.origin.runtimeId === `p0-runtime-${row.phase}`
    }),
    ...(name === 'cancel-late' ? {
      cancelledTurnEnded: events.some((row) => row.t === 'turn-end' && row.sessionId === sessions.A && row.reason?.kind === 'aborted'),
      lateResultCannotResume: postCancelRequests === 0 && !events.slice(cancelEventOffset).some((row) => row.t === 'message' && row.sessionId === sessions.A),
    } : {
      rawSourceReachedAOnly: first.some((row) => row.key === 'A' && text(row).includes('P0_RAW_DOCUMENT_A')) && requests.filter((row) => row.key === 'B').every((row) => !text(row).includes('P0_RAW_DOCUMENT_A')),
      bothRootsResumed: ['A', 'B'].every((key) => resumed.some((row) => row.key === key)),
      coldResumeRetiresRaw: resumed.length > 0 && resumed.every((row) => !text(row).includes('P0_RAW_DOCUMENT_A')),
    }),
  }
  const report = { name, ok: Object.values(checks).every(Boolean), checks, timedOut, failures, sessions, modelRequests: requests.length, exits, requests, events, snapshots }
  writeFileSync(join(dataDir, 'report.json'), JSON.stringify(report, null, 2) + '\n')
  return { name, ok: report.ok, checks, modelRequests: requests.length, failures, report: join(dataDir, 'report.json') }
}
const reports = []
for (const name of names) { const report = await run(name); reports.push(report); console.log(JSON.stringify(report)) }
writeFileSync(join(artifactRoot, 'summary.json'), JSON.stringify({ runtime: JSON.parse(readFileSync(join(repo, 'dsh/runtime/node_modules/@deepseek-ai/dsh/package.json'), 'utf8')).version, reports }, null, 2) + '\n')
console.log(`Evidence: ${artifactRoot}`)
process.exitCode = reports.every((report) => report.ok) ? 0 : 1
