import { z } from 'zod'
import type { PomodoroView } from '../../shared'

export const planItemSchema = z.strictObject({
  text: z.string().min(1).max(80).refine((text) => [...text].length <= 40 && text.trim().length > 0 && [...text].every((character) => {
    const code = character.codePointAt(0)!; return code > 31 && code !== 127 && code !== 0x2028 && code !== 0x2029
  })),
  count: z.number().int().min(1).max(24), assist: z.boolean(),
})
export const planSchema = z.strictObject({ label: z.string().trim().min(1).max(80), plannedCount: z.number().int().min(1).max(24),
  items: z.array(planItemSchema).min(1).max(24).readonly().optional(),
  focusDurationMs: z.number().int().min(1000).max(4 * 60 * 60_000), shortBreakDurationMs: z.number().int().min(1000).max(60 * 60_000),
  longBreakDurationMs: z.number().int().min(1000).max(2 * 60 * 60_000), longBreakEvery: z.number().int().min(1).max(24), timing: z.enum(['standard', 'demo', 'custom']),
}).refine((plan) => !plan.items || plan.items.reduce((sum, item) => sum + item.count, 0) === plan.plannedCount)
  .refine((plan) => plan.timing !== 'standard' || (plan.focusDurationMs === 25 * 60_000 && plan.shortBreakDurationMs === 5 * 60_000 && plan.longBreakDurationMs === 15 * 60_000 && plan.longBreakEvery === 4))
  .refine((plan) => plan.timing !== 'demo' || (plan.focusDurationMs === 60_000 && plan.shortBreakDurationMs === 20_000 && plan.longBreakDurationMs === 20_000))
export const viewSchema = z.strictObject({ phase: z.enum(['idle', 'focus', 'short-break', 'long-break']), status: z.enum(['idle', 'running', 'paused']),
  remainingMs: z.number().int().nonnegative(), endsAtMs: z.number().int().nonnegative().nullable(), focusIndex: z.number().int().min(0).max(24),
  completedCount: z.number().int().min(0).max(24).optional(),
  phaseDurationMs: z.number().int().nonnegative(), plannedCount: z.number().int().min(0).max(24),
  plan: planSchema.safeExtend({ id: z.string().min(1).max(128), createdAtMs: z.number().int().nonnegative(), status: z.enum(['proposed', 'confirmed', 'finished']), source: z.enum(['user', 'assistant']) }).optional(),
  proposal: planSchema.safeExtend({ id: z.string().min(1).max(128), createdAtMs: z.number().int().nonnegative(), status: z.enum(['proposed', 'confirmed', 'finished']).refine((status): boolean => status === 'proposed'), source: z.enum(['user', 'assistant']) }).optional(),
}).refine((view) => (view.status === 'running') === (view.endsAtMs !== null))
export const completedFocuses = (view: PomodoroView) => Math.max(0, view.focusIndex - (view.phase === 'focus' ? 1 : 0))
/** Legacy logs may contain proposed-in-plan. Adapt the projection, never rewrite append-only source files. */
export function normalizePomodoro(input: PomodoroView): PomodoroView {
  const view = structuredClone(input)
  if (view.plan?.status === 'proposed') { view.proposal ??= view.plan; delete view.plan; view.plannedCount = 0 }
  view.completedCount = completedFocuses(view)
  return view
}
export const idleTimer = (): PomodoroView => ({ phase: 'idle', status: 'idle', remainingMs: 0, endsAtMs: null, focusIndex: 0, completedCount: 0, phaseDurationMs: 0, plannedCount: 0 })
