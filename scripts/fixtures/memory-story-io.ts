import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { readModelProviders, readModelEfforts, type ProviderConfig } from '../../src/main/config/providers'
import { vendorOf } from '../../src/main/config/vendors'
import { createApiMemoryEmbeddingSource } from '../../src/main/memory/airi/embedding'
import { createResourceBudget } from '../../src/main/resources/service'
import { systemClock } from '../../src/main/clock'
import { dshRoutes } from '../../src/main/dsh/routes'
import { createContinuityProbeBudget } from './continuity-live-budget'
import { createProbeResponseDeadline } from './probe-response-deadline'
import { createWorldProbeStream } from './world-probe-stream'
import { scriptedResponse, requestObjects, type ProbeRequest } from './continuity-scripted-model'
import plan from '../memory-stories-plan.json'

type Reply = { text?: string; tool?: string; args?: unknown }
export async function createStoryQualityIO(input: { root: string; selfTest: boolean; authorized?: string; embeddingConfig?: string }) {
  assert.ok(process.versions.electron, 'ELECTRON_MAIN_REQUIRED')
  const config: ProviderConfig = input.selfTest
    ? { base_url: 'http://127.0.0.1', api_key: 'synthetic-only', model: 'quality-chat', capabilities: { contextWindow: 131072, maxOutputTokens: 8192 } }
    : (await readModelProviders(input.authorized!)).get('chat')!
  assert.ok(config && !vendorOf(config.base_url)?.native, 'COMPATIBLE_CHAT_REQUIRED')
  const embeddingConfig = input.selfTest
    ? { baseUrl: 'https://api.voyageai.com/v1', apiKey: 'synthetic-only', model: plan.expectedEmbeddingModel }
    : JSON.parse(readFileSync(input.embeddingConfig!, 'utf8')).embedding
  assert.equal(embeddingConfig?.model, plan.expectedEmbeddingModel, 'EMBEDDING_MODEL_CHANGED')
  const ledger = createResourceBudget({ root: join(input.root, 'budget'), clock: systemClock, configurable: true })
  assert.equal(ledger.dispatch({ protocolVersion: 1, epoch: 'quality-stories', requestId: 'limits', type: 'resources.configure',
    dailyTotalUnits: plan.limits.maximumReservedUnits, dailyAutonomousUnits: plan.limits.maximumAutonomousUnits }), undefined)
  const budget = createContinuityProbeBudget(plan.limits, (units, bucket) => { ledger.reserveModel(units, bucket) })
  let story = '', evaluating = false, halted = false, upstreamRequests = 0
  let script: (body: ProbeRequest) => Reply = () => ({ text: '已收到。' })
  const tickets: string[] = [], samples: Record<string, unknown>[] = [], references: Record<string, unknown>[] = []
  const active = new Set<AbortController>()
  const state = () => ({ selfTest: input.selfTest, story, evaluating, halted, upstreamRequests, counts: budget.view(), pendingAdmissions: tickets.length,
    inFlight: active.size, samples, references })
  const save = () => writeFileSync(join(input.root, 'io.json'), JSON.stringify(state(), null, 2))
  const rawEmbedding = createApiMemoryEmbeddingSource({ ...embeddingConfig, clock: systemClock, fetch: async (url, init) => {
    assert.ok(evaluating && !halted, 'EMBEDDING_OUTSIDE_EVALUATION')
    const body = JSON.parse(String(init?.body)), sample: Record<string, unknown> = { story, kind: 'embedding', inputType: body.input_type, characters: body.input?.length, ok: false }
    samples.push(sample); save()
    try {
      budget.embedding(randomUUID(), body.input); save()
      if (!input.selfTest) { upstreamRequests++; save() }
      const response = input.selfTest ? new Response(JSON.stringify({ data: [{ embedding: Array.from({ length: 1024 }, (_, i) => i === 0 ? 1 : 0) }] }))
        : await fetch(url, { ...init, redirect: 'error' })
      sample.status = response.status; assert.ok(response.ok, 'VECTOR_HTTP_FAILED'); return response
    } catch { halted = true; sample.error = 'VECTOR_ADMISSION_OR_TRANSPORT_FAILED'; throw new Error('VECTOR_FAILED') }
    finally { save() }
  } })
  const embedding = { ...rawEmbedding, embed: async (text: string, kind?: 'document' | 'query') => {
    assert.ok(!halted, 'BATCH_HALTED')
    const began = systemClock.nowMs()
    try { const result = await rawEmbedding.embed(text, kind); samples.at(-1)!.ok = true; return result }
    catch { halted = true; throw new Error('VECTOR_FAILED') }
    finally { if (samples.length) samples.at(-1)!.elapsedMs = systemClock.nowMs() - began; save() }
  } }
  const key = randomUUID()
  const server = createServer((request, response) => { void (async () => {
    assert.ok(!halted && story && request.method === 'POST' && request.url === '/v1/chat/completions' && !request.headers.origin
      && request.headers.authorization === 'Bearer ' + key, 'UNADMITTED_REQUEST')
    let raw = ''; for await (const chunk of request) { raw += chunk; assert.ok(raw.length <= 2 * 1024 * 1024, 'REQUEST_TOO_LARGE') }
    const body = JSON.parse(raw) as ProbeRequest
    const worker = body.model === 'quality-worker-script'
    assert.ok(worker || body.model === config.model, 'MODEL_CHANGED')
    if (!evaluating || worker) {
      response.writeHead(200, { 'Content-Type': body.stream ? 'text/event-stream' : 'application/json' })
      response.end(scriptedResponse(body, script(body))); return
    }
    assert.equal(tickets.length, 1, 'MISSING_OR_AMBIGUOUS_ADMISSION'); const ticket = tickets.shift()!
    const refs = requestObjects(body).filter(o => o.memoryReference || o.memoryDirectory || o.workCheckpoints || o.previousDaysReference || o.experienceIndex)
    references.push({ story, ticket, values: refs, tools: body.tools?.map(tool => tool.function.name) ?? [] })
    const sample: Record<string, unknown> = { story, kind: 'model', ticket, status: null, ok: false, inputTokens: null, outputTokens: null }
    samples.push(sample); save()
    const abort = new AbortController(), began = systemClock.nowMs(); active.add(abort)
    const deadline = createProbeResponseDeadline(systemClock, plan.responseTimeouts, () => abort.abort())
    sample.deadline = deadline.diagnostics
    const cancel = () => { if (!response.writableEnded) abort.abort() }; response.on('close', cancel)
    try {
      if (!input.selfTest) { upstreamRequests++; save() }
      const upstream = input.selfTest
        ? new Response(scriptedResponse(body, { text: '离线协议检查结束；这不是语义质量答案。' }), { headers: { 'content-type': 'text/event-stream' } })
        : await fetch(config.base_url.replace(/\/+$/, '') + '/chat/completions', { method: 'POST', redirect: 'error',
          headers: { Authorization: 'Bearer ' + config.api_key, 'Content-Type': 'application/json' }, body: raw, signal: abort.signal })
      deadline.headers(); sample.status = upstream.status; assert.ok(upstream.ok && upstream.body && body.stream, 'MODEL_PROTOCOL_FAILED')
      response.writeHead(200, { 'Content-Type': 'text/event-stream' })
      const reader = upstream.body.getReader(), decoder = new TextDecoder()
      const stream = createWorldProbeStream((i, o) => { sample.inputTokens = i; sample.outputTokens = o })
      let bytes = 0
      try {
        while (true) {
          const chunk = await reader.read(); if (chunk.done) break
          deadline.chunk(chunk.value.length); bytes += chunk.value.length; assert.ok(bytes <= 2 * 1024 * 1024, 'RESPONSE_TOO_LARGE')
          stream.push(decoder.decode(chunk.value, { stream: true }))
          if (stream.terminalSentinelSeen()) { stream.end(); stream.assertModelOutput(); response.write(chunk.value); sample.ok = true; deadline.complete(); response.end(); abort.abort(); break }
          response.write(chunk.value)
        }
        if (!sample.ok) { stream.push(decoder.decode()); stream.end(); stream.assertModelOutput(); sample.ok = true; deadline.complete() }
      } finally { sample.stream = stream.diagnostics(); await reader.cancel().catch(() => {}); reader.releaseLock() }
    } catch { halted = true; sample.error = deadline.diagnostics.timeoutPhase ? 'TIMEOUT' : 'MODEL_RESPONSE_FAILED'; if (!response.headersSent) response.writeHead(502) }
    finally { deadline.stop(); response.off('close', cancel); active.delete(abort); sample.elapsedMs = systemClock.nowMs() - began; response.end(); save() }
  })().catch(() => { halted = true; samples.push({ story, kind: 'denial', ok: false }); save(); if (!response.headersSent) response.writeHead(403); response.end() }) })
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
  const address = server.address(); assert.ok(address && typeof address !== 'string')
  const relay = { ...config, base_url: `http://127.0.0.1:${address.port}/v1`, api_key: key }
  const routes = dshRoutes(relay, { ...relay, model: 'quality-worker-script' }, input.selfTest ? {} : await readModelEfforts(input.authorized!))
  return { routes, embedding, state,
    activate(id: string, scripted: typeof script) { assert.ok(!halted && !active.size && !tickets.length, 'UNSETTLED_PREVIOUS_STORY'); story = id; script = scripted; evaluating = false; save() },
    evaluate() { evaluating = true; save() },
    admit(worker: boolean, units: number, bucket: 'work' | 'autonomous') {
      if (halted) return 'budget-exceeded' as const
      if (!evaluating || worker) return null
      try { const ticket = randomUUID(); assert.equal(tickets.length, 0, 'UNCONSUMED_ADMISSION'); budget.model(ticket, units, bucket); tickets.push(ticket); save(); return null }
      catch { halted = true; save(); return 'budget-exceeded' as const }
    },
    async close() { halted = true; for (const abort of active) abort.abort(); server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); save(); ledger.close() },
  }
}
export type StoryQualityIO = Awaited<ReturnType<typeof createStoryQualityIO>>
