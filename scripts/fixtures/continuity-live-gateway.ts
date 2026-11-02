// Isolated Electron main only. Real credentials never enter the runner or renderer.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, relative, isAbsolute } from 'node:path'
import { readModelProviders, readModelEfforts, type ProviderConfig } from '../../src/main/config/providers'
import { modelCapabilityRef } from '../../src/main/config/model-capabilities'
import { vendorOf } from '../../src/main/config/vendors'
import { createResourceBudget } from '../../src/main/resources/service'
import { systemClock as clock } from '../../src/main/clock'
import { completedJournalRecords } from './world-probe-admission'
import { createWorldProbeStream } from './world-probe-stream'
import { observeProbeTransport } from './probe-transport'
import { createProbeResponseDeadline } from './probe-response-deadline'
import { createContinuityProbeBudget, compactAdmission } from './continuity-live-budget'
import { createContinuityScriptedModel, requestObjects, workPackage, scriptedResponse, messageText, type ProbeRequest } from './continuity-scripted-model'
import plan from '../continuity-live-plan.json'

const files = (dir: string): string[] => !existsSync(dir) ? [] : readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() && !['chromium', 'dsh-home', 'artifacts', 'rooms'].includes(e.name) ? files(join(dir, e.name)) : e.isFile() ? [join(dir, e.name)] : [])
const hash = (text: string) => createHash('sha256').update(text).digest('hex')
export async function startContinuityGateway(input: { root: string; batch: 'work' | 'memory'; selfTest: boolean; firstRequestOnly?: boolean; captureOnly?: boolean; authorized?: string; embeddingConfig?: string }) {
  assert.ok(process.versions.electron, 'ELECTRON_MAIN_REQUIRED')
  const { root, batch, selfTest, firstRequestOnly = false, captureOnly = false } = input, fullLimits = plan.batches.find(p => p.id === batch)!
  assert.ok(!firstRequestOnly || batch === 'work', 'FIRST_REQUEST_WORK_ONLY')
  assert.ok(!captureOnly || firstRequestOnly && !selfTest, 'CAPTURE_SCOPE_REQUIRED')
  const limits = firstRequestOnly ? { ...fullLimits, ...plan.firstRequestLimits } : fullLimits
  assert.ok(limits && ['work', 'memory'].includes(batch), 'INVALID_BATCH')
  mkdirSync(root, { recursive: true }); writeFileSync(join(root, 'gateway-start.json'), JSON.stringify({ batch, selfTest, limits, responseTimeouts: plan.defaults.responseTimeouts }), { flag: 'wx' })
  const ledger = createResourceBudget({ root: join(root, 'budget'), clock, configurable: true })
  assert.equal(ledger.dispatch({ protocolVersion: 1, epoch: 'probe', requestId: randomUUID(), type: 'resources.configure', dailyTotalUnits: limits.maximumReservedUnits, dailyAutonomousUnits: limits.maximumAutonomousUnits }), undefined)
  const budget = createContinuityProbeBudget(limits, (units, bucket) => ledger.reserveModel(units, bucket))
  const config: Record<string, ProviderConfig> = {}
  const efforts = selfTest ? {} : await readModelEfforts(input.authorized!)
  if (selfTest) for (const slot of ['chat', 'work', 'background']) config[slot] = { base_url: 'http://127.0.0.1', api_key: 'synthetic-only', model: 'probe-' + slot, capabilities: { contextWindow: 131072, maxOutputTokens: 8192 } }
  else {
    assert.ok(input.authorized, 'AUTHORIZED_CONNECTION_REQUIRED')
    const saved = await readModelProviders(input.authorized), chat = saved.get('chat')
    assert.ok(chat, 'CHAT_UNCONFIGURED'); config.chat = chat
    // The approved probe uses the saved chat model for every test lane; it never silently changes daily settings.
    config.work = chat; config.background = chat
    assert.ok(!vendorOf(chat.base_url)?.native, 'NATIVE_PROTOCOL_UNSUPPORTED')
  }
  let embedding: { baseUrl: string; apiKey: string; model: string } | undefined
  if (batch === 'memory') {
    if (selfTest) embedding = { baseUrl: 'http://127.0.0.1', apiKey: 'synthetic-only', model: 'probe-vector-768' }
    else {
      assert.ok(input.embeddingConfig, 'AUTHORIZED_EMBEDDING_CONFIG_REQUIRED')
      const saved = JSON.parse(readFileSync(input.embeddingConfig, 'utf8'))
      const value = saved.embedding; assert.ok(value && typeof value.baseUrl === 'string' && typeof value.apiKey === 'string' && typeof value.model === 'string', 'EMBEDDING_CONFIGURATION_INVALID')
      const url = new URL(value.baseUrl); assert.ok(['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash, 'EMBEDDING_CONFIGURATION_INVALID')
      embedding = value
    }
  }
  let profile = '', phase = 'bootstrap', halted = false
  const baseline = new Set<string>(), samples: Record<string, unknown>[] = [], captured: Record<string, unknown>[] = [], denials: Record<string, unknown>[] = []
  const active = new Set<AbortController>(), fake = createContinuityScriptedModel(), key = randomUUID()
  const rows = () => [join(profile, 'journals'), join(profile, 'continuous-work')].flatMap(files).filter(f => /[\\/]journals[\\/]/.test(f) && f.endsWith('.jsonl')).flatMap(file => completedJournalRecords(readFileSync(file, 'utf8')).map(row => ({ file, row, ticket: hash(file + ':' + row.turnId + ':' + row.attempt + ':' + row.slot) })))
  const usage = () => completedJournalRecords(readFileSync(join(profile, 'runtime-resources/usage.jsonl'), 'utf8'))
  let compactBaseline = new Set<string>()
  const state = () => ({ batch, selfTest, firstRequestOnly, captureOnly, upstreamRequests: selfTest || captureOnly ? 0 : budget.view().modelRequests + budget.view().embeddingRequests, phase, halted, ...budget.view(), inFlight: active.size, samples, denials, captures: captured })
  const save = () => writeFileSync(join(root, 'gateway-report.json'), JSON.stringify(state(), null, 2))
  const server = createServer((req, res) => { void (async () => {
    assert.ok(req.method === 'POST' && req.headers.authorization === 'Bearer ' + key && !req.headers.origin && profile && !halted, 'UNADMITTED_REQUEST')
    // A diagnostic retry is one upstream response, never a resumed work batch.
    if (firstRequestOnly && budget.view().modelRequests >= 1) { denials.push({ phase, code: 'FIRST_REQUEST_SCOPE_COMPLETE' }); save(); res.writeHead(403); res.end(); return }
    const slot = /^\/(chat|work|background|embedding)\/v1\/(chat\/completions|embeddings)$/.exec(req.url ?? '')?.[1]
    assert.ok(slot && (slot !== 'background' || batch === 'memory') && (slot !== 'embedding' || embedding), 'SLOT_NOT_AUTHORIZED')
    let raw = ''; for await (const chunk of req) { raw += chunk; assert.ok(raw.length <= 2 * 1024 * 1024, 'INPUT_TOO_LARGE') }
    const body = JSON.parse(raw) as ProbeRequest & { input?: string }, isEmbedding = slot === 'embedding'
    assert.equal(body.model, isEmbedding ? embedding!.model : config[slot].model, 'MODEL_CHANGED')
    let units: number, ticket: string, bucket: 'work' | 'autonomous'
    if (isEmbedding) {
      assert.equal(typeof body.input, 'string', 'EMBEDDING_INPUT_INVALID')
      ticket = randomUUID(); budget.embedding(ticket, body.input!); units = Buffer.byteLength(body.input!, 'utf8') + 2048; bucket = 'autonomous'
    } else {
      const worker = workPackage(body)
      const candidates = rows().filter(({ file, row, ticket }) => row.type === 'model/attempt' && row.status === 'started' && row.slot === slot && !baseline.has(ticket) && !budget.consumed(ticket)
        && (worker ? file.includes(worker.identity.workId) && file.includes(String(worker.identity.generation)) : !/[\\/]runs[\\/]/.test(file)))
      if (batch === 'memory' && phase === 'compact' && slot === 'chat' && !worker && candidates.length === 0) {
        ({ ticket, units, bucket } = compactAdmission(usage(), compactBaseline, budget.consumed))
      } else {
        assert.equal(candidates.length, 1, 'APPLICATION_ADMISSION_AMBIGUOUS')
        const receipt = candidates[0]; ticket = receipt.ticket; units = receipt.row.reservedTokens as number
        bucket = receipt.row.bucket === 'autonomous' ? 'autonomous' : 'work'
      }
      budget.model(ticket, units, bucket)
      const refs = requestObjects(body).filter(o => o.memoryReference || o.memoryDirectory || o.workCheckpoints || o.kind === 'work-package' || o.kind === 'work-decision-update')
      captured.push({ phase, slot, ticket, references: refs, tools: body.tools?.map(t => t.function.name) ?? [], ...(selfTest ? { toolResults: body.messages.filter(m => m.role === 'tool').slice(-2) } : {}), userInput: slot === 'background' ? undefined : messageText(body.messages.findLast(m => m.role === 'user')?.content).split('\n\n').at(-1),
        ...(slot === 'background' ? { extractionInput: requestObjects(body).findLast(o => 'userText' in o || 'assistantText' in o) ?? null } : {}) })
    }
    const sample: Record<string, unknown> = { phase, slot, ticket, units, bucket, startedAt: new Date(clock.nowMs()).toISOString(), ok: false, error: null, status: null, inputTokens: null, outputTokens: null }
    samples.push(sample); save()
    const abort = new AbortController(); active.add(abort)
    const began = clock.nowMs(), deadline = createProbeResponseDeadline(clock, plan.defaults.responseTimeouts, () => abort.abort())
    sample.responseTiming = deadline.diagnostics
    const onAbort = () => { deadline.stop(); if (!sample.ok) sample.cancelReason ??= deadline.diagnostics.timeoutPhase ? 'timeout' : 'gateway-closed-or-cancelled' }
    abort.signal.addEventListener('abort', onAbort, { once: true })
    const onClose = () => { if (!res.writableEnded) { sample.cancelReason = 'downstream-closed'; abort.abort() } }
    res.on('close', onClose)
    let transport: ReturnType<typeof observeProbeTransport> | undefined
    try {
      let response: Response
      if (captureOnly) {
        assert.ok(!isEmbedding && !raw.includes(config[slot].api_key), 'CAPTURE_CREDENTIAL_OR_SCOPE_VIOLATION')
        writeFileSync(join(root, 'captured-request.json'), raw, { flag: 'wx' })
        sample.captureSha256 = hash(raw)
        response = new Response(scriptedResponse(body, { text: 'REQUEST_CAPTURED_OFFLINE' }), { headers: { 'content-type': body.stream ? 'text/event-stream' : 'application/json' } })
      } else if (selfTest) {
        if (isEmbedding) {
          // A declared beverage fixture cluster exercises retrieval wiring, never semantic quality.
          const digest = createHash('sha256').update(/饮料|喝茶|咖啡/.test(body.input!) ? 'synthetic-beverage-cluster' : body.input!).digest()
          const vector = Array.from({ length: 768 }, (_, i) => (digest[i % digest.length] - 128) / 128)
          response = new Response(JSON.stringify({ data: [{ embedding: vector, index: 0 }], usage: { prompt_tokens: 10, total_tokens: 10 } }), { headers: { 'content-type': 'application/json' } })
        } else response = new Response(scriptedResponse(body, fake(body, phase, slot)), { headers: { 'content-type': body.stream ? 'text/event-stream' : 'application/json' } })
      } else {
        const endpoint = (isEmbedding ? embedding!.baseUrl : config[slot].base_url).replace(/\/+$/, '') + (isEmbedding ? '/embeddings' : '/chat/completions')
        transport = observeProbeTransport(endpoint, () => clock.nowMs()); sample.transport = transport.diagnostics
        response = await fetch(endpoint, { method: 'POST', redirect: 'error', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + (isEmbedding ? embedding!.apiKey : config[slot].api_key) }, body: raw, signal: abort.signal })
      }
      deadline.headers(); sample.status = response.status; assert.ok(response.ok && response.body, 'PROVIDER_FAILED')
      res.writeHead(200, { 'Content-Type': body.stream && !isEmbedding ? 'text/event-stream' : 'application/json' })
      const reader = response.body.getReader(), decoder = new TextDecoder(), stream = createWorldProbeStream((i, o) => { sample.inputTokens = i; sample.outputTokens = o })
      let bytes = 0, json = ''
      try {
        while (true) {
          const chunk = await reader.read(); if (chunk.done) break
          deadline.chunk(chunk.value.length)
          bytes += chunk.value.length; assert.ok(bytes <= 2 * 1024 * 1024, 'RESPONSE_TOO_LARGE')
          const text = decoder.decode(chunk.value, { stream: true })
          if (body.stream && !isEmbedding) { stream.push(text); res.write(chunk.value); if (stream.terminalSentinelSeen()) { stream.end(); sample.ok = true; sample.completionBasis = 'sentinel'; deadline.complete(); res.end(); abort.abort(); break } }
          else json += text
        }
        if (!sample.ok) {
          if (body.stream && !isEmbedding) { stream.push(decoder.decode()); stream.end(); sample.completionBasis = 'eof' }
          else { json += decoder.decode(); const parsed = JSON.parse(json); assert.ok(isEmbedding ? Array.isArray(parsed.data?.[0]?.embedding) : parsed.choices?.[0]?.message, 'INVALID_RESPONSE'); res.write(json); sample.inputTokens = parsed.usage?.prompt_tokens ?? null; sample.outputTokens = parsed.usage?.completion_tokens ?? null }
          sample.ok = true; deadline.complete()
        }
      } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
      sample.stream = body.stream && !isEmbedding ? stream.diagnostics() : null
    } catch (error) {
      if (selfTest) sample.fixtureDiagnostic = { message: error instanceof Error ? error.message : String(error), request: body }
      halted = true; sample.ok = false; sample.error = deadline.diagnostics.timeoutPhase ? 'TIMEOUT' : error instanceof Error && /^[A-Z_:]+$/.test(error.message) ? error.message : 'RESPONSE_FAILED'
      if (!res.headersSent) res.writeHead(502)
    } finally { transport?.close(); deadline.stop(); abort.signal.removeEventListener('abort', onAbort); res.off('close', onClose); active.delete(abort); sample.elapsedMs = clock.nowMs() - began; res.end(); save() }
  })().catch(error => { halted = true; denials.push({ phase, code: error instanceof Error ? error.message.match(/^[A-Z_]+/)?.[0] ?? error.name : 'GATEWAY_ERROR' }); save(); if (!res.headersSent) res.writeHead(403); res.end() }) })
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done)); const address = server.address(); assert.ok(address && typeof address !== 'string')
  const endpoint = 'http://127.0.0.1:' + address.port, providers: Record<string, unknown> = {}, capabilities: Record<string, unknown> = {}
  for (const slot of ['chat', 'work', 'background']) {
    const relay = { base_url: endpoint + '/' + slot + '/v1', model: config[slot].model, api_key: key }; providers[slot] = relay
    if (config[slot].capabilities) capabilities[modelCapabilityRef(relay)] = config[slot].capabilities
  }
  providers.privacy = { base_url: endpoint + '/blocked/v1', model: 'blocked', api_key: key }
  const providersFile = join(root, 'relay-providers.json')
  writeFileSync(providersFile, JSON.stringify({ providers, routing: { background: 'independent', privacy: 'independent', work: 'independent' }, efforts, modelCapabilities: capabilities }))
  save()
  return {
    providersFile, state,
    reconcileRestoredAdmissions: () => { assert.equal(active.size, 0, 'RESTORE_HAS_ACTIVE_REQUEST'); for (const row of rows()) baseline.add(row.ticket) },
    activate: (next: string) => {
      const sub = relative(root, next); assert.ok(sub && !sub.startsWith('..') && !isAbsolute(sub)); profile = next
      // Seed only the closed synthetic profile; normal product settings cannot edit this policy.
      const policy = createResourceBudget({ root: join(next, 'runtime-resources'), clock, configurable: true })
      try { if (!policy.limitsConfigured()) assert.equal(policy.dispatch({ protocolVersion: 1, epoch: 'probe', requestId: randomUUID(), type: 'resources.configure', dailyTotalUnits: limits.maximumReservedUnits, dailyAutonomousUnits: limits.maximumAutonomousUnits }), undefined) }
      finally { policy.close() }
      for (const row of rows()) baseline.add(row.ticket)
    },
    phase: (value: string) => { assert.match(value, /^[a-z-]+$/); if (value === 'compact') compactBaseline = new Set(usage().flatMap(row => typeof row.id === 'string' ? [row.id] : [])); phase = value; save() },
    installEmbedding: (next: string) => {
      assert.ok(embedding && batch === 'memory'); const sub = relative(root, next); assert.ok(sub && !sub.startsWith('..') && !isAbsolute(sub))
      mkdirSync(join(next, 'connections'), { recursive: true })
      if (!existsSync(join(next, 'connections/memory.json'))) writeFileSync(join(next, 'connections/memory.json'), JSON.stringify({ version: 1, embedding: { baseUrl: endpoint + '/embedding/v1', apiKey: key, model: embedding.model } }), { flag: 'wx' })
    },
    close: async () => { halted = true; for (const controller of active) controller.abort(); server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); save(); ledger.close() },
  }
}
