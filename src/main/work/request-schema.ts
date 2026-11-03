import { z } from 'zod'

/** Quotes are evidence in the current authored request, never a model assertion
 * that a target or requirement is clear. Older callers can omit them when main
 * can resolve the literal work ID and original instruction without a hint. */
const quote = z.string().trim().min(1).max(2000)
export const createWorkInput = z.strictObject({
  objective: z.string().min(1).max(20_000),
  acceptance: z.array(z.string().min(1).max(2000)).max(16),
  decisionIds: z.array(z.string().min(1).max(128)).max(32).optional(),
})
export const updateWorkInput = z.strictObject({
  workId: z.string().uuid(), expectedRevision: z.number().int().positive(),
  action: z.enum(['supplement', 'pause', 'stop', 'resume']),
  targetQuote: quote.optional(), requirementQuote: quote.optional(),
})
