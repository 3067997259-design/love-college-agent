import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { createHash, randomUUID } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { readModelProviders } from '../../src/main/config/providers'
import { systemClock as clock } from '../../src/main/clock'
import { createResourceBudget } from '../../src/main/resources/service'
import { curlModelRequest } from './curl-transport'

export async function probeProviderCurl(input: { root: string; providersFile?: string; selfTest: boolean }) {
  assert.ok(process.versions.electron, 'ELECTRON_MAIN_REQUIRED')
  let fixture: ReturnType<typeof createServer> | undefined, received = 0
  let config: { base_url: string; api_key: string; model: string }
  if (input.selfTest) {
    fixture = createServer((req, res) => { received++; req.resume(); req.on('end', () => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ choices: [{ message: { content: 'OK' }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 } })) }) })
    fixture.listen(0, '127.0.0.1'); await once(fixture, 'listening'); const address = fixture.address(); assert.ok(address && typeof address !== 'string')
    config = { base_url: `http://127.0.0.1:${address.port}/v1`, api_key: 'synthetic-only', model: 'synthetic' }
  } else {
    assert.ok(input.providersFile, 'SAVED_CONNECTION_REQUIRED')
    const chat = (await readModelProviders(input.providersFile)).get('chat'); assert.ok(chat, 'CHAT_UNCONFIGURED'); config = chat
  }
  const ledger = createResourceBudget({ root: join(input.root, 'budget'), clock, configurable: true })
  try {
    assert.equal(ledger.dispatch({ protocolVersion: 1, epoch: 'probe', requestId: randomUUID(), type: 'resources.configure', dailyTotalUnits: 16000, dailyAutonomousUnits: 0 }), undefined)
    const endpoint = config.base_url.replace(/\/+$/, '') + '/chat/completions'
    const body = { model: config.model, messages: [{ role: 'user', content: 'Reply with exactly OK and nothing else.' }], stream: false, max_tokens: 512 }
    const receipt = { startedAt: clock.iso(clock.nowMs()), selfTest: input.selfTest, transport: 'curl', maximumModelRequests: 1, reservedUnits: 16000, autonomousUnits: 0, request: { messages: 1, tools: 0, stream: false, maxOutputTokens: 512 }, connectionFingerprint: createHash('sha256').update(endpoint + '\n' + config.model).digest('hex') }
    writeFileSync(join(input.root, 'request.json'), JSON.stringify(receipt, null, 2), { flag: 'wx' })
    ledger.reserveModel(16000, 'work')
    const result = await curlModelRequest(endpoint, config.api_key, body)
    const report = { ...receipt, ...result, modelRequestAttempts: 1, localFixtureRequests: input.selfTest ? received : null, ledger: ledger.view() }
    writeFileSync(join(input.root, 'report.json'), JSON.stringify(report, null, 2), { flag: 'wx' })
    return report
  } finally { ledger.close(); if (fixture) { fixture.closeAllConnections(); await new Promise<void>(done => fixture!.close(() => done())) } }
}
