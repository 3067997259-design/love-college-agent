import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { createServer, type ServerResponse } from 'node:http'
import type { Clock } from '../clock'
import type { ProviderConfig } from '../config/providers'
import { scriptDelay, type ScriptedModel } from './model'

const MAX_BODY = 32 * 1024 * 1024
const frame = (value: unknown) => 'data: ' + JSON.stringify(value) + '\n\n'

/**
 * The scripted model as an OpenAI-compatible chat endpoint on 127.0.0.1, so developer scenes run her turns on DSH
 * the way a configured model does. Each request takes the next scripted step. A scripted LCA tool name without the
 * `lca_` prefix goes out under the name DSH offers, so scenes written for the legacy loop still work. Streams only
 * (DSH always asks for a stream), zero usage. The last request is kept: it is what she saw (the developer tool get_context).
 */
export async function startScriptedEndpoint(scripted: ScriptedModel, clock: Clock) {
  const token = randomBytes(24).toString('hex'); const auth = Buffer.from('Bearer ' + token)
  let last: { messages: unknown; tools: string[] } | undefined
  const reject = (response: ServerResponse, status: number) => { response.writeHead(status, { 'Content-Type': 'application/json' }).end('{"error":{"message":"request-rejected"}}') }
  const http = createServer((request, response) => {
    void (async () => {
      const supplied = Buffer.from(request.headers.authorization ?? '')
      if (supplied.length !== auth.length || !timingSafeEqual(supplied, auth)) return reject(response, 401)
      if (request.method !== 'POST' || !request.url?.endsWith('/chat/completions')) return reject(response, 404)
      const chunks: Buffer[] = []; let length = 0
      for await (const chunk of request) { const bytes = Buffer.from(chunk); length += bytes.length; if (length > MAX_BODY) return reject(response, 413); chunks.push(bytes) }
      let body: { messages?: unknown; tools?: { name?: unknown; function?: { name?: unknown } }[] }
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { return reject(response, 400) }
      const offered = new Set((body.tools ?? []).map((tool) => String(tool.function?.name ?? tool.name ?? '')))
      last = { messages: body.messages ?? [], tools: [...offered] }
      const named = (name: string) => offered.has(name) || !offered.has('lca_' + name) ? name : 'lca_' + name
      const step = scripted.next()
      // The book stopping her turn closes the request: the scripted wait ends with it.
      const abort = new AbortController(); response.once('close', () => abort.abort())
      if (step.httpStatus) {
        try { await scriptDelay(clock, step.delayMs, abort.signal) } catch { return reject(response, 499) }
        return response.writeHead(step.httpStatus, { 'Content-Type': 'application/json' }).end('{"error":{"message":"scripted failure","code":"scripted"}}')
      }
      // Headers first: a long scripted pause must not look like an endpoint that never answered.
      response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
      try { await scriptDelay(clock, step.delayMs, abort.signal) } catch { response.end(); return }
      if (step.text) response.write(frame({ choices: [{ index: 0, delta: { role: 'assistant', content: step.text }, finish_reason: null }] }))
      step.toolCalls.forEach((call, index) => response.write(frame({ choices: [{ index: 0, delta: { tool_calls: [{ index, id: 'call_' + randomUUID(), type: 'function', function: { name: named(call.name), arguments: call.arguments } }] }, finish_reason: null }] })))
      response.write(frame({ choices: [{ index: 0, delta: {}, finish_reason: step.toolCalls.length ? 'tool_calls' : 'stop' }] }))
      response.end(frame({ choices: [], usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } }) + 'data: [DONE]\n\n')
    })().catch(() => { if (!response.headersSent) reject(response, 500); else response.end() })
  })
  await new Promise<void>((resolve, reject) => { http.once('error', reject); http.listen(0, '127.0.0.1', () => { http.removeListener('error', reject); resolve() }) })
  const port = (http.address() as { port: number }).port
  const provider: ProviderConfig = { base_url: `http://127.0.0.1:${port}/v1`, api_key: token, model: 'lca-scripted' }
  return { provider, lastRequest: () => last, close: () => new Promise<void>((resolve) => { http.close(() => resolve()); http.closeAllConnections() }) }
}
export type ScriptedEndpoint = Awaited<ReturnType<typeof startScriptedEndpoint>>
