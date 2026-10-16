import { z } from 'zod'
import { deskPathSchema } from '../heart-flow/desk'
export const delegateState = z.strictObject({ id: z.string().uuid(), flowId: z.string().min(1).max(128), status: z.enum(['running', 'completed', 'failed', 'cancelled']), source: z.enum(['real', 'fake']), sourceCount: z.number().int().min(1).max(5), createdAtMs: z.number().int().nonnegative(), updatedAtMs: z.number().int().nonnegative(), error: z.enum(['unavailable', 'cancelled', 'timeout', 'invalid-output', 'interrupted']).optional() })
export const delegateInput = z.strictObject({ task: z.string().trim().min(1).max(500), paths: z.array(deskPathSchema).min(1).max(5).refine((paths) => new Set(paths).size === paths.length) })
export const delegateOutput = z.strictObject({ conclusion: z.string().trim().min(1).max(2000), refs: z.array(z.strictObject({ path: deskPathSchema, sha256: z.string().regex(/^[a-f0-9]{64}$/) })).min(1).max(5) })
export interface DelegateModel {
  source: 'real' | 'fake'
  read(input: { task: string; sources: readonly { path: string; sha256: string; text: string }[] }, signal: AbortSignal): Promise<unknown>
}
