import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'

/** Main-only caller supplies the secret; only stdin carries it to curl, never argv or disk. */
export async function curlModelRequest(endpoint: string, key: string, body: object) {
  const url = new URL(endpoint)
  assert.ok(['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash, 'INVALID_ENDPOINT')
  assert.ok(key && !/[\r\n\0]/.test(key), 'INVALID_CREDENTIAL')
  const quoted = (value: string) => '"' + value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('\r', '\\r').replaceAll('\n', '\\n') + '"'
  const marker = 'CURL_PROBE_' + randomUUID()
  const executable = process.platform === 'win32' ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'curl.exe') : 'curl'
  // Disable curlrc, redirects and retries. Default TLS checks and environment proxy remain intact.
  const args = ['--disable', '--silent', '--show-error', '--connect-timeout', '15', '--max-time', '45', '--retry', '0', '--max-redirs', '0', '--globoff', '--proto', '=http,https', '--config', '-', '--write-out', '\n' + marker + '%{json}']
  const config = ['url = ' + quoted(endpoint), 'request = "POST"', 'header = "Content-Type: application/json"', 'header = ' + quoted('Authorization: Bearer ' + key), 'data-binary = ' + quoted(JSON.stringify(body))].join('\n') + '\n'
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
  let timings: Record<string, unknown> = {}, parsed: Record<string, unknown> | undefined
  try { if (offset >= 0) timings = JSON.parse(result.stdout.slice(offset + marker.length)) } catch { /* No raw diagnostic output is exposed. */ }
  const responseBody = offset < 0 ? result.stdout : result.stdout.slice(0, offset).trim()
  try { parsed = JSON.parse(responseBody) } catch { /* Non-JSON/error/empty are reported distinctly. */ }
  const choices = Array.isArray(parsed?.choices) ? parsed.choices : []
  const content = choices[0]?.message?.content
  const safeError = (value: unknown) => typeof value === 'string' ? value.replaceAll(key, '[redacted]').replaceAll(endpoint, '[endpoint]').slice(0, 240) : null
  const error = parsed?.error && typeof parsed.error === 'object' ? parsed.error as Record<string, unknown> : undefined
  const numeric = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? value : null
  const usage = parsed?.usage && typeof parsed.usage === 'object' ? parsed.usage as Record<string, unknown> : {}
  return {
    ok: result.code === 0 && timings.http_code === 200 && typeof content === 'string' && content.trim() === 'OK',
    curlExitCode: result.code, httpStatus: numeric(timings.http_code), stderrBytes: result.stderrBytes, truncated: result.truncated,
    metrics: Object.fromEntries(['time_namelookup', 'time_connect', 'time_appconnect', 'time_starttransfer', 'time_total', 'size_upload', 'size_download', 'num_connects', 'num_redirects', 'proxy_used', 'ssl_verify_result'].map(name => [name, numeric(timings[name])])),
    response: { bytes: Buffer.byteLength(responseBody), json: !!parsed, choices: choices.length, contentCharacters: typeof content === 'string' ? content.length : null, replyExactlyOK: typeof content === 'string' && content.trim() === 'OK', finishReason: safeError(choices[0]?.finish_reason), error: error ? { type: safeError(error.type), code: safeError(error.code), message: safeError(error.message) } : null, usage: { inputTokens: numeric(usage.prompt_tokens), outputTokens: numeric(usage.completion_tokens), totalTokens: numeric(usage.total_tokens) } },
  }
}
