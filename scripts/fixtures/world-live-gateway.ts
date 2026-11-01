// Loaded only inside an isolated Electron main. Original credentials never leave it.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, relative, isAbsolute } from 'node:path'
import { readModelProviders, readModelEfforts, type ProviderConfig } from '../../src/main/config/providers'
import { modelCapabilityRef } from '../../src/main/config/model-capabilities'
import { vendorOf } from '../../src/main/config/vendors'
import { createResourceBudget } from '../../src/main/resources/service'
import { systemClock as clock } from '../../src/main/clock'
import type { AppCommand } from '../../src/shared'
import { createWorldProbeStream } from './world-probe-stream'
import { completedJournalRecords, createWorldProbeAdmissions, type WorldProbeLimits } from './world-probe-admission'

const files = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? files(join(dir, e.name)) : [join(dir, e.name)])
export async function startWorldGateway(input: { root: string; authorized: string; selfTest: boolean; selfTestHoldAfterDone?: boolean; limits: WorldProbeLimits }) {
  const { root, selfTest, limits } = input
  assert.ok(process.versions.electron, 'ELECTRON_MAIN_REQUIRED')
  mkdirSync(root, { recursive: true })
  writeFileSync(join(root, 'gateway-start.json'), JSON.stringify({ ...limits, autonomousUnits: 0, selfTest }), { flag: 'wx' })
  const budget = createResourceBudget({ root: join(root, 'budget'), clock, configurable: true })
  assert.equal(budget.dispatch({ type: 'resources.configure', dailyTotalUnits: limits.maximumReservedUnits, dailyAutonomousUnits: 0 } as AppCommand), undefined)
  let fake: ReturnType<typeof createServer> | undefined
  const listen = async (server: ReturnType<typeof createServer>) => { await new Promise<void>(done => server.listen(0, '127.0.0.1', done)); const addr = server.address(); assert.ok(addr && typeof addr === 'object'); return `http://127.0.0.1:${addr.port}` }
  let config: ProviderConfig
  const efforts = selfTest ? {} : await readModelEfforts(input.authorized)
  if (selfTest) {
    fake = createServer((_, response) => {
      response.writeHead(200, { 'Content-Type': 'text/event-stream' }).write('data: ' + JSON.stringify({ choices: [{ delta: { content: 'WORLD_GATEWAY_SELF_TEST' }, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 10 } }) + '\n\n')
      // Deliberately keep HTTP open after protocol completion; the SDK closes its reader.
      // This is a stream barrier, not a timed delay or a live-service retry.
      if (input.selfTestHoldAfterDone) { response.write('data: [DONE]\n\n'); return }
      // SDKs also accept a complete final sentinel at EOF without another blank line.
      if (active?.id === 'early-return') response.end('data: [DONE]')
      else response.end('data: [DONE]\n\n')
    })
    config = { base_url: await listen(fake) + '/v1', api_key: 'fake-only', model: 'fake-world' }
  } else {
    const chat = (await readModelProviders(input.authorized)).get('chat'); assert.ok(chat, 'CHAT_UNCONFIGURED'); config = chat
    assert.ok(!vendorOf(config.base_url)?.native, 'NATIVE_PROTOCOL_UNSUPPORTED')
  }
  const key = randomUUID(), admissions = createWorldProbeAdmissions(units => budget.reserveModel(units, 'work'), limits)
  let active: { id: string; profile: string } | undefined, firstTicket: string | undefined, halted = false, denied = 0
  const denials: { caseId: string | null; code: string }[] = []
  const samples: { caseId: string; units: number; status: number | null; elapsedMs: number; inputTokens: number | null; outputTokens: number | null; ok: boolean }[] = []
  const state = () => ({ ...admissions.view(), halted, denied, denials, samples, autonomousUnits: budget.view().model.autonomousReservedUnits })
  const save = () => writeFileSync(join(root, 'gateway-report.json'), JSON.stringify(state(), null, 2))
  const admit = (ticket: string, units: number) => {
    assert.ok(!halted, 'GATEWAY_STOPPED')
    admissions.admit(ticket, units); firstTicket ??= ticket; save()
  }
  const server = createServer((request, response) => { void (async () => {
    if (request.method !== 'POST' || request.url !== '/chat/v1/chat/completions' || request.headers.authorization !== 'Bearer ' + key || !active || halted) { denied++; save(); response.writeHead(403).end(); return }
    let raw = ''; for await (const chunk of request) { raw += chunk; assert.ok(raw.length < 1024 * 1024, 'INPUT_TOO_LARGE') }
    const body = JSON.parse(raw); assert.equal(body.model, config.model)
    const rows = files(join(active.profile, 'journals')).filter(f => f.endsWith('.jsonl')).flatMap(f => completedJournalRecords(readFileSync(f, 'utf8')))
    const attempt = rows.findLast(r => r.type === 'model/attempt' && r.status === 'started' && r.slot === 'chat')
    assert.ok(attempt && typeof attempt.reservedTokens === 'number' && Number.isSafeInteger(attempt.reservedTokens) && attempt.reservedTokens > 0, 'APPLICATION_ADMISSION_MISSING')
    admit(active.id + ':' + attempt.turnId + ':' + attempt.attempt + ':' + attempt.slot, attempt.reservedTokens)
    const sample = { caseId: active.id, units: attempt.reservedTokens, status: null as number | null, elapsedMs: 0, inputTokens: null as number | null, outputTokens: null as number | null, ok: false,
      errorCode: null as string | null, completionObserved: false, downstreamCancelled: false, settled: false,
      upstreamEof: false, receivedBytes: 0, chunks: 0, failureStage: null as string | null, transportCode: null as string | null,
      completionBasis: null as 'sentinel' | 'eof' | null, upstreamCancelledAfterTerminal: false,
      stream: null as ReturnType<ReturnType<typeof createWorldProbeStream>['diagnostics']> | null }
    samples.push(sample); save()
    // Only the world block from this synthetic profile is retained, never system reasoning or credentials.
    const textOf = (content: unknown) => typeof content === 'string' ? content : Array.isArray(content) ? content.map(p => p.text ?? '').join('') : ''
    const refs = body.messages.flatMap((message: { content: unknown }) => { try { const ref = JSON.parse(textOf(message.content).split('\n\n')[0]); return ref.worldFacts ? [{ worldFacts: ref.worldFacts, worldFactsNote: ref.worldFactsNote, currentTime: ref.currentTime }] : [] } catch { return [] } })
    writeFileSync(join(root, active.id + '-reference.json'), JSON.stringify(refs.at(-1), null, 2))
    const began = clock.nowMs(), abort = new AbortController(), stop = clock.after(45_000, () => abort.abort())
    response.on('close', () => { if (!response.writableEnded) { sample.downstreamCancelled = true; abort.abort() } })
    const stream = createWorldProbeStream((inputTokens, outputTokens) => { sample.inputTokens = inputTokens; sample.outputTokens = outputTokens })
    let stage = 'upstream-request'
    try {
      const result = await fetch(config.base_url.replace(/\/+$/, '') + '/chat/completions', { method: 'POST', redirect: 'error', headers: { Authorization: 'Bearer ' + config.api_key, 'Content-Type': 'application/json' }, body: raw, signal: abort.signal })
      sample.status = result.status; assert.ok(result.ok && result.body, 'PROVIDER_FAILED')
      response.writeHead(200, { 'Content-Type': result.headers.get('content-type') ?? 'text/event-stream' })
      const reader = result.body.getReader(), decoder = new TextDecoder()
      try {
        while (true) {
          stage = 'upstream-read'
          const chunk = await reader.read(); if (chunk.done) { sample.upstreamEof = true; break }
          sample.receivedBytes += chunk.value.byteLength; sample.chunks++; assert.ok(sample.receivedBytes <= 2 * 1024 * 1024, 'RESPONSE_TOO_LARGE')
          stage = 'frame-parse'
          stream.push(decoder.decode(chunk.value, { stream: true })); response.write(chunk.value)
          if (stream.terminalSentinelSeen()) {
            // The SDK finishes at [DONE] and closes its reader before HTTP EOF.
            // Validate the parsed tail, finish downstream, then cancel upstream cleanup.
            stage = 'terminal-sentinel'; stream.end(); sample.completionBasis = 'sentinel'; sample.ok = true
            response.end(); sample.upstreamCancelledAfterTerminal = true; abort.abort(); break
          }
        }
        if (!sample.ok) {
          stage = 'eof-parse'
          stream.push(decoder.decode()); stream.end(); sample.completionBasis = 'eof'; sample.ok = true
        }
      } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
    } catch (error) {
      sample.failureStage = stage
      const cause = error instanceof Error && error.cause && typeof error.cause === 'object' && 'code' in error.cause ? error.cause.code : null
      sample.transportCode = typeof cause === 'string' && /^[A-Z0-9_]+$/.test(cause) ? cause : null
      sample.errorCode = abort.signal.aborted ? sample.downstreamCancelled ? 'DOWNSTREAM_CANCELLED' : 'TIMEOUT'
        : error instanceof Error && /^[A-Z_]+$/.test(error.message) ? error.message : 'TRANSPORT_OR_FRAME_ERROR'
      halted = true; if (!response.headersSent) response.writeHead(502)
    }
    finally { stop(); sample.completionObserved = stream.complete(); sample.stream = stream.diagnostics(); sample.elapsedMs = clock.nowMs() - began; response.end(); sample.settled = true; save() }
  })().catch(error => {
    halted = true; denied++; denials.push({ caseId: active?.id ?? null, code: error instanceof Error ? error.message.match(/^[A-Z][A-Z_]+/)?.[0] ?? error.name : 'GATEWAY_ERROR' })
    save(); if (!response.headersSent) response.writeHead(403); response.end()
  }) })
  const endpoint = await listen(server)
  const chat = { base_url: endpoint + '/chat/v1', api_key: key, model: config.model }
  const blocked = { base_url: endpoint + '/blocked/v1', api_key: key, model: 'blocked-autonomous' }
  const providersFile = join(root, 'relay-providers.json')
  writeFileSync(providersFile, JSON.stringify({ providers: { chat, background: blocked, work: blocked, privacy: blocked }, routing: { background: 'independent', work: 'independent', privacy: 'independent' }, efforts, ...(config.capabilities ? { modelCapabilities: { [modelCapabilityRef(chat)]: config.capabilities } } : {}) }))
  save()
  return {
    providersFile,
    active: (id: string, profile: string) => { const sub = relative(root, profile); assert.ok(sub && !sub.startsWith('..') && !isAbsolute(sub)); assert.match(id, /^[a-z-]+$/); active = { id, profile } },
    state,
    selfTestLimits: () => {
      assert.ok(selfTest && firstTicket); assert.throws(() => admit(firstTicket!, 1))
      assert.throws(() => budget.reserveModel(1, 'autonomous')); assert.throws(() => budget.reserveModel(limits.maximumReservedUnits + 1, 'work'))
      while (admissions.view().calls < limits.maximumCalls) admit('self-test-' + admissions.view().calls, 1)
      assert.throws(() => admit('over-call-limit', 1)); save(); return true
    },
    close: async () => { halted = true; for (const s of [server, fake]) if (s) { s.closeAllConnections(); await new Promise<void>(done => s.close(() => done())) }; save(); budget.close() },
  }
}
