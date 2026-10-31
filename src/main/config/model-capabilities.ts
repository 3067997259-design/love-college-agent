import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { ManualModelCapabilities } from '../../shared/model-capabilities'
import { vendorOf } from './vendors'

export const CAPABILITY_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const
const capacity = z.number().int().min(1).max(100_000_000)
const wire = z.string().min(1).max(64).regex(/^[A-Za-z0-9_.-]+$/)
const reasoning = z.strictObject({ off: wire.nullable().optional(), minimal: wire.optional(), low: wire.optional(), medium: wire.optional(), high: wire.optional(), xhigh: wire.optional(), max: wire.optional() })
  .refine((value) => CAPABILITY_LEVELS.some((level) => level !== 'off' && value[level] !== undefined), 'Declare at least one thinking level, or disable reasoning')
export const manualCapabilitiesSchema = z.strictObject({
  contextWindow: capacity.optional(), maxOutputTokens: capacity.optional(),
  inputModalities: z.array(z.enum(['text', 'image'])).min(1).max(2).refine((values) => values.includes('text') && new Set(values).size === values.length).optional(),
  reasoning: z.union([z.literal(false), reasoning]).optional(),
}).refine((value) => Object.keys(value).length > 0, 'No declarations')
  .refine((value) => !value.contextWindow || !value.maxOutputTokens || value.maxOutputTokens <= value.contextWindow, 'Output exceeds context')
export const capabilityRegistrySchema = z.record(z.string().regex(/^[a-f0-9]{64}$/), manualCapabilitiesSchema).refine((value) => Object.keys(value).length <= 128)
export type CapabilityRegistry = Record<string, ManualModelCapabilities>
/** URL, key and model stay in main. A credential change is a distinct connection. */
export function modelCapabilityRef(config: { base_url: string; api_key: string; model: string }): string {
  return createHash('sha256').update(JSON.stringify([config.base_url.trim().replace(/\/+$/, ''), config.api_key, config.model.trim()])).digest('hex')
}
export const canDeclareCapabilities = (config: { base_url: string }) => vendorOf(config.base_url)?.catalog !== 'deepseek-official'
export function declaredCapabilities(registry: CapabilityRegistry | undefined, config: { base_url: string; api_key: string; model: string }): ManualModelCapabilities | undefined {
  const value = registry?.[modelCapabilityRef(config)]
  if (!value) return undefined
  if (!canDeclareCapabilities(config)) throw new Error('NATIVE_MODEL_CAPABILITIES_MANAGED_BY_ADAPTER')
  return manualCapabilitiesSchema.parse(value)
}
