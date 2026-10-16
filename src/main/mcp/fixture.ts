import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { z } from 'zod'
import type { Clock } from '../clock'
import type { McpConfig } from './config'
import { createMinecraftFixture } from '../minecraft/fixture'

/** Explicit developer fixture over a real loopback MCP transport; never installed as a production source. */
export async function startMcpFixture(clock: Clock) {
  const token = randomUUID(); const connections = new Set<StreamableHTTPServerTransport>(); let calls = 0
  const game = createMinecraftFixture()
  const http = createServer((request, response) => {
    void (async () => {
      if (request.method !== 'POST' || request.url !== '/mcp' || request.headers.authorization !== 'Bearer ' + token || request.headers.origin) { response.writeHead(403).end(); return }
      const chunks: Buffer[] = []; let size = 0
      for await (const chunk of request) { size += chunk.length; if (size > 256_000) { response.writeHead(413).end(); return }; chunks.push(Buffer.from(chunk)) }
      const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8')); const server = new McpServer({ name: 'lca-synthetic-mcp', version: '1.0.0' })
      game.install(server)
      server.registerTool('synthetic_read', { description: 'Synthetic fixture only', inputSchema: { title: z.string().max(100).optional() } }, async () => {
        calls++; return { content: [{ type: 'text', text: JSON.stringify({ marker: 'SYNTHETIC_MCP_OK', original: 'RAW_ONLY_MCP_PRIVATE', credential: 'sk-syntheticmcpcredential1234567890', value: 7 }) }] }
      })
      server.registerTool('synthetic_wait', { inputSchema: {} }, async (_input, context) => {
        calls++; await new Promise<void>((resolve, reject) => { const stop = clock.after(60_000, resolve); const abort = () => { stop(); reject(new Error('SYNTHETIC_CANCELLED')) }; context.signal.addEventListener('abort', abort, { once: true }); if (context.signal.aborted) abort() })
        return { content: [{ type: 'text', text: 'SYNTHETIC_DELAY_FINISHED' }] }
      })
      server.registerTool('synthetic_invalid', { inputSchema: {} }, async () => { calls++; return { content: [{ type: 'image', mimeType: 'image/png', data: 'AA==' }] } })
      server.registerTool('synthetic_public', { inputSchema: {} }, async () => { calls++; return { content: [{ type: 'text', text: 'SYNTHETIC_MCP_PUBLIC' }] } })
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true }); connections.add(transport)
      response.once('close', () => { connections.delete(transport); void transport.close(); void server.close() })
      await server.connect(transport); await transport.handleRequest(request, response, body)
    })().catch(() => { if (!response.headersSent) response.writeHead(500).end(); else response.end() })
  })
  await new Promise<void>((resolve, reject) => { http.once('error', reject); http.listen(0, '127.0.0.1', () => { http.removeListener('error', reject); resolve() }) })
  const url = 'http://127.0.0.1:' + (http.address() as { port: number }).port + '/mcp'
  const config: McpConfig = { mcpServers: {
    'synthetic-private': { url, headers: { Authorization: 'Bearer ' + token }, allowTools: ['synthetic_read', 'synthetic_wait', 'synthetic_invalid'], privacy: 'always', disabled: false },
    'synthetic-public': { url, headers: { Authorization: 'Bearer ' + token }, allowTools: ['synthetic_public'], privacy: 'none', disabled: false },
    'synthetic-game': { url, headers: { Authorization: 'Bearer ' + token }, allowTools: game.names, privacy: 'none', disabled: false },
  } }
  return { config, game, calls: () => calls, close: async () => { for (const transport of connections) await transport.close(); await new Promise<void>((resolve) => { http.close(() => resolve()); http.closeAllConnections() }) } }
}
