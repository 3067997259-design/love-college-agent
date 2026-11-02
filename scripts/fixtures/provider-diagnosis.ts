import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { lookup } from 'node:dns/promises'
import { networkInterfaces } from 'node:os'
import { session } from 'electron'
import { readModelProviders } from '../../src/main/config/providers'
import { systemClock as clock } from '../../src/main/clock'
import { createResourceBudget } from '../../src/main/resources/service'
import { curlModelRequest } from './curl-transport'
import { observeProbeTransport } from './probe-transport'
import { summarizeProbeResponse } from './probe-response'

type Spec = { id: string; transport: 'node' | 'curl'; fixture?: string; patch?: Record<string, unknown>; omit?: string[]; timeoutMs?: number; headers?: Record<string, string>; systemProxy?: boolean }
export async function inspectProviderPath(input: { root: string; providersFile: string }) {
  assert.ok(process.versions.electron, 'ELECTRON_MAIN_REQUIRED')
  const config = (await readModelProviders(input.providersFile)).get('chat'); assert.ok(config, 'CHAT_UNCONFIGURED')
  const endpoint = new URL(config.base_url)
  const addresses = await lookup(endpoint.hostname, { all: true })
  const proxy = await session.defaultSession.resolveProxy(endpoint.origin)
  const report = { inspectedAt: clock.iso(clock.nowMs()), httpRequests: 0, modelRequests: 0, credentialsSent: false,
    addresses: addresses.map(({ address, family }) => ({ addressHash: createHash('sha256').update(address).digest('hex'), family, addressClass: /^198\.(18|19)\./.test(address) ? 'benchmark-reserved' : /^(127\.|::1$)/.test(address) ? 'loopback' : /^(10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.)/.test(address) ? 'private' : 'other' })),
    systemProxyKinds: proxy.split(';').map(item => item.trim().split(/\s+/)[0]).filter(kind => ['DIRECT', 'PROXY', 'HTTPS', 'SOCKS', 'SOCKS4', 'SOCKS5'].includes(kind)),
    proxyEnvironmentPresent: ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy'].some(key => !!process.env[key]),
    namedTunnelInterfacePresent: Object.keys(networkInterfaces()).some(name => /clash|mihomo|meta|wintun|tun/i.test(name)),
  }
  writeFileSync(join(input.root, 'network-readonly', 'report.json'), JSON.stringify(report, null, 2), { flag: 'wx' }); return report
}
export async function runProviderDiagnosis(input: { root: string; providersFile: string; spec: Spec }) {
  assert.ok(process.versions.electron, 'ELECTRON_MAIN_REQUIRED')
  const { root, spec } = input; assert.match(spec.id, /^[a-z0-9-]+$/); assert.ok(['node', 'curl'].includes(spec.transport))
  assert.ok(!existsSync(join(root, 'closed.json')), 'DIAGNOSIS_WINDOW_CLOSED')
  const config = (await readModelProviders(input.providersFile)).get('chat'); assert.ok(config, 'CHAT_UNCONFIGURED')
  const endpoint = config.base_url.replace(/\/+$/, '') + '/chat/completions'
  let proxy: string | undefined
  if (spec.systemProxy) {
    assert.equal(spec.transport, 'curl', 'PROXY_CASE_REQUIRES_CURL')
    const route = (await session.defaultSession.resolveProxy(endpoint)).split(';')[0].trim()
    assert.ok(/^PROXY [A-Za-z0-9.:[\]-]+$/.test(route), 'SYSTEM_HTTP_PROXY_UNAVAILABLE')
    proxy = 'http://' + route.slice(6)
  }
  const original = spec.fixture ? readFileSync(spec.fixture, 'utf8') : JSON.stringify({ model: config.model, messages: [{ role: 'user', content: 'Reply with exactly OK and nothing else.' }], stream: false, max_tokens: 512 })
  const body = JSON.parse(original); assert.equal(body.model, config.model, 'MODEL_CHANGED')
  Object.assign(body, spec.patch); for (const field of spec.omit ?? []) delete body[field]
  assert.equal(body.model, config.model, 'MODEL_CHANGED')
  for (const [name, value] of Object.entries(spec.headers ?? {})) assert.ok(['User-Agent', 'Accept', 'Accept-Encoding', 'Accept-Language', 'Connection', 'Sec-Fetch-Mode'].includes(name) && typeof value === 'string' && !/[\r\n\0]/.test(value), 'INVALID_DIAGNOSTIC_HEADER')
  const raw = spec.patch || spec.omit ? JSON.stringify(body) : original
  assert.ok(!raw.includes(config.api_key), 'CREDENTIAL_IN_REQUEST_BODY')
  const timeoutMs = spec.timeoutMs ?? 45000; assert.ok(Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 120000)
  const caseRoot = join(root, spec.id); mkdirSync(caseRoot, { recursive: true })
  const usageFile = join(root, 'budget/usage.jsonl')
  const previous = existsSync(usageFile) ? readFileSync(usageFile, 'utf8').trim().split('\n').map(line => JSON.parse(line)).filter(row => row.kind === 'model') : []
  assert.ok(previous.length < 8 && previous.reduce((sum, row) => sum + row.units, 0) + 16000 <= 128000, 'DIAGNOSIS_BUDGET_EXHAUSTED')
  const ledger = createResourceBudget({ root: join(root, 'budget'), clock, configurable: true })
  const hash = (text: string) => createHash('sha256').update(text).digest('hex')
  try {
    if (!ledger.limitsConfigured()) assert.equal(ledger.dispatch({ protocolVersion: 1, epoch: 'probe', requestId: randomUUID(), type: 'resources.configure', dailyTotalUnits: 128000, dailyAutonomousUnits: 0 }), undefined)
    const receipt = { id: spec.id, startedAt: clock.iso(clock.nowMs()), transport: spec.transport, timeoutMs, bodySha256: hash(raw), connectionFingerprint: hash(endpoint + '\n' + config.model), inputBytes: Buffer.byteLength(raw), metadata: { keys: Object.keys(body), roles: body.messages?.map((message: { role: string }) => message.role), tools: body.tools?.length ?? 0, stream: body.stream, maxTokens: body.max_tokens ?? null, maxCompletionTokens: body.max_completion_tokens ?? null, reasoningEffort: body.reasoning_effort ?? null, streamOptions: body.stream_options ?? null }, spec: { ...spec, fixture: spec.fixture ? hash(original) : undefined } }
    writeFileSync(join(caseRoot, 'request.json'), JSON.stringify(receipt, null, 2), { flag: 'wx' })
    ledger.reserveModel(16000, 'work')
    let result
    if (spec.transport === 'curl') result = await curlModelRequest(endpoint, config.api_key, raw, timeoutMs, spec.headers, proxy)
    else {
      const start = clock.nowMs(), abort = new AbortController(), trace = observeProbeTransport(endpoint, () => clock.nowMs())
      const stop = clock.after(timeoutMs, () => abort.abort())
      let status: number | null = null, headersMs: number | null = null, responseText = '', error: string | null = null
      try {
        const response = await fetch(endpoint, { method: 'POST', redirect: 'error', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + config.api_key, ...spec.headers }, body: raw, signal: abort.signal })
        status = response.status; headersMs = clock.nowMs() - start
        assert.ok(response.body, 'BODY_MISSING')
        const reader = response.body.getReader(), decoder = new TextDecoder()
        try { while (true) { const chunk = await reader.read(); if (chunk.done) { responseText += decoder.decode(); break }; responseText += decoder.decode(chunk.value, { stream: true }); assert.ok(responseText.length <= 2 * 1024 * 1024, 'RESPONSE_TOO_LARGE'); if (body.stream && /(?:^|\n)data:\s*\[DONE\](?:\s|$)/.test(responseText)) break } }
        finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
      } catch (caught) { error = abort.signal.aborted ? 'TIMEOUT' : caught instanceof Error && /^[A-Z_]+$/.test(caught.message) ? caught.message : 'FETCH_FAILED' }
      finally { stop(); trace.close(); abort.abort() }
      const response = summarizeProbeResponse(responseText, config.api_key, endpoint)
      result = { ok: status === 200 && response.complete, httpStatus: status, error, elapsedMs: clock.nowMs() - start, headersMs, response, trace: trace.diagnostics }
    }
    const report = { ...receipt, ...result, attempt: previous.length + 1, reservedUnitsThisCase: 16000, ledger: ledger.view() }
    writeFileSync(join(caseRoot, 'report.json'), JSON.stringify(report, null, 2), { flag: 'wx' }); return report
  } finally { ledger.close() }
}
