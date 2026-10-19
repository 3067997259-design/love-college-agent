import { randomUUID } from 'node:crypto'
import type { SessionStore } from '../store/session'

/**
 * D4 cross-day resume. When today's journal has no task yet, re-materialise the latest previous-day
 * open task from its handoff checkpoint: the task and plan return as a proposal (no approval), the
 * checkpoint becomes the visible B-segment context, and the user must approve the plan version again.
 * Old authorizations are never copied forward.
 */
export function carryOpenTask(store: SessionStore): boolean {
  const today = store.records()
  if (today.some((row) => row.type === 'task/open')) return false
  const history = store.history?.() ?? today
  const open = history.filter((row) => row.type === 'task/open')
  const closed = new Set(history.flatMap((row) => row.type === 'task/close' ? [row.taskId] : []))
  const plans = new Map(history.flatMap((row) => row.type === 'task/plan' ? [[row.taskId, row] as const] : []))
  // A model-validated checkpoint is richer than a late code fallback; carry it when both exist.
  const handoffRows = history.filter((row) => row.type === 'task/handoff')
  const handoffFor = (taskId: string) => handoffRows.filter((row) => row.taskId === taskId && row.source === 'model').at(-1) ?? handoffRows.filter((row) => row.taskId === taskId).at(-1)
  const candidate = open.findLast((row) => !closed.has(row.id) && plans.has(row.id) && handoffFor(row.id) !== undefined)
  if (!candidate) return false
  const plan = plans.get(candidate.id)!
  const handoff = handoffFor(candidate.id)!
  store.append({ type: 'task/open', id: candidate.id, title: candidate.title, ...(candidate.goalId ? { goalId: candidate.goalId } : {}), workspace: 'desk', source: 'user' })
  store.append({ type: 'task/plan', taskId: candidate.id, planVersion: plan.planVersion, source: 'model', steps: plan.steps })
  store.append({ type: 'task/handoff', id: randomUUID(), taskId: candidate.id, planVersion: plan.planVersion, source: handoff.source,
    completed: handoff.completed, decisions: handoff.decisions, unresolved: handoff.unresolved, next: handoff.next, evidence: handoff.evidence })
  return true
}
