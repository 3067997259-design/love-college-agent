import { randomUUID } from 'node:crypto'
import { createHash } from 'node:crypto'
import type { TaskHandoffView } from '../../shared'
import type { SessionStore } from '../store/session'
import type { TaskService } from './service'

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex')
const clean = (values: readonly string[]) => values.map((value) => value.trim()).filter((value) => value.length > 0)

export interface HandoffSubmit {
  completed: readonly string[]
  decisions: readonly { messageId: string; text: string }[]
  unresolved: readonly string[]
  next: readonly string[]
}
export type HandoffResult = { ok: true; handoff: TaskHandoffView } | { ok: false; error: 'no-authorized-task' | 'invalid-decision' | 'invalid-content' }

/**
 * D4 handoff. The model may summarize, but code validates every decision against a real user message,
 * attaches evidence itself (desk changes, command receipts, her own work) and always produces a
 * code-only fallback when the model turn fails or no valid checkpoint arrives.
 */
export function createHandoffService(options: { store: SessionStore; tasks: TaskService }) {
  const { store } = options
  const rows = () => store.records()
  const evidence = (taskId: string) => {
    const changes = new Map<string, string>()
    for (const row of rows()) if (row.type === 'desk/change' && row.taskId === taskId && !row.undoes) changes.set(row.path, sha256(row.after ?? ''))
    const commands = rows().flatMap((row) => row.type === 'flow/command' ? [{ id: row.id, status: row.status === 'completed' ? 'completed' as const : row.status === 'failed' ? 'failed' as const : 'unknown' as const }] : []).slice(-10)
    const lifeWork = new Map<string, { id: string; path: string; sha256: string }>()
    for (const row of rows()) if (row.type === 'life/work-state' && row.job.output) lifeWork.set(row.job.id, { id: row.job.id, path: row.job.output.path, sha256: row.job.output.sha256 })
    return { changes: [...changes.entries()].map(([path, hash]) => ({ path, sha256: hash })), commands,
      lifeWork: [...lifeWork.values()].slice(-10) }
  }
  const append = (taskId: string, planVersion: number, source: 'model' | 'fallback', submit: HandoffSubmit, turnId?: string): TaskHandoffView => {
    const id = randomUUID()
    store.append({ type: 'task/handoff', id, taskId, planVersion, source, ...(turnId ? { turnId } : {}),
      completed: clean(submit.completed).slice(0, 20), decisions: submit.decisions.slice(0, 10).map((decision) => ({ messageId: decision.messageId, text: decision.text.trim().slice(0, 300) })),
      unresolved: clean(submit.unresolved).slice(0, 10), next: clean(submit.next).slice(0, 10), evidence: evidence(taskId) })
    return store.projection().tasks.find((task) => task.id === taskId)!.latestHandoff!
  }
  return {
    submit(submit: HandoffSubmit, turnId?: string): HandoffResult {
      const task = options.tasks.authorizedActiveTask()
      if (!task?.plan) return { ok: false, error: 'no-authorized-task' }
      if (!submit.completed.length && !submit.unresolved.length && !submit.next.length) return { ok: false, error: 'invalid-content' }
      const users = new Map(rows().flatMap((row) => row.type === 'user/message' ? [[row.id, row.text] as const] : []))
      for (const decision of submit.decisions) {
        const source = users.get(decision.messageId)
        // A decision must quote a real user message; code never lets the model paraphrase it into authority.
        if (!source || !source.includes(decision.text.trim()) || !decision.text.trim()) return { ok: false, error: 'invalid-decision' }
      }
      return { ok: true, handoff: append(task.id, task.plan.version, 'model', submit, turnId) }
    },
    fallback(turnId?: string): TaskHandoffView | undefined {
      const task = options.tasks.authorizedActiveTask() ?? store.projection().tasks.find((item) => item.closedAtMs === null && item.approval && item.plan)
      if (!task?.plan) return undefined
      const done = task.plan.steps.filter((step) => step.status === 'done').map((step) => step.text)
      const remaining = task.plan.steps.filter((step) => step.status !== 'done').map((step) => step.text)
      return append(task.id, task.plan.version, 'fallback', { completed: done, decisions: [], unresolved: [], next: remaining }, turnId)
    },
    latest(taskId: string) { return store.projection().tasks.find((task) => task.id === taskId)?.latestHandoff },
  }
}
export type HandoffService = ReturnType<typeof createHandoffService>
