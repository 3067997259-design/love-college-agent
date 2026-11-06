// Bounded local-browser acceptance. No user profile, real model, external site, or global installation.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { join, resolve } from 'node:path'
import { startBrowserNative, AGENT_BROWSER } from './fixtures/agent-browser-native.ts'

const root = resolve(import.meta.dirname, '..'), directory = join(root, 'test-results', 'agent-browser-' + randomUUID())
mkdirSync(directory, { recursive: true })
const clock = { nowMs: () => Date.now(), iso: (ms) => new Date(ms).toISOString(), parse: (value) => Date.parse(value), after: (ms, fn) => { const timer = setTimeout(fn, ms); return () => clearTimeout(timer) } }
const server = createServer((req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8')
  res.end('<!doctype html><title>LCA browser fixture</title><main><h1>桃子的网页调试</h1><p>fixture-body-42</p><button>保存草稿</button><table><tr><th>课程</th><th>时间</th></tr><tr><td>算法</td><td>周三</td></tr></table></main><script>console.warn("fixture-warning");setTimeout(()=>{throw new Error("fixture-error")},20)</script>')
})
await new Promise((done) => server.listen(0, '127.0.0.1', done))
const evidence = { upstream: AGENT_BROWSER, at: new Date().toISOString(), directory, checks: [], observations: {}, status: 'running' }
let browser
try {
  evidence.runtime = directory
  browser = await startBrowserNative({ executable: join(root, '.cache/agent-browser', AGENT_BROWSER.version, 'agent-browser.exe'), browser: process.env.LCA_PROBE_BROWSER || 'C:/Program Files/Google/Chrome/Application/chrome.exe', directory, hostname: '127.0.0.1', clock, signal: new AbortController().signal, spawned: (pid) => { evidence.pid = pid } })
  evidence.pid = browser.pid
  for (const [name, action, args] of [
    ['navigate', 'navigate', { url: `http://127.0.0.1:${server.address().port}/`, waitUntil: 'load' }],
    ['snapshot', 'snapshot', { compact: true, maxDepth: 8 }],
    ['text', 'gettext', { selector: 'main' }],
    ['console', 'console', {}], ['errors', 'errors', {}], ['tabs', 'tab_list', {}],
    ['screenshot', 'screenshot', { path: join(directory, 'viewport.png'), fullPage: false }],
  ]) { evidence.observations[name] = await browser.request(action, args); console.log(name, JSON.stringify(evidence.observations[name]).slice(0, 180)) }
  assert.match(JSON.stringify(evidence.observations.snapshot), /桃子/)
  assert.match(JSON.stringify(evidence.observations.text), /fixture-body-42/)
  assert.match(JSON.stringify(evidence.observations.console), /fixture-warning/)
  assert.match(JSON.stringify(evidence.observations.errors), /fixture-error/)
  assert.equal(readFileSync(join(directory, 'viewport.png')).subarray(1, 4).toString(), 'PNG')
  evidence.checks.push('owned-daemon', 'structure', 'rendered-text', 'console', 'page-error', 'viewport-png')
  await browser.close()
  assert.throws(() => process.kill(browser.pid, 0), { code: 'ESRCH' })
  evidence.checks.push('daemon-exit')
  evidence.status = 'passed'
} catch (error) { evidence.status = 'failed'; evidence.error = String(error); evidence.cause = error.cause; console.log(error.cause); process.exitCode = 1 }
finally {
  try { await browser?.close() } catch (error) { evidence.cleanupError = String(error); process.exitCode = 1 }
  if (evidence.pid) { try { process.kill(evidence.pid, 0); evidence.daemonExited = false; process.exitCode = 1 } catch (error) { evidence.daemonExited = error.code === 'ESRCH'; if (!evidence.daemonExited) process.exitCode = 1 } }
  server.closeAllConnections(); await new Promise((done) => server.close(done))
  writeFileSync(join(directory, 'receipt.json'), JSON.stringify(evidence, null, 2))
  console.log(JSON.stringify({ status: evidence.status, checks: evidence.checks, error: evidence.error, directory }))
}
