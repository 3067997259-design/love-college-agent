import { z } from 'zod'
import { opaqueId } from '../campus/schema'

const digest = z.string().regex(/^[a-f0-9]{64}$/)
export const memorySourceSchema = z.strictObject({ id: opaqueId, sessionId: opaqueId, frameSeq: z.number().int().positive(), index: z.number().int().nonnegative(), offset: z.number().int().nonnegative(), atMs: z.number().int().nonnegative() })
export const memoryEntrySchema = z.strictObject({ id: opaqueId, text: z.string().min(1).max(240), kind: z.enum(['fact', 'experience']), topic: z.string().min(1).max(20).nullable(),
  sources: z.array(memorySourceSchema).min(1).max(64), supersedes: z.array(opaqueId).max(20) })
export const memoryBatchSchema = z.strictObject({ batchId: digest, keys: z.array(digest).max(128), entries: z.array(memoryEntrySchema).max(20), source: z.enum(['real', 'fake']) })
export const memorySummarySchema = z.strictObject({ id: opaqueId, level: z.enum(['day', 'week', 'month']), period: z.string().regex(/^\d{4}-\d{2}(?:-\d{2})?$/),
  text: z.string().min(1).max(6000), sources: z.array(memorySourceSchema).max(128), sourceSessionIds: z.array(opaqueId).min(1).max(40), parentSummaryIds: z.array(opaqueId).max(40).optional(), source: z.enum(['real', 'fake']) })
export type MemorySource = z.infer<typeof memorySourceSchema>
export type MemoryEntry = z.infer<typeof memoryEntrySchema>
export type MemorySummary = z.infer<typeof memorySummarySchema>
