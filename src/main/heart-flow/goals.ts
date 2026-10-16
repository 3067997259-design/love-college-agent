import { z } from 'zod'
import type { FlowGoalView } from '../../shared'
import type { JournalRecord } from '../journal/schema'
import { redactFixed } from '../privacy/redact'

export const goalTextSchema = z.string().trim().min(1).max(200).refine((text) => !/[\p{Cc}\p{Cf}]/u.test(text) && redactFixed(text) === text)
export const goalStatusSchema = z.enum(['active', 'completed', 'cancelled'])
export const goalSchema = z.strictObject({ id: z.string().uuid(), text: goalTextSchema, status: goalStatusSchema, confirmedBy: z.literal('user') })
/** Input is already owner-scoped and globally ordered by SessionStore, never compared by local seq. */
export function projectFlowGoals(rows: readonly JournalRecord[]) {
  const goals = new Map<string, FlowGoalView>(); let selected: string | null = null
  for (const row of rows) {
    if (row.type === 'flow/goal') {
      const prior = goals.get(row.goal.id)
      goals.set(row.goal.id, { ...row.goal, createdAtMs: prior?.createdAtMs ?? row.atMs, updatedAtMs: row.atMs,
        closedAtMs: row.goal.status === 'active' ? null : row.atMs, flowIds: prior?.flowIds ?? [] })
    } else if (row.type === 'flow/goal-selected' && goals.has(row.goalId)) selected = row.goalId
    else if (row.type === 'flow/goal-linked') {
      const goal = goals.get(row.goalId)
      if (goal && !goal.flowIds.includes(row.flowId)) goal.flowIds = [...goal.flowIds, row.flowId].slice(-50)
    }
  }
  const current = selected ? goals.get(selected) : undefined
  let visible = [...goals.values()].slice(-20)
  if (current && !visible.includes(current)) visible = [current, ...visible.slice(-19)]
  return { all: goals, visible, current, selected: current?.id ?? null }
}
