import { randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer, type ServerResponse } from 'node:http'
import { writeFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { z } from 'zod'
import { sceneSchema } from './scenes'
import { scriptSchema } from './model'

export interface DevelopmentHandlers {
  enabled(): boolean
  state(): unknown
  context(): unknown
  queue(): unknown
  clock(input: { nowMs?: number; rate?: number; frozen?: boolean }): unknown
  inject(input: { source: 'pomodoro' | 'mail' | 'autonomous'; text: string }): unknown
  model(input: z.infer<typeof scriptSchema>): unknown
  exportScene(): unknown
  loadScene(input: z.infer<typeof sceneSchema>): unknown
}
function publicOutput(value: unknown) {
  // Defense in depth for manually typed development fixtures; providers are never loaded in this profile.
  return JSON.stringify(value).replace(/\b(?:sk-[A-Za-z0-9_-]{8,}|Bearer\s+[^\s"\\]+)/gi, '[REDACTED]')
    .replace(/("(?:api[_-]?key|auth[_-]?code|password|authorization)"\s*:\s*)"[^"\n]*"/gi, '$1"[REDACTED]"')
}
export async function startDevelopmentServer(root: string, port: number, handlers: DevelopmentHandlers) {
  const token = randomBytes(32).toString('hex'); const auth = Buffer.from('Bearer ' + token)
  const connections = new Set<StreamableHTTPServerTransport>()
  const respond = (response: ServerResponse, status: number) => { response.writeHead(status, { 'Content-Type': 'application/json' }).end('{"error":"request-rejected"}') }
  const http = createServer((request, response) => {
    void (async () => {
      const supplied = Buffer.from(request.headers.authorization ?? '')
      if (!handlers.enabled() || request.headers.origin || !/^127\.0\.0\.1:\d+$/.test(request.headers.host ?? '') || supplied.length !== auth.length || !timingSafeEqual(supplied, auth)) return respond(response, 403)
      if (request.url !== '/mcp' || request.method !== 'POST') return respond(response, 405)
      if (!request.headers['content-type']?.startsWith('application/json')) return respond(response, 415)
      const chunks: Buffer[] = []; let length = 0
      for await (const chunk of request) { const bytes = Buffer.from(chunk); length += bytes.length; if (length > 256_000) return respond(response, 413); chunks.push(bytes) }
      let body: unknown
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { return respond(response, 400) }
      const server = new McpServer({ name: 'lca-development', version: '1.0.0' })
      const reply = (fn: () => unknown) => async () => {
        try { return { content: [{ type: 'text' as const, text: publicOutput(await fn()) }] } }
        catch { return { isError: true, content: [{ type: 'text' as const, text: '{"error":"development-operation-failed"}' }] } }
      }
      server.registerTool('get_state', { description: 'Read safe development state', inputSchema: {} }, reply(handlers.state))
      server.registerTool('get_context', { description: 'Read the model-visible projection only', inputSchema: {} }, reply(handlers.context))
      server.registerTool('get_queue', { description: 'Read named scheduled jobs', inputSchema: {} }, reply(handlers.queue))
      server.registerTool('set_clock', { description: 'Adjust the development clock', inputSchema: { nowMs: z.number().int().min(0).max(8_640_000_000_000_000).optional(), rate: z.number().min(0.01).max(3600).optional(), frozen: z.boolean().optional() } }, (input) => reply(() => handlers.clock(input))())
      server.registerTool('inject_event', { description: 'Inject explicit synthetic facts into the inbox', inputSchema: { source: z.enum(['pomodoro', 'mail', 'autonomous']), text: z.string().min(1).max(2000) } }, (input) => reply(() => handlers.inject(input))())
      server.registerTool('set_fake_model', { description: 'Replace the synthetic model reply script', inputSchema: { script: scriptSchema } }, (input) => reply(() => handlers.model(input.script))())
      server.registerTool('export_scene', { description: 'Export a development fixture, not a private backup', inputSchema: {} }, reply(handlers.exportScene))
      server.registerTool('load_scene', { description: 'Stage a development fixture in a fresh profile; restart required', inputSchema: { scene: sceneSchema } }, (input) => reply(() => handlers.loadScene(input.scene))())
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
      connections.add(transport)
      response.once('close', () => { connections.delete(transport); void transport.close(); void server.close() })
      await server.connect(transport); await transport.handleRequest(request, response, body)
    })().catch(() => { if (!response.headersSent) respond(response, 500); else response.end() })
  })
  http.requestTimeout = 10_000; http.headersTimeout = 10_000
  await new Promise<void>((resolve, reject) => { http.once('error', reject); http.listen(port, '127.0.0.1', () => { http.removeListener('error', reject); resolve() }) })
  const actualPort = (http.address() as { port: number }).port
  const discovery = join(root, 'debug-connection.json')
  writeFileSync(discovery, JSON.stringify({ url: `http://127.0.0.1:${actualPort}/mcp`, token }), { mode: 0o600 })
  return { port: actualPort, close: async () => {
    for (const transport of connections) await transport.close()
    await new Promise<void>((resolve) => { http.close(() => resolve()); http.closeAllConnections() })
    try { unlinkSync(discovery) } catch { /* Already removed. */ }
  } }
}
