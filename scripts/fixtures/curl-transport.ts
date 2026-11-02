import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { summarizeProbeResponse } from './probe-response'

/** Main-only caller supplies the secret; only stdin carries it to curl, never argv or disk. */
export async function curlModelRequest(endpoint: string, key: string, body: object | string, timeoutMs = 45000, headers: Record<string, string> = {}, proxy?: string) {
  const url = new URL(endpoint)
  assert.ok(['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash, 'INVALID_ENDPOINT')
  assert.ok(key && !/[\r\n\0]/.test(key), 'INVALID_CREDENTIAL')
  assert.ok(Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 120000, 'INVALID_TIMEOUT')
  for (const [name, value] of Object.entries(headers)) assert.ok(['User-Agent', 'Accept', 'Accept-Encoding', 'Accept-Language', 'Connection', 'Sec-Fetch-Mode'].includes(name) && !/[\r\n\0]/.test(value), 'INVALID_DIAGNOSTIC_HEADER')
  if (proxy) { const target = new URL(proxy); assert.ok(url.protocol === 'https:' && target.protocol === 'http:' && !target.username && !target.password && !target.search && !target.hash && target.pathname === '/', 'INVALID_DIAGNOSTIC_PROXY') }
  const quoted = (value: string) => '"' + value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('\r', '\\r').replaceAll('\n', '\\n') + '"'
  const marker = 'CURL_PROBE_' + randomUUID()
  const executable = process.platform === 'win32' ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'curl.exe') : 'curl'
  // Disable curlrc, redirects and retries. Default TLS checks and environment proxy remain intact.
  const args = ['--disable', '--silent', '--show-error', '--connect-timeout', '15', '--max-time', String(timeoutMs / 1000), '--retry', '0', '--max-redirs', '0', '--globoff', '--proto', '=http,https', '--config', '-', '--write-out', '\n' + marker + '%{json}']
  const config = ['url = ' + quoted(endpoint), ...(proxy ? ['proxy = ' + quoted(proxy)] : []), 'request = "POST"', 'header = "Content-Type: application/json"', 'header = ' + quoted('Authorization: Bearer ' + key), ...Object.entries(headers).map(([name, value]) => 'header = ' + quoted(name + ': ' + value)), 'data-binary = ' + quoted(typeof body === 'string' ? body : JSON.stringify(body))].join('\n') + '\n'
  const result = await new Promise<{ code: number | null; stdout: string; stderrBytes: number; truncated: boolean }>((resolve, reject) => {
    const child = spawn(executable, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = '', stderrBytes = 0, truncated = false
    child.on('error', () => reject(Error('CURL_LAUNCH_FAILED')))
    child.stdout.on('data', chunk => { if (stdout.length + chunk.length > 2 * 1024 * 1024) { truncated = true; child.kill(); return }; stdout += chunk })
    child.stderr.on('data', chunk => { stderrBytes += chunk.length })
    child.stdin.on('error', () => { /* curl's exit and diagnostic status remain authoritative */ })
    child.on('close', code => resolve({ code, stdout, stderrBytes, truncated }))
    child.stdin.end(config)
  })
  const offset = result.stdout.lastIndexOf(marker)
  let timings: Record<string, unknown> = {}
  try { if (offset >= 0) timings = JSON.parse(result.stdout.slice(offset + marker.length)) } catch { /* No raw diagnostic output is exposed. */ }
  const responseBody = offset < 0 ? result.stdout : result.stdout.slice(0, offset).trim()
  const numeric = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? value : null
  const response = summarizeProbeResponse(responseBody, key, endpoint)
  return {
    ok: timings.http_code === 200 && response.complete && (result.code === 0 || result.code === 28 && response.sentinel),
    curlExitCode: result.code, httpStatus: numeric(timings.http_code), stderrBytes: result.stderrBytes, truncated: result.truncated,
    metrics: Object.fromEntries(['time_namelookup', 'time_connect', 'time_appconnect', 'time_starttransfer', 'time_total', 'size_upload', 'size_download', 'num_connects', 'num_redirects', 'proxy_used', 'ssl_verify_result'].map(name => [name, numeric(timings[name])])),
    response,
  }
}
