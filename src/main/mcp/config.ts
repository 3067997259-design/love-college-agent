import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { z } from 'zod'

const strings = z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_-]{0,100}$/), z.string().max(8192))
const common = { allowTools: z.array(z.string().regex(/^[A-Za-z0-9_-]{1,64}$/)).max(64).default([]), privacy: z.enum(['always', 'none']).default('always'), disabled: z.boolean().default(false) }
const serverSchema = z.union([
  z.strictObject({ ...common, type: z.literal('stdio').optional(), command: z.string().min(1).max(4096), args: z.array(z.string().max(8192)).max(64).default([]), cwd: z.string().min(1).max(4096).optional(), env: strings.default({}) }),
  z.strictObject({ ...common, type: z.enum(['http', 'streamable-http']).optional(), url: z.url().max(4096).refine((value) => { const url = new URL(value); return !url.username && !url.password && !url.hash && (url.protocol === 'https:' || url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) }), headers: strings.default({}) }),
])
export const mcpConfigSchema = z.strictObject({ mcpServers: z.record(z.string().regex(/^[A-Za-z0-9_-]{1,32}$/), serverSchema).refine((entries) => Object.keys(entries).length <= 16) })
export type McpConfig = z.infer<typeof mcpConfigSchema>
export type McpConfigEntry = McpConfig['mcpServers'][string]
export const configFingerprint = (entry: McpConfigEntry) => createHash('sha256').update(JSON.stringify(entry)).digest('hex')
export function readMcpConfig(path: string): McpConfig {
  if (!existsSync(path)) return { mcpServers: {} }
  const stat = lstatSync(path)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 256_000) throw new Error('MCP_CONFIGURATION_INVALID')
  return mcpConfigSchema.parse(JSON.parse(readFileSync(path, 'utf8')))
}
export function saveMcpConfig(path: string, value: McpConfig) {
  mkdirSync(dirname(path), { recursive: true }); const parsed = mcpConfigSchema.parse(value)
  writeFileSync(path + '.tmp', JSON.stringify(parsed), { mode: 0o600 }); renameSync(path + '.tmp', path)
}
