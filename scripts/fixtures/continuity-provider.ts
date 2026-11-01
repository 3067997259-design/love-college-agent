// Runs inside an authorized Electron main process. No connection values or model text leave main.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createServer, type ServerResponse } from 'node:http'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { systemClock as clock } from '../../src/main/clock'
import { readModelProviders, readModelEfforts, type ProviderConfig } from '../../src/main/config/providers'
import { vendorOf } from '../../src/main/config/vendors'
import { createResourceBudget } from '../../src/main/resources/service'
import { openSessionStore } from '../../src/main/store/session'
import { createDshExecution } from '../../src/main/dsh/execution'
import { dshLocations } from '../../src/main/dsh/locations'
import { dshRoutes } from '../../src/main/dsh/routes'
import { builtinTools } from '../../src/main/harness/tools'

const MAX_CALLS = 8, LIMIT = 128_000, TIMEOUT = 45_000
const diagnosticTool = { type: 'function', function: { name: 'diagnostic_echo', description: 'Record the fixed synthetic test value.',
  parameters: { type: 'object', properties: { value: { type: 'string', enum: ['OK'] } }, required: ['value'], additionalProperties: false } } }
type Wire = { model: string; stream: boolean; messages: { role: string; content: string }[]; tools?: typeof diagnosticTool[]; tool_choice?: unknown; max_tokens?: number; stream_options?: { include_usage: boolean } }
type Sample = { label: string; status: number | null; headersMs: number | null; firstEventMs: number | null; firstTextMs: number | null; firstToolMs: number | null;
  elapsedMs: number; tools: number; expectedArguments: boolean; textChars: number; textIsOK: boolean; finishReasons: string[]; inputTokens: number | null; outputTokens: number | null; ok: boolean; error?: string }

/** One parser handles split SSE frames and ordinary JSON; tool arguments remain local to this call. */
async function exchange(config: ProviderConfig, body: unknown, label: string, relay?: ServerResponse): Promise<Sample> {
  const started = clock.nowMs(), abort = new AbortController(), stop = clock.after(TIMEOUT, () => abort.abort())
  const sample: Sample = { label, status: null, headersMs: null, firstEventMs: null, firstTextMs: null, firstToolMs: null, elapsedMs: 0,
    tools: 0, expectedArguments: false, textChars: 0, textIsOK: false, finishReasons: [], inputTokens: null, outputTokens: null, ok: false }
  let text = '', buffer = '', bytes = 0
  const calls = new Map<number, { name: string; args: string }>()
  const consume = (value: Record<string, unknown>) => {
    sample.firstEventMs ??= clock.nowMs() - started
    const usage = value.usage as { prompt_tokens?: number; completion_tokens?: number } | undefined
    if (Number.isSafeInteger(usage?.prompt_tokens)) sample.inputTokens = usage!.prompt_tokens!
    if (Number.isSafeInteger(usage?.completion_tokens)) sample.outputTokens = usage!.completion_tokens!
    for (const choice of (value.choices ?? []) as { delta?: { content?: string; tool_calls?: { index?: number; function?: { name?: string; arguments?: string } }[] }; message?: { content?: string; tool_calls?: { index?: number; function?: { name?: string; arguments?: string } }[] }; finish_reason?: string }[]) {
      const part = choice.delta ?? choice.message
      if (typeof part?.content === 'string' && part.content) { sample.firstTextMs ??= clock.nowMs() - started; text += part.content }
      for (const [position, call] of (part?.tool_calls ?? []).entries()) {
        sample.firstToolMs ??= clock.nowMs() - started
        const index = call.index ?? position, previous = calls.get(index) ?? { name: '', args: '' }
        previous.name += call.function?.name ?? ''; previous.args += call.function?.arguments ?? ''; calls.set(index, previous)
      }
      if (choice.finish_reason) sample.finishReasons.push(['stop', 'tool_calls', 'length', 'content_filter', 'function_call'].includes(choice.finish_reason) ? choice.finish_reason : 'other')
    }
  }
  try {
    const response = await fetch(config.base_url.replace(/\/+$/, '') + '/chat/completions', { method: 'POST', redirect: 'error',
      headers: { Authorization: 'Bearer ' + config.api_key, 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: abort.signal })
    sample.status = response.status; sample.headersMs = clock.nowMs() - started
    if (!response.ok) { sample.error = 'HTTP_ERROR'; await response.body?.cancel(); relay?.writeHead(response.status, { 'Content-Type': 'application/json' }).end('{"error":{"message":"UPSTREAM_HTTP_ERROR"}}'); return sample }
    const streaming = response.headers.get('content-type')?.includes('text/event-stream') ?? false
    relay?.writeHead(200, { 'Content-Type': streaming ? 'text/event-stream' : 'application/json' })
    const reader = response.body?.getReader(); assert.ok(reader, 'EMPTY_BODY')
    const decoder = new TextDecoder()
    try {
      while (true) {
        const { value, done } = await reader.read(); if (done) break
        bytes += value.byteLength; if (bytes > 1024 * 1024) throw new Error('RESPONSE_LIMIT')
        relay?.write(value); buffer += decoder.decode(value, { stream: true })
        if (streaming) {
          let boundary: RegExpExecArray | null
          while ((boundary = /\r?\n\r?\n/.exec(buffer))) {
            const frame = buffer.slice(0, boundary.index); buffer = buffer.slice(boundary.index + boundary[0].length)
            const data = frame.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n')
            if (data && data !== '[DONE]') consume(JSON.parse(data))
          }
        }
      }
      buffer += decoder.decode()
      if (!streaming) consume(JSON.parse(buffer))
      else if (buffer.trim()) throw new Error('INCOMPLETE_SSE')
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
    sample.tools = calls.size; sample.textChars = text.length; sample.textIsOK = text.trim() === 'OK'
    sample.expectedArguments = calls.size === 1 && [...calls.values()].every(call => {
      try { const args = JSON.parse(call.args); return call.name === 'diagnostic_echo' && args.value === 'OK' && Object.keys(args).length === 1 } catch { return false }
    })
    sample.ok = true
  } catch (error) {
    sample.error = abort.signal.aborted ? 'TIMEOUT' : error instanceof Error && ['RESPONSE_LIMIT', 'INCOMPLETE_SSE'].includes(error.message) ? error.message : 'TRANSPORT_OR_RESPONSE_ERROR'
    if (relay && !relay.headersSent) relay.writeHead(502, { 'Content-Type': 'application/json' }).write('{"error":{"message":"PROBE_TRANSPORT_ERROR"}}')
  } finally { stop(); sample.elapsedMs = clock.nowMs() - started; relay?.end() }
  return sample
}

export async function runProviderProbe(options: { data: string; authorized: string; reportFile: string; selfTest: boolean }) {
  const { data, reportFile, selfTest } = options
  const budget = createResourceBudget({ root: join(data, 'probe-budget'), clock, configurable: true })
  assert.equal(budget.dispatch({ type: 'resources.configure', dailyTotalUnits: LIMIT, dailyAutonomousUnits: 0 } as Parameters<typeof budget.dispatch>[0]), undefined)
  let forwarded = 0, denied = 0, fakeServer: ReturnType<typeof createServer> | undefined, gateway: ReturnType<typeof createServer> | undefined
  const samples: Sample[] = [], admissions: { label: string; units: number }[] = []
  const report = { ok: false, selfTest, realServices: !selfTest, limits: { maximumCalls: MAX_CALLS, maximumReservedUnits: LIMIT, autonomousUnits: 0, directRequestTimeoutMs: TIMEOUT },
    stage: 'configuration', samples, admissions, forwardedRequests: 0, deniedRequests: 0, reservedUnits: 0, dsh: null as Record<string, unknown> | null,
    candidateRuntime: dshLocations(), error: null as string | null, sourceConfigurationUnmodified: true, credentialsCopiedToDisk: false }
  const save = () => { report.forwardedRequests = forwarded; report.deniedRequests = denied; report.reservedUnits = budget.view().model.totalReservedUnits ?? 0; writeFileSync(reportFile, JSON.stringify(report, null, 2)) }
  const reserve = (label: string, units: number) => {
    if (forwarded >= MAX_CALLS) { denied++; save(); throw new Error('CALL_LIMIT') }
    budget.reserveModel(units, 'work'); admissions.push({ label, units }); save()
  }
  const listen = async (server: ReturnType<typeof createServer>) => { await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) }); const addr = server.address(); assert.ok(addr && typeof addr === 'object'); return 'http://127.0.0.1:' + addr.port + '/v1' }
  let execution: ReturnType<typeof createDshExecution> | undefined, store: ReturnType<typeof openSessionStore> | undefined
  try {
    let config: ProviderConfig
    const efforts = selfTest ? {} : await readModelEfforts(options.authorized)
    if (selfTest) {
      fakeServer = createServer(async (request, response) => {
        let raw = ''; for await (const chunk of request) raw += chunk
        const body = JSON.parse(raw), diagnostic = body.tools?.some((tool: typeof diagnosticTool) => tool.function.name === 'diagnostic_echo')
        const dsh = body.tools && !diagnostic, hasResult = body.messages.some((message: { role: string }) => message.role === 'tool')
        const call = diagnostic ? { id: 'diagnostic', type: 'function', function: { name: 'diagnostic_echo', arguments: '{"value":"OK"}' } }
          : dsh && !hasResult ? { id: 'clock-probe', type: 'function', function: { name: 'lca_get_clock', arguments: '{}' } } : null
        const value = { choices: [{ [body.stream ? 'delta' : 'message']: call ? { tool_calls: [{ index: 0, ...call }] } : { content: 'OK' }, finish_reason: call ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 200, completion_tokens: 20 } }
        if (body.stream) { response.writeHead(200, { 'Content-Type': 'text/event-stream' }); const frame = 'data: ' + JSON.stringify(value) + '\n\ndata: [DONE]\n\n'; response.write(frame.slice(0, 37)); response.end(frame.slice(37)) }
        else response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(value))
      })
      config = { base_url: await listen(fakeServer), api_key: 'synthetic-only', model: 'synthetic-model' }
    } else {
      const selected = (await readModelProviders(options.authorized)).get('chat'); assert.ok(selected, 'CHAT_UNCONFIGURED'); config = selected
      assert.ok(!vendorOf(config.base_url)?.native, 'NATIVE_PROVIDER_REQUIRES_OWN_PROTOCOL_PROBE')
    }
    assert.ok(report.candidateRuntime.present, 'PACKAGED_DSH_MISSING')
    report.stage = 'direct-protocol'; save()
    for (const label of ['plain', 'auto', 'named', 'named-nonstream', 'required']) {
      const body: Wire = { model: config.model, stream: label !== 'named-nonstream', max_tokens: 128,
        messages: [{ role: 'user', content: label === 'plain' ? 'Reply with OK only.' : 'This is a function-calling compatibility test. Call diagnostic_echo exactly once with value OK. Do not answer in plain text.' }] }
      if (body.stream) body.stream_options = { include_usage: true }
      if (label !== 'plain') { body.tools = [diagnosticTool]; body.tool_choice = label === 'auto' || label === 'required' ? label : { type: 'function', function: { name: 'diagnostic_echo' } } }
      reserve(label, 2000); forwarded++; save()
      const sample = await exchange(config, body, label)
      sample.ok &&= label === 'plain' ? sample.textIsOK && sample.tools === 0 : sample.expectedArguments
      samples.push(sample); save()
      if ([401, 403, 402, 429].includes(sample.status ?? 0)) throw new Error('PROVIDER_REFUSED')
    }
    if (!samples.every(sample => sample.ok)) throw new Error('PROTOCOL_CONTRACT_FAILED')
    report.stage = 'dsh-tool-roundtrip'; save()
    const localKey = randomUUID(), tickets: number[] = [], pending = new Set<Promise<void>>()
    gateway = createServer((request, response) => {
      const task = (async () => {
        if (request.method !== 'POST' || request.url !== '/v1/chat/completions' || request.headers.authorization !== 'Bearer ' + localKey) { response.writeHead(403).end(); return }
        let body = ''; for await (const chunk of request) { body += chunk; if (body.length > 512 * 1024) { response.writeHead(413).end(); return } }
        const parsed = JSON.parse(body)
        if (parsed.model !== config.model || forwarded >= MAX_CALLS || tickets.length === 0) { denied++; save(); response.writeHead(403, { 'Content-Type': 'application/json' }).end('{"error":{"message":"UNADMITTED_REQUEST"}}'); return }
        tickets.shift(); forwarded++; save()
        const sample = await exchange(config, parsed, 'dsh-' + forwarded, response); samples.push(sample); save()
      })().catch(() => { report.error = 'GATEWAY_FAILED'; if (!response.headersSent) response.writeHead(502); response.end() })
      pending.add(task); void task.finally(() => pending.delete(task))
    })
    const relayConfig = { ...config, base_url: await listen(gateway), api_key: localKey }
    const project = join(data, 'probe-project'); mkdirSync(project, { recursive: true })
    store = openSessionStore(join(data, 'probe-book'), { userId: 'provider-probe', characterId: 'provider-probe' }, clock)
    let finish!: () => void; const finished = new Promise<void>(resolve => { finish = resolve }), began = clock.nowMs()
    const localStore = store
    execution = createDshExecution({ store, clock, dataDir: join(data, 'probe-engine'), dshRoot: report.candidateRuntime.root, bridge: report.candidateRuntime.bridge,
      rootPolicy: { role: 'foreground', work: null }, guardedRoots: [join(data, 'probe-book'), join(data, 'probe-engine')], routes: dshRoutes(relayConfig, relayConfig, efforts),
      project: () => project, persona: () => 'This is a bounded synthetic protocol test.', suffix: () => '', tools: () => builtinTools().filter(tool => tool.templateId === 'clock.read'),
      ask: async () => null, admit: ({ units, bucket }) => {
        if (bucket !== 'work' || forwarded + tickets.length >= MAX_CALLS) return 'budget-exceeded'
        try { reserve('dsh-step', units); tickets.push(units); return null } catch { return 'budget-exceeded' }
      }, changed: () => { if (localStore.records().some(row => row.type === 'turn/end')) finish() } })
    const stop = clock.after(90_000, finish)
    try {
      execution.send('Use lca_get_clock exactly once, then reply with only OK. Do not call other tools, delegate, browse, read or write files, or execute commands.', 'provider-probe', 'provider-probe')
      await finished
      const rows = store.records(), completed = rows.some(row => row.type === 'turn/end' && row.reason === 'completed')
      const tools = rows.filter(row => row.type === 'work/activity' && row.status === 'completed')
      const toolVerified = tools.length === 1 && tools[0].type === 'work/activity' && tools[0].templateId === 'clock.read'
      const replyOK = rows.some(row => row.type === 'assistant/message' && row.status === 'complete' && row.text.trim() === 'OK')
      report.dsh = { completed, toolVerified, replyOK, elapsedMs: clock.nowMs() - began, savedChatEffortPreserved: true, localGateway: true, sourceAdapterWithPackagedRuntime: true }
      assert.ok(completed && toolVerified && replyOK && denied === 0, 'DSH_TOOL_ROUNDTRIP_FAILED')
    } finally { stop(); await execution.close(); execution = undefined; await Promise.all(pending) }
    if (selfTest) {
      while (forwarded < MAX_CALLS) { reserve('cap-self-test', 2000); forwarded++; const sample = await exchange(config, { model: config.model, stream: false, messages: [{ role: 'user', content: 'OK' }] }, 'cap-self-test'); assert.ok(sample.textIsOK) }
      assert.throws(() => reserve('ninth-refused', 2000), /CALL_LIMIT/)
      assert.throws(() => budget.reserveModel(LIMIT, 'work'))
      assert.throws(() => budget.reserveModel(1, 'autonomous'))
    }
    report.ok = true; report.stage = 'completed'
  } catch (error) { report.error = error instanceof Error && /^[A-Z_]+$/.test(error.message) ? error.message : 'PROBE_FAILED'; report.stage = 'stopped' }
  finally {
    if (execution) await execution.close().catch(() => {})
    store?.close()
    for (const server of [gateway, fakeServer]) if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) }
    save(); budget.close()
  }
  return { ok: report.ok, stage: report.stage, calls: forwarded, reservedUnits: report.reservedUnits, error: report.error }
}
