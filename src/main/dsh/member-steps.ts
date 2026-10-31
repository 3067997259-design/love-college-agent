import { z } from 'zod'
import type { MemberStepsRead } from '../../shared/collaboration'

const time = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const line = z.string().max(200).refine((value) => !/\p{Cc}/u.test(value))
/** Bounded allowlist. Unexpected transcript fields never survive the child/main boundary. */
export const memberStepsSchema = z.object({
  withheld: z.boolean(),
  steps: z.array(z.object({ tool: line, status: z.enum(['running', 'completed', 'failed']), startedAt: time, endedAt: time.nullable(), target: line.optional() })
    .refine((step) => step.endedAt === null || step.endedAt >= step.startedAt)).max(12),
}).transform((value) => ({ ...value, steps: value.steps.map(({ target, ...step }) => ({ ...step, ...(!value.withheld && target ? { target } : {}) })) }))

export function publicMemberSteps(input: z.infer<typeof memberStepsSchema>, kind: (name: string) => string): MemberStepsRead {
  return { withheld: input.withheld, steps: input.steps.map(({ tool, status, startedAt, endedAt, target }) => ({ templateId: kind(tool), status,
    durationMs: endedAt === null ? null : endedAt - startedAt, ...(!input.withheld && target ? { target } : {}) })) }
}
