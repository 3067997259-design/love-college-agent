// Read-only metadata audit of one explicitly identified, isolated real-service probe.
// Does not print request context, credentials, tool arguments or internal reasoning.
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

const id = process.argv[2]
assert.match(id ?? '', /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
const continuationId = process.argv[3]
if (continuationId) assert.match(continuationId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
const root = resolve(import.meta.dirname, '..'), data = join(root, '.local-data', 'real-collaboration-' + id), out = join(root, 'test-results', continuationId ? 'real-collaboration-reuse-' + continuationId : 'real-collaboration-' + id)
const report = JSON.parse(readFileSync(join(out, 'report.json'), 'utf8'))
const files = (folder) => readdirSync(folder, { withFileTypes: true }).flatMap((entry) => entry.isDirectory() ? files(join(folder, entry.name)) : [join(folder, entry.name)])
const decode = (file) => {
  const buffer = readFileSync(file), lines = []
  let offset = 0
  while (offset < buffer.length) {
    const result = zstdDecompressSync(buffer.subarray(offset), { info: true })
    assert.ok(result.engine.bytesWritten > 0)
    offset += result.engine.bytesWritten
    lines.push(result.buffer.toString('utf8'))
  }
  return lines.join('').split('\n').filter(Boolean).map((line) => JSON.parse(line))
}
const journal = files(join(data, 'journals')).filter((file) => file.endsWith('.jsonl')).flatMap((file) => readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)))
const sessions = files(join(data, 'dsh-home', 'sessions')).filter((file) => file.endsWith('session.v4.jsonl.zstd')).map((file) => {
  const rows = decode(file)
  const baselineRows = continuationId ? decode(join(report.backup, relative(data, file))).length : 0
  const delta = rows.slice(baselineRows)
  const configs = rows.filter((r) => r.type === 'request/header').map((r) => r.data.header.config)
  return { sessionId: dirname(file).split(/[\\/]/).at(-1), frames: rows.length,
    routes: configs.map((r) => ({ provider: r.provider, model: r.model, effort: r.reasoningEffort ?? null })),
    calls: rows.filter((r) => r.type === 'tool/call').map((r) => r.data.name),
    results: rows.filter((r) => r.type === 'tool/result').map((r) => ({ isError: !!r.data.message?.isError })),
    // Public replies to the deliberately synthetic tasks only; exclude thinking and tool traffic.
    finalReplies: rows.filter((r) => r.type === 'assistant/message' && !r.data.message.content.some((b) => b.type === 'tool-call'))
      .map((r) => r.data.message.content.filter((b) => b.type === 'text').map((b) => b.text).join('')).filter(Boolean).slice(-2).map((text) => text.slice(0, 3000)),
    endings: rows.filter((r) => r.type === 'turn/end').map((r) => ({ kind: r.data.reason?.kind, code: r.data.reason?.error?.code ?? null })),
    usage: rows.filter((r) => r.type === 'assistant/message' && r.data.usage).map((r) => ({ input: r.data.usage.inputTokens, output: r.data.usage.outputTokens, cacheRead: r.data.usage.cacheReadTokens ?? 0 })),
    ...(continuationId ? { delta: { baselineRows, addedRows: delta.length, calls: delta.filter((r) => r.type === 'tool/call').map((r) => r.data.name),
      controlTargets: delta.filter((r) => r.type === 'tool/call' && r.data.name === 'send_message').map((r) => { const args = JSON.parse(r.data.arguments); return { tool: r.data.name, target: args.target ?? args.agent_id ?? null } }),
      replies: delta.filter((r) => r.type === 'assistant/message' && !r.data.message.content.some((b) => b.type === 'tool-call')).map((r) => r.data.message.content.filter((b) => b.type === 'text').map((b) => b.text).join('')).filter(Boolean),
      endings: delta.filter((r) => r.type === 'turn/end').map((r) => r.data.reason?.kind),
      toolErrors: delta.filter((r) => r.type === 'tool/result' && r.data.message?.isError).length } } : {}) }
})
const turns = journal.filter((r) => r.type === 'work/turn').map((entry) => {
  const rows = journal.filter((r) => r.turnId === entry.turnId)
  return { turnId: entry.turnId, sessionId: entry.sessionId,
    models: rows.filter((r) => r.type === 'model/attempt').map((r) => ({ slot: r.slot, status: r.status, attempt: r.attempt })),
    stateChanges: journal.filter((r) => r.type === 'companion/mode' && r.requestId.startsWith('model-state-' + entry.turnId)).map((r) => r.mode),
    activities: rows.filter((r) => r.type === 'work/activity').map((r) => ({ templateId: r.templateId, status: r.status })),
    ending: rows.findLast((r) => r.type === 'turn/end')?.reason ?? null }
})
const first = turns[0]
const handoffPassed = report.cases?.[0]?.name === 'handoff' ? first?.stateChanges.includes('work') && ['chat', 'work'].every((slot) => first.models.some((r) => r.slot === slot && r.status === 'success'))
  && first.activities.some((r) => r.templateId === 'clock.read' && r.status === 'completed') && first.ending === 'completed' : null
const audit = { id, continuationId, runnerOk: report.ok, runnerError: report.error ?? null, applicationHandoffPassed: handoffPassed, turns, sessions,
  limits: report.limits, usage: report.finalState?.usage ?? report.finalUsage, temporaryCredentialsRemoved: report.temporaryCredentialsRemoved }
writeFileSync(join(out, 'audit.json'), JSON.stringify(audit, null, 2))
console.log(JSON.stringify(audit, null, 2))
