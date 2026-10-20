// lca-bridge check: drives the real DSH runtime and lca-bridge against a scripted local model, with
// no credentials and no outside network. Turn 1 fetches a page (DSH refuses loopback, which still
// counts as a web result) and then runs a command, which must ask as a degraded approval. Turn 2 must
// see that result retired from the model's context and run its command without asking.
// Usage: node scripts/dsh-bridge-check.mjs   (needs the DSH fork built at DSH_ROOT, default D:/dsh-lca)
import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { createServer } from 'node:http'
import { join, resolve } from 'node:path'
import { prepareDshProfile } from '../dsh/profile.mjs'

const repo = resolve(import.meta.dirname, '..')
const dshRoot = resolve(process.env.DSH_ROOT ?? 'D:/dsh-lca')
const dataDir = resolve(process.env.LCA_DATA_DIR ?? join(repo, '.local-data'))
const work = join(dataDir, 'dsh-work', 'bridge-check')
mkdirSync(work, { recursive: true })

// Scripted model: OpenAI-compatible streaming chat completions, keyed on [[T1]] / [[T2]] markers.
const mock = { requests: 0, retiredSeen: null }
const textOf = (content) => typeof content === 'string' ? content : (content ?? []).map((part) => part?.text ?? '').join('')
const script = (messages) => {
  const marker = messages.findLastIndex((message) => message.role === 'user' && /\[\[T\d\]\]/.test(textOf(message.content)))
  const turn = marker < 0 ? 0 : Number(textOf(messages[marker].content).match(/\[\[T(\d)\]\]/)[1])
  const lastTool = messages.slice(marker + 1).filter((message) => message.role === 'tool').at(-1)?.tool_call_id ?? null
  if (turn === 1 && !lastTool) return { tool: 'web_fetch', id: 'call_fetch_1', args: { url: 'http://127.0.0.1:9/notes' } }
  if (turn === 1 && lastTool === 'call_fetch_1') return { tool: 'pwsh', id: 'call_pwsh_1', args: { description: 'Print a number', command: 'Write-Output 41' } }
  if (turn === 2 && !lastTool) {
    const fetched = messages.find((message) => message.role === 'tool' && message.tool_call_id === 'call_fetch_1')
    mock.retiredSeen = fetched ? textOf(fetched.content).includes('LCA retired') : null
    return { tool: 'pwsh', id: 'call_pwsh_2', args: { description: 'Print a number', command: 'Write-Output 42' } }
  }
  return { text: `done ${turn}` }
}
const server = createServer((req, res) => {
  let body = ''
  req.on('data', (chunk) => { body += chunk })
  req.on('end', () => {
    if (req.method !== 'POST' || !req.url.endsWith('/chat/completions')) { res.writeHead(404).end(); return }
    mock.requests++
    const reply = script(JSON.parse(body).messages ?? [])
    const base = { id: `mock-${mock.requests}`, object: 'chat.completion.chunk', created: 0, model: 'mock' }
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
const port = server.address().port

const { home, cli } = prepareDshProfile({ dshRoot, dataDir, bridge: join(repo, 'dsh', 'lca-bridge') })
const child = spawn(process.execPath, [cli, '--profile', 'lca'], {
  cwd: work,
  env: { ...process.env, DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1', LCA_GUARDED_ROOTS: dataDir, DEEPSEEK_API_KEY: '', NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost',
    LCA_CHAT_BASE_URL: `http://127.0.0.1:${port}/v1`, LCA_CHAT_MODEL: 'mock', LCA_CHAT_API_KEY: 'mock' },
  stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
})
let stderr = ''
child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-4000) })
const seen = { approvals: [], degraded: [], retired: [], results: [], turnEnds: [] }
let sessionId
const timer = setTimeout(() => { seen.timeout = true; child.kill() }, 120_000)
child.on('message', (message) => {
  switch (message.t) {
    case 'hello': child.send({ t: 'init', persona: 'You are a test agent.', suffix: '', tools: [] }); break
    case 'init-ok': child.send({ t: 'open', ref: 'check', cwd: work, trusted: true }); break
    case 'session': sessionId = message.sessionId; child.send({ t: 'send', sessionId, text: '[[T1]] read the notes, then run a command', mode: 'followup' }); break
    case 'approval':
      seen.approvals.push({ turn: seen.turnEnds.length + 1, kind: message.kind, toolName: message.toolName, degraded: message.degraded })
      child.send({ t: 'approval-answer', id: message.id, outcome: 'allowed-once' }); break
    case 'degraded': seen.degraded.push({ turn: seen.turnEnds.length + 1, sources: message.sources }); break
    case 'retired': seen.retired.push({ turn: seen.turnEnds.length + 1, count: message.count }); break
    case 'tool-result': seen.results.push({ callId: message.callId, isError: message.isError }); break
    case 'turn-end':
      seen.turnEnds.push(message.reason?.kind ?? null)
      if (seen.turnEnds.length === 1) child.send({ t: 'send', sessionId, text: '[[T2]] run one more command', mode: 'followup' })
      else child.send({ t: 'shutdown' })
      break
    case 'error': seen.error = message.message; break
    default: break
  }
})
child.on('exit', (code) => {
  clearTimeout(timer); server.close()
  const checks = {
    turnsCompleted: seen.turnEnds.length === 2 && seen.turnEnds.every((kind) => kind === 'completed'),
    degradedOnceInTurn1: seen.degraded.length === 1 && seen.degraded[0].turn === 1 && seen.degraded[0].sources.join() === 'web',
    turn1CommandAskedAsDegraded: seen.approvals.length === 1 && seen.approvals[0].turn === 1 && seen.approvals[0].kind === 'degraded' && seen.approvals[0].toolName === 'pwsh',
    retiredAtTurn2: seen.retired.length === 1 && seen.retired[0].turn === 2 && seen.retired[0].count === 1,
    modelSawRetiredResult: mock.retiredSeen === true,
    commandsRan: ['call_pwsh_1', 'call_pwsh_2'].every((id) => seen.results.some((result) => result.callId === id && !result.isError)),
  }
  const ok = Object.values(checks).every(Boolean)
  console.log(JSON.stringify({ ok, checks, seen, modelRequests: mock.requests, exitCode: code }, null, 2))
  if (!ok && stderr) console.error(stderr.split('\n').filter((line) => /error|warn/i.test(line)).slice(-20).join('\n'))
  process.exitCode = ok ? 0 : 1
})
