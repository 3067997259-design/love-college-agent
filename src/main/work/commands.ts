import { z } from 'zod'
import { workTargetSchema } from './journal'

export const workCommandSchemas = <T extends z.ZodRawShape>(envelope: T) => [
  z.strictObject({ ...envelope, type: z.literal('work.create'), projectId: z.string().min(1).max(128), objective: z.string().min(1).max(20_000),
    acceptance: z.array(z.string().max(2000)).max(16), decisionIds: z.array(z.string().min(1).max(128)).min(1).max(32) }),
  z.strictObject({ ...envelope, type: z.literal('work.supplement'), target: workTargetSchema, text: z.string().min(1).max(20_000), decisionId: z.string().min(1).max(128) }),
  z.strictObject({ ...envelope, type: z.literal('work.pause'), target: workTargetSchema }),
  z.strictObject({ ...envelope, type: z.literal('work.stop'), target: workTargetSchema }),
  z.strictObject({ ...envelope, type: z.literal('work.resume'), target: workTargetSchema }),
  z.strictObject({ ...envelope, type: z.literal('work.query'), workId: z.string().uuid() }),
]
