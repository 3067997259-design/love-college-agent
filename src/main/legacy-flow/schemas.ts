import { z } from 'zod'
import { redactFixed } from '../privacy/redact'
import { deskPathSchema } from './desk'

/**
 * Journal rows the retired heart flow wrote (goals, draft operations, rewinds, desk commands, helpers). The flow is
 * gone; these shapes stay so old journals still parse and their history stays readable.
 */
const digest = z.string().regex(/^[a-f0-9]{64}$/)
const goalTextSchema = z.string().trim().min(1).max(200).refine((text) => !/[\p{Cc}\p{Cf}]/u.test(text) && redactFixed(text) === text)
export const goalSchema = z.strictObject({ id: z.string().uuid(), text: goalTextSchema, status: z.enum(['active', 'completed', 'cancelled']), confirmedBy: z.literal('user') })
const sourceRef = z.strictObject({ path: deskPathSchema, sha256: digest, changeId: z.string().max(128).optional() })
export const operationSchema = z.strictObject({ id: z.string().uuid(), flowId: z.string().min(1).max(128), kind: z.enum(['init', 'review']),
  status: z.enum(['running', 'ready', 'failed', 'cancelled']), source: z.enum(['real', 'fake']), sourceCount: z.number().int().min(0).max(8), omittedSourceCount: z.number().int().nonnegative(),
  outputPath: deskPathSchema, createdAtMs: z.number().int().nonnegative(), updatedAtMs: z.number().int().nonnegative(), sources: z.array(sourceRef).max(8), turnId: z.string().min(1).max(128).optional(),
  artifact: z.strictObject({ changeId: z.string().min(1).max(128), sha256: digest, byteLength: z.number().int().positive().max(64000) }).optional(),
  error: z.enum(['no-product', 'source-changed', 'interrupted', 'cancelled', 'unavailable']).optional(),
}).refine((op) => op.sources.length === op.sourceCount && op.outputPath === `工作草稿/${op.id}.md`)
export const rewindSchema = z.strictObject({
  id: z.string().uuid(), flowId: z.string().min(1).max(128), changeId: z.string().uuid(), createdAtMs: z.number().int().nonnegative(),
  status: z.enum(['awaiting-confirmation', 'running', 'completed', 'failed', 'cancelled', 'interrupted']),
  paths: z.array(z.string().min(1).max(180)).min(1).max(300), changeCount: z.number().int().min(1).max(500), appliedFiles: z.number().int().min(0).max(300),
  error: z.enum(['conflict', 'write-failed', 'unavailable']).optional(),
})
export const commandOutcome = z.strictObject({ exitCode: z.number().int().nullable(), elapsedMs: z.number().int().nonnegative().nullable(), processTreeTerminated: z.boolean().nullable(), publication: z.enum(['unchanged', 'applied', 'not-applied', 'partial', 'unknown']), changedFiles: z.number().int().nonnegative().nullable(), appliedFiles: z.number().int().nonnegative() })
export const delegateState = z.strictObject({ id: z.string().uuid(), flowId: z.string().min(1).max(128), status: z.enum(['running', 'completed', 'failed', 'cancelled']), source: z.enum(['real', 'fake']), sourceCount: z.number().int().min(1).max(5), createdAtMs: z.number().int().nonnegative(), updatedAtMs: z.number().int().nonnegative(), error: z.enum(['unavailable', 'cancelled', 'timeout', 'invalid-output', 'interrupted']).optional() })
export const delegateOutput = z.strictObject({ conclusion: z.string().trim().min(1).max(2000), refs: z.array(z.strictObject({ path: deskPathSchema, sha256: digest })).min(1).max(5) })
