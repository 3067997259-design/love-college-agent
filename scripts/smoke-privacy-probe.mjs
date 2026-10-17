import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { mkdir, writeFile, readdir, readFile, appendFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runtimeEnv } from './runtime-env.mjs'
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..'); const data = join(root, '.local-data', 'privacy-probe-smoke-' + randomUUID())
let mode = 'success'; let calls = 0; let otherCalls = 0
const server = createServer(async (request, response) => {
  let text = ''; for await (const chunk of request) text += chunk; calls++
  if (JSON.parse(text).model !== 'synthetic-privacy') { otherCalls++; response.writeHead(401).end('{}'); return }
  if (mode === 'failure') { response.writeHead(401).end('{}'); return }
  const content = JSON.stringify({ markdown: '# 周五桥\n\n2026 年合成资料。', deadline: { iso: '2026-10-24T23:59:00+08:00', quote: '2026年10月24日 23:59' } })
  response.writeHead(200, { 'Content-Type': 'text/event-stream' }).end('data: ' + JSON.stringify({ choices: [{ index: 0, delta: { content }, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n')
})
await new Promise((done) => server.listen(0, '127.0.0.1', done)); await mkdir(data, { recursive: true })
const config = join(data, 'synthetic.json')
await writeFile(config, JSON.stringify({ providers: Object.fromEntries(['privacy', 'chat', 'background'].map((slot) => [slot, { base_url: 'http://127.0.0.1:' + server.address().port + '/v1', api_key: 'synthetic-only', model: 'synthetic-' + slot }])) }))
const run = async (args = [], expected = mode === 'success' ? 0 : 1) => {
  const child = spawn(process.execPath, [join(root, 'scripts/probe-privacy-live.mjs'), ...args], { cwd: root, windowsHide: true, env: { ...runtimeEnv(root), LCA_PROVIDERS_FILE: config, LCA_PRIVACY_PROBE_REPORT: join(data, 'report.json') }, stdio: ['ignore', 'pipe', 'ignore'] })
  let output = ''; child.stdout.on('data', (chunk) => { output += chunk })
  const code = await new Promise((done, reject) => { child.once('exit', done); child.once('error', () => reject(new Error('PROBE_LAUNCH_FAILED'))) })
  assert.equal(code, expected); return JSON.parse(output.trim())
}
try {
  for (mode of ['success', 'failure']) {
    calls = 0; const report = await run()
    assert.equal(report.ok, mode === 'success'); assert.equal(report.privacyOnly, true); assert.equal(report.rawSourceExcluded, true); assert.equal(report.ordinaryContextEmpty, true); assert.equal(calls, 1)
    const inspection = await run(['--inspect', report.profileId])
    assert.equal(inspection.inspectionOnly, true); assert.equal(inspection.newRequests, 0); assert.equal(calls, 1)
    if (mode === 'success') {
      // A legacy/rest profile is rejected before launching the app, since its
      // pending completion event could otherwise start chat during bootstrap.
      const journals = join(root, '.local-data', 'privacy-live-' + report.profileId, 'journals'); const owner = (await readdir(journals))[0]
      const folder = join(journals, owner); const file = join(folder, (await readdir(folder)).filter((name) => name.endsWith('.jsonl')).sort().at(-1))
      const rows = (await readFile(file, 'utf8')).trim().split('\n').map(JSON.parse)
      await appendFile(file, JSON.stringify({ version: 1, seq: rows.at(-1).seq + 1, atMs: Date.now(), type: 'companion/mode', mode: 'rest', requestId: 'fixture-rest', commandHash: 'fixture-rest' }) + '\n')
      const refused = await run(['--inspect', report.profileId], 1); assert.equal(refused.error, 'INSPECTION_REQUIRES_QUIET_PROFILE'); assert.equal(calls, 1)
    }
  }
  assert.equal(otherCalls, 0)
  console.log(JSON.stringify({ ok: true, probe: 'privacy-probe', syntheticServices: true, configuredChatAndBackgroundReceiveZero: true, successAndFailClosed: true, nativeFileAndGroundedDate: true, successfulAndFailedInspectionNoNewRequests: true }))
} finally { server.closeAllConnections(); await new Promise((done) => server.close(done)) }
