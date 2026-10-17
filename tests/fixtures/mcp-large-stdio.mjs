import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
// Self-owned transport fixture. No files, credentials, game, or external services.
const server = new McpServer({ name: 'bounded-stdio-fixture', version: '1.0.0' })
server.registerTool('screenshot', { inputSchema: { expectedWorldSessionId: z.string().optional() } }, async () => ({ content: [{ type: 'image', data: 'AA==', mimeType: 'image/png' }], structuredContent: {} }))
server.registerTool('large_text', { inputSchema: {} }, async () => ({ content: [{ type: 'text', text: 'A'.repeat(512000) }] }))
process.stdout.on('error', () => process.exit(0))
await server.connect(new StdioServerTransport())
