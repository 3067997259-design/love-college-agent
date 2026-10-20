// lca-bridge check: drives the real DSH runtime and lca-bridge against a scripted local model, with
// no credentials and no outside network. Scenarios:
// - degrade: turn 1 fetches a page (DSH refuses loopback, which still counts as a web result) and then
//   runs a command, which must ask as a degraded approval. Turn 2 must see that result retired from
//   the model's context and run its command without asking.
// - trust / decline: in an untrusted project where the OS sandbox cannot grant the folder (a D: root
//   without WRITE_DAC on the maintainer's machine), the first failing command must ask about trust
//   instead of showing her the raw ACL error. Trusting reruns the command unsandboxed; declining is
//   asked once per session. Skipped where the sandbox works.
// Usage: node scripts/dsh-bridge-check.mjs [degrade|trust|decline ...]   (needs the DSH fork at DSH_ROOT)
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { createServer } from 'node:http'
import { join, resolve } from 'node:path'
import { prepareDshProfile } from '../dsh/profile.mjs'

const repo = resolve(import.meta.dirname, '..')
const dshRoot = resolve(process.env.DSH_ROOT ?? 'D:/dsh-lca')
const dataDir = resolve(process.env.LCA_DATA_DIR ?? join(repo, '.local-data'))
const textOf = (content) => typeof content === 'string' ? content : (content ?? []).map((part) => part?.text ?? '').join('')
const pwsh = (id, command) => ({ tool: 'pwsh', id, args: { description: 'Print a number', command } })
const resultOf = (seen, id) => seen.results.find((result) => result.callId === id)

const SCENARIOS = {
  degrade: {
    trusted: true, answer: 'allowed-once', turns: ['[[T1]] read the notes, then run a command', '[[T2]] run one more command'],
    script({ turn, lastTool, messages, notes }) {
      if (turn === 1 && !lastTool) return { tool: 'web_fetch', id: 'call_fetch_1', args: { url: 'http://127.0.0.1:9/notes' } }
      if (turn === 1 && lastTool === 'call_fetch_1') return pwsh('call_pwsh_1', 'Write-Output 41')
      if (turn === 2 && !lastTool) {
        const fetched = messages.find((message) => message.role === 'tool' && message.tool_call_id === 'call_fetch_1')
        notes.retiredSeen = fetched ? textOf(fetched.content).includes('LCA retired') : null
        return pwsh('call_pwsh_2', 'Write-Output 42')
      }
      return { text: `done ${turn}` }
    },
    check: (seen, notes) => ({
      turnsCompleted: seen.turnEnds.length === 2 && seen.turnEnds.every((kind) => kind === 'completed'),
      degradedOnceInTurn1: seen.degraded.length === 1 && seen.degraded[0].turn === 1 && seen.degraded[0].sources.join() === 'web',
      turn1CommandAskedAsDegraded: seen.approvals.length === 1 && seen.approvals[0].turn === 1 && seen.approvals[0].kind === 'degraded' && seen.approvals[0].toolName === 'pwsh',
      retiredAtTurn2: seen.retired.length === 1 && seen.retired[0].turn === 2 && seen.retired[0].count === 1,
      modelSawRetiredResult: notes.retiredSeen === true,
      commandsRan: ['call_pwsh_1', 'call_pwsh_2'].every((id) => resultOf(seen, id)?.isError === false),
    }),
  },
  trust: {
    trusted: false, answer: 'allowed-once', turns: ['[[T1]] run a command'],
    script({ lastTool, toolText, notes }) {
      if (!lastTool) return pwsh('call_pwsh_a', 'Write-Output 41')
      if (lastTool === 'call_pwsh_a') { notes.feedback = toolText; return pwsh('call_pwsh_b', 'Write-Output 41') }
      return { text: 'done' }
    },
    skip: (seen) => resultOf(seen, 'call_pwsh_a')?.isError === false && !seen.approvals.length,
    check: (seen, notes) => ({
      askedTrustOnce: seen.approvals.length === 1 && seen.approvals[0].kind === 'trust' && seen.approvals[0].toolName === 'pwsh',
      presetSwitched: seen.trusted.length === 1 && seen.trusted[0].preset === 'lca-trusted',
      sheReadTrustNotAclError: notes.feedback.includes('trusted this project') && !notes.rawSeen,
      rerunSucceeded: resultOf(seen, 'call_pwsh_a')?.isError === true && resultOf(seen, 'call_pwsh_b')?.isError === false,
    }),
  },
  decline: {
    trusted: false, answer: 'rejected', turns: ['[[T1]] run a command'],
    script({ lastTool, toolText, notes }) {
      if (!lastTool) return pwsh('call_pwsh_a', 'Write-Output 41')
      if (lastTool === 'call_pwsh_a') { notes.first = toolText; return pwsh('call_pwsh_b', 'Write-Output 41') }
      if (lastTool === 'call_pwsh_b') notes.second = toolText
      return { text: 'done' }
    },
    skip: (seen) => resultOf(seen, 'call_pwsh_a')?.isError === false && !seen.approvals.length,
    check: (seen, notes) => ({
      askedTrustOnce: seen.approvals.length === 1 && seen.approvals[0].kind === 'trust',
      notTrusted: seen.trusted.length === 0,
      sheReadDeclineBothTimes: [notes.first, notes.second].every((text) => text?.includes('chose not to')) && !notes.rawSeen,
    }),
  },
}

async function run(name) {
  const scenario = SCENARIOS[name]
  const work = join(dataDir, 'dsh-work', `bridge-check-${name}-${randomUUID().slice(0, 8)}`)
  mkdirSync(work, { recursive: true })
  const notes = { rawSeen: false }
  let requests = 0
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => { body += chunk })
    req.on('end', () => {
      if (req.method !== 'POST' || !req.url.endsWith('/chat/completions')) { res.writeHead(404).end(); return }
      requests++
      const messages = JSON.parse(body).messages ?? []
      if (messages.some((message) => message.role === 'tool' && /SetNamedSecurityInfoW|grantWrite\(/.test(textOf(message.content)))) notes.rawSeen = true
      const marker = messages.findLastIndex((message) => message.role === 'user' && /\[\[T\d\]\]/.test(textOf(message.content)))
      const turn = marker < 0 ? 0 : Number(textOf(messages[marker].content).match(/\[\[T(\d)\]\]/)[1])
      const last = messages.slice(marker + 1).filter((message) => message.role === 'tool').at(-1)
      const reply = scenario.script({ turn, lastTool: last?.tool_call_id ?? null, toolText: textOf(last?.content), messages, notes })
      const base = { id: `mock-${requests}`, object: 'chat.completion.chunk', created: 0, model: 'mock' }
      const send = (choices, extra = {}) => res.write(`data: ${JSON.stringify({ ...base, choices, ...extra })}\n\n`)
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      if (reply.tool) send([{ index: 0, delta: { role: 'assistant', content: null, tool_calls: [{ index: 0, id: reply.id, type: 'function', function: { name: reply.tool, arguments: JSON.stringify(reply.args) } }] }, finish_reason: null }])
      else send([{ index: 0, delta: { role: 'assistant', content: reply.text }, finish_reason: null }])
      send([{ index: 0, delta: {}, finish_reason: reply.tool ? 'tool_calls' : 'stop' }])
      send([], { usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })
      res.end('data: [DONE]\n\n')
    })
  })
  await new Promise((done) => server.listen(0, '127.0.0.1', done))
  const { home, cli } = prepareDshProfile({ dshRoot, dataDir, bridge: join(repo, 'dsh', 'lca-bridge') })
  const child = spawn(process.execPath, [cli, '--profile', 'lca'], {
    cwd: work,
    env: { ...process.env, DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1', LCA_GUARDED_ROOTS: join(dataDir, 'dsh-home'), DEEPSEEK_API_KEY: '', NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost',
      LCA_CHAT_BASE_URL: `http://127.0.0.1:${server.address().port}/v1`, LCA_CHAT_MODEL: 'mock', LCA_CHAT_API_KEY: 'mock' },
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  })
  let stderr = ''
  child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-4000) })
  const seen = { approvals: [], degraded: [], retired: [], trusted: [], results: [], turnEnds: [] }
  let sessionId
  const timer = setTimeout(() => { seen.timeout = true; child.kill() }, 120_000)
  child.on('message', (message) => {
    const turn = seen.turnEnds.length + 1
    switch (message.t) {
      case 'hello': child.send({ t: 'init', persona: 'You are a test agent.', suffix: '', tools: [] }); break
      case 'init-ok': child.send({ t: 'open', ref: 'check', cwd: work, trusted: scenario.trusted }); break
      case 'session': sessionId = message.sessionId; child.send({ t: 'send', sessionId, text: scenario.turns[0], mode: 'followup' }); break
      case 'approval':
        seen.approvals.push({ turn, kind: message.kind, toolName: message.toolName, degraded: message.degraded })
        child.send({ t: 'approval-answer', id: message.id, outcome: scenario.answer }); break
      case 'degraded': seen.degraded.push({ turn, sources: message.sources }); break
      case 'retired': seen.retired.push({ turn, count: message.count }); break
      case 'trusted': seen.trusted.push({ turn, preset: message.preset }); break
      case 'tool-result': seen.results.push({ callId: message.callId, isError: message.isError }); break
      case 'turn-end':
        seen.turnEnds.push(message.reason?.kind ?? null)
        if (seen.turnEnds.length < scenario.turns.length) child.send({ t: 'send', sessionId, text: scenario.turns[seen.turnEnds.length], mode: 'followup' })
        else child.send({ t: 'shutdown' })
        break
      case 'error': seen.error = message.message; break
      default: break
    }
  })
  const code = await new Promise((done) => child.on('exit', done))
  clearTimeout(timer); server.close()
  if (scenario.skip?.(seen)) return { name, ok: true, skipped: 'the OS sandbox ran the command here', seen }
  const checks = scenario.check(seen, notes)
  const ok = Object.values(checks).every(Boolean) && !seen.timeout
  if (!ok && stderr) seen.stderr = stderr.split('\n').filter((line) => /error|warn/i.test(line)).slice(-20)
  return { name, ok, checks, ...(ok ? {} : { seen, notes }), modelRequests: requests, exitCode: code }
}

const names = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(SCENARIOS)
const reports = []
for (const name of names) {
  if (!SCENARIOS[name]) throw new Error(`unknown scenario ${name}`)
  reports.push(await run(name))
}
console.log(JSON.stringify(reports, null, 2))
process.exitCode = reports.every((report) => report.ok) ? 0 : 1
