import { z } from 'zod'

export const pluginId = z.string().regex(/^[a-z][a-z0-9.-]{0,63}$/)
const short = z.string().min(1).max(120).refine((value) => [...value].every((char) => char.charCodeAt(0) > 31 && char.charCodeAt(0) !== 127))
const relativeFile = z.string().min(1).max(160).refine((value) => !value.includes('\\') && !value.startsWith('/') && !value.includes(':') && value.split('/').every((part) => part !== '..' && part !== '.' && part !== ''))
export const manifestSchema = z.strictObject({
  apiVersion: z.number().int().positive(), id: pluginId, name: short, version: z.string().regex(/^\d+\.\d+\.\d+$/),
  description: z.string().max(1000), privacy: z.enum(['none', 'optional', 'always']),
  permissions: z.array(z.enum(['local-code', 'network', 'filesystem'])).max(3),
  entry: relativeFile.refine((value) => value.endsWith('.cjs')).optional(),
  tools: z.array(z.strictObject({ name: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/), description: z.string().min(1).max(1000),
    parameters: z.record(z.string(), z.json()), templateId: z.string().regex(/^[a-zA-Z0-9_.-]{1,80}$/) })).max(32),
  furniture: z.array(z.strictObject({ slot: pluginId, image: relativeFile, expression: pluginId.optional(), pose: pluginId.optional() })).max(16).default([]),
  configSchema: z.record(z.string(), z.json()).optional(),
}).refine((value) => !value.entry || value.permissions.includes('local-code'))
  .refine((value) => !value.tools.length || Boolean(value.entry))
  .refine((value) => new Set(value.tools.map((tool) => tool.name)).size === value.tools.length)
export type PluginManifest = z.infer<typeof manifestSchema>
