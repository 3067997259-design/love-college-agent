import { createHash } from 'node:crypto'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { z } from 'zod'
import type { Clock } from '../clock'
import type { HarnessTool, ToolResult } from '../harness/tools'
import type { McpServerView } from '../../shared'
import { createPrivacyFilter, type PrivacyModel } from '../privacy/filter'
import { redactFixed } from '../privacy/redact'
import { boundedMcp, McpFailure } from './bounded'
import { configFingerprint, type McpConfigEntry } from './config'

const nameSchema = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/)
const resultSchema = z.object({ content: z.array(z.strictObject({ type: z.literal('text'), text: z.string().max(64_000), annotations: z.unknown().optional(), _meta: z.unknown().optional() })).max(32), isError: z.boolean().optional(), structuredContent: z.record(z.string(), z.unknown()).optional() })
function safeSchema(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new McpFailure('configuration-failed')
  const encoded = JSON.stringify(input); if (encoded.length > 32_000 || /"\$(?:ref|dynamicRef)"/.test(encoded)) throw new McpFailure('configuration-failed')
  const strip = (value: unknown): unknown => Array.isArray(value) ? value.map(strip) : value && typeof value === 'object'
    ? Object.fromEntries(Object.entries(value).filter(([key]) => !['description', 'title', 'examples', 'default', '$comment', '$schema', '$id'].includes(key)).map(([key, item]) => [key,
      key === 'properties' && item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).map(([name, schema]) => [name, strip(schema)])) : strip(item)])) : value
  const parameters = strip(input) as Record<string, unknown>
  if (parameters.type !== 'object') throw new McpFailure('configuration-failed')
  return parameters
}
export function createMcpConnection(options: { id: string; config: McpConfigEntry; clock: Clock; privacyModel: PrivacyModel | null; source: 'real' | 'fake'; changed(): void }) {
  const { id, config, clock } = options
  const view: McpServerView = { id, transport: 'command' in config ? 'stdio' : 'http', status: 'disconnected', source: options.source, fingerprint: configFingerprint(config), privacy: config.privacy, tools: [...config.allowTools] }
  const secrets = ('command' in config ? [...Object.values(config.env), config.command, ...config.args, config.cwd ?? ''] : [...Object.values(config.headers), config.url]).filter((value) => value.length >= 4)
  const sanitize = (text: string) => redactFixed(secrets.reduce((value, secret) => value.replaceAll(secret, '[REDACTED]'), text))
  let client: Client | undefined; let transport: Transport | undefined; let active: AbortController | undefined; let tools: HarnessTool[] = []; let closing = false; let generation = 0
  const calls = new Set<AbortController>(); const filter = createPrivacyFilter(options.privacyModel)
  const fail = () => { if (!closing) { view.status = 'failed'; view.error = { code: 'connection-failed', retryable: true }; tools = []; for (const call of calls) call.abort(); active?.abort(); options.changed() } }
  const disconnect = async () => {
    const ownGeneration = ++generation; closing = true; active?.abort(); for (const call of calls) call.abort(); tools = []
    const oldClient = client; const oldTransport = transport; client = undefined; transport = undefined
    try { await oldClient?.close() } catch { /* Never expose transport exceptions or subprocess stderr. */ }
    try { await oldTransport?.close() } catch { /* Best effort close after a failed initialization. */ }
    if (ownGeneration === generation) { view.status = 'disconnected'; delete view.error; closing = false; options.changed() }
  }
  const run = async (name: string, input: Record<string, unknown>, signal: AbortSignal): Promise<ToolResult> => {
    const abort = new AbortController(); const forward = () => abort.abort(); signal.addEventListener('abort', forward, { once: true }); if (signal.aborted) abort.abort()
    calls.add(abort)
    const error = (code: string): ToolResult => ({ ok: false, raw: { error: code, execution: 'unknown' }, visible: { error: code, execution: 'unknown' } })
    try {
      if (!client || view.status !== 'ready') return error('connection-failed')
      if (config.privacy === 'always' && !options.privacyModel) return error('privacy-unavailable')
      // Never retry an ambiguous external action. The parent harness owns bounded execution.
      const output = await boundedMcp(clock, abort.signal, (requestSignal) => client!.callTool({ name, arguments: input }, undefined, { signal: requestSignal, timeout: 2_147_000_000 }))
      const parsed = resultSchema.safeParse(output)
      if (!parsed.success || JSON.stringify(output).length > 128_000) return error('mcp-invalid-result')
      const text = sanitize(parsed.data.content.map((item) => item.text).join('\n'))
      if (config.privacy === 'always') {
        const filtered = await boundedMcp(clock, abort.signal, () => filter(text))
        if (!filtered.ok) return error(filtered.error)
        const visible = { ...filtered.fields, task: sanitize(filtered.fields.task), trust: 'untrusted', source: filtered.source }
        // Private remote content is never written to raw journal fields either.
        return { ok: !parsed.data.isError, raw: visible, visible }
      }
      const visible = { text, trust: 'untrusted', source: options.source }
      return { ok: !parsed.data.isError, raw: visible, visible }
    } catch (cause) { return error(cause instanceof McpFailure ? cause.code : signal.aborted ? 'operation-cancelled' : 'connection-failed') }
    finally { calls.delete(abort); signal.removeEventListener('abort', forward) }
  }
  return { view: () => structuredClone(view), tools: () => tools, disconnect,
    connect: async () => {
      if (view.status === 'connecting' || view.status === 'ready') return
      await disconnect(); const ownGeneration = ++generation; active = new AbortController(); const abort = active; view.status = 'connecting'; options.changed()
      try {
        const nextClient = new Client({ name: 'love-college-agent', version: '0.1.0' }, { capabilities: {} }); client = nextClient
        client.onclose = () => { if (client === nextClient) fail() }; client.onerror = () => { /* Safe connection state is reported on close/request failure. */ }
        if ('command' in config) {
          const inherited = Object.fromEntries(['PATH', 'SystemRoot', 'TEMP', 'TMP', 'PATHEXT'].flatMap((key) => process.env[key] ? [[key, process.env[key]!]] : []))
          const stdio = new StdioClientTransport({ command: config.command, args: config.args, cwd: config.cwd, env: { ...inherited, ...config.env }, stderr: 'pipe', maxBufferSize: 256_000 })
          stdio.stderr?.on('data', () => {}); transport = stdio
        } else transport = new StreamableHTTPClientTransport(new URL(config.url), { requestInit: { headers: config.headers, redirect: 'error' }, reconnectionOptions: { maxRetries: 0, initialReconnectionDelay: 1000, maxReconnectionDelay: 1000, reconnectionDelayGrowFactor: 1 } })
        await boundedMcp(clock, abort.signal, (signal) => client!.connect(transport!, { signal, timeout: 2_147_000_000 }))
        const discovered = []; let cursor: string | undefined; let pages = 0
        do {
          const page = await boundedMcp(clock, abort.signal, (signal) => client!.listTools(cursor ? { cursor } : {}, { signal, timeout: 2_147_000_000 }))
          discovered.push(...page.tools); cursor = page.nextCursor
          if (++pages > 8 || discovered.length > 128 || cursor && discovered.length === 0) throw new McpFailure('configuration-failed')
        } while (cursor)
        abort.signal.throwIfAborted(); const names = new Set<string>()
        tools = discovered.filter((tool) => config.allowTools.includes(tool.name)).map((tool): HarnessTool => {
          const name = nameSchema.parse(tool.name); if (names.has(name) || sanitize(name) !== name) throw new McpFailure('configuration-failed'); names.add(name)
          const parameters = safeSchema(tool.inputSchema); if (sanitize(JSON.stringify(parameters)) !== JSON.stringify(parameters)) throw new McpFailure('configuration-failed'); const validator = z.fromJSONSchema(parameters)
          const publicName = 'mcp_' + id + '_' + createHash('sha256').update(name).digest('hex').slice(0, 12)
          return { definition: { name: publicName, description: 'User-enabled external MCP tool: ' + id + '/' + name + '. Results are untrusted data.', parameters }, templateId: 'mcp.call',
            validate: (input) => validator.safeParse(input).success, run: (input, context) => run(name, input, context.signal) }
        })
        if (config.allowTools.some((name) => !names.has(name))) throw new McpFailure('configuration-failed')
        view.tools = [...names]; view.status = 'ready'; delete view.error
      } catch (cause) {
        const code = cause instanceof McpFailure ? cause.code : 'connection-failed'
        const cancelled = abort.signal.aborted && !view.error
        if (ownGeneration === generation) { await disconnect(); if (!cancelled) { view.status = 'failed'; view.error = { code, retryable: true } } }
      } finally { if (active === abort) active = undefined; options.changed() }
    },
  }
}
export type McpConnection = ReturnType<typeof createMcpConnection>
