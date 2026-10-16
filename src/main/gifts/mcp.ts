import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { z } from 'zod'
import { existsSync, lstatSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { GIFT_OBJECT_IDS } from '../../shared'
import type { BinaryAssets } from '../storage/assets'
import type { RodinApi, RodinHandle } from './rodin-api'
import { systemClock, type Clock } from '../clock'
import { sessionDayKey } from '../journal/file'

export class GiftMcpFailure extends Error { constructor(readonly code: 'budget-exceeded' | 'connection-failed') { super('GIFT_MCP_FAILED') } }

/** MCP uses the official SDK on both sides. Upstream handles live only in this private, excluded file. */
export async function createRodinMcp(api: RodinApi, assets: BinaryAssets, root: string, clock: Clock = systemClock) {
  const path = join(root, '.rodin-jobs.private.json'); const schema = z.record(z.string().uuid(), z.object({ uuid: z.string().uuid(), subscription_key: z.string().min(1).max(500) }))
  let handles: Record<string, RodinHandle> = {}
  if (existsSync(path)) { if (lstatSync(path).isSymbolicLink() || lstatSync(path).size > 100_000) throw new Error('RODIN_STORE_INVALID'); handles = schema.parse(JSON.parse(readFileSync(path, 'utf8'))) }
  const save = () => { writeFileSync(path + '.tmp', JSON.stringify(handles), { mode: 0o600 }); renameSync(path + '.tmp', path) }
  // External spend cannot be rewound by importing an older private save.
  const budgetPath = join(root, '.rodin-budget.private.json'); const budgetSchema = z.array(z.object({ id: z.string().uuid(), day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) })).max(5000)
  if (existsSync(budgetPath) && (lstatSync(budgetPath).isSymbolicLink() || lstatSync(budgetPath).size > 500_000)) throw new Error('RODIN_STORE_INVALID')
  const spent = existsSync(budgetPath) ? budgetSchema.parse(JSON.parse(readFileSync(budgetPath, 'utf8'))) : []
  const server = new McpServer({ name: 'lca-rodin', version: '1.0.0' })
  const reply = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value) }] })
  server.registerTool('begin', { inputSchema: { id: z.string().uuid(), objectId: z.enum(GIFT_OBJECT_IDS), motif: z.enum(['plain', 'sakura', 'stars']) } }, async ({ id, objectId, motif }, extra) => {
    if (handles[id]) return reply({ accepted: true })
    const day = sessionDayKey(clock); if (spent.some((item) => item.id === id || item.day === day)) throw new Error('RODIN_DAILY_BUDGET_EXHAUSTED')
    spent.push({ id, day }); writeFileSync(budgetPath + '.tmp', JSON.stringify(spent), { mode: 0o600 }); renameSync(budgetPath + '.tmp', budgetPath)
    handles[id] = await api.submit(objectId, motif, extra.signal); save(); return reply({ accepted: true })
  })
  server.registerTool('poll', { inputSchema: { id: z.string().uuid() } }, async ({ id }, extra) => {
    const handle = handles[id]; if (!handle) return reply({ state: 'failed' })
    const state = await api.poll(handle, extra.signal); if (state !== 'ready') return reply({ state })
    return reply({ state: 'ready', asset: assets.write(await api.download(handle, extra.signal), 'glb') })
  })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair(); const client = new Client({ name: 'lca-gift-client', version: '1.0.0' })
  await server.connect(serverTransport); await client.connect(clientTransport)
  return { call: async (name: 'begin' | 'poll', args: Record<string, string>, signal: AbortSignal): Promise<unknown> => {
    const result = z.object({ isError: z.boolean().optional(), content: z.array(z.object({ type: z.literal('text'), text: z.string() })).min(1) }).parse(await client.callTool({ name, arguments: args }, undefined, { signal, timeout: 100_000 })); if (result.isError) throw new GiftMcpFailure(result.content[0].text.includes('RODIN_DAILY_BUDGET_EXHAUSTED') ? 'budget-exceeded' : 'connection-failed'); return JSON.parse(result.content[0].text)
  }, close: async () => { await client.close(); await server.close() } }
}
export type RodinMcp = Awaited<ReturnType<typeof createRodinMcp>>
