import { randomUUID } from 'node:crypto'
import type { PublicErrorCode, TaskCardView } from '../../shared'
import type { JournalInput } from '../journal/schema'
import type { SessionStore } from '../store/session'

/**
 * D1 task object service. Proposals and plans are facts, not authorization: only a user approval of
 * one concrete plan version grants the desk scope. One task can be in hand at a time; terminal states
 * are user decisions and survive restart by replaying the journal.
 */
export type TaskStepStatus = 'pending' | 'active' | 'done' | 'failed'
export interface TaskProposalInput { title: string; steps: readonly string[]; goalId?: string }
export interface TaskApproveCommand { type: 'task.approve'; taskId: string; planVersion: number; requestId?: string }
export interface TaskCloseCommand { type: 'task.close'; taskId: string; status: 'completed' | 'abandoned'; summary?: string; requestId?: string }
export type TaskCommand = TaskApproveCommand | TaskCloseCommand
export type TaskProposeResult = { ok: true; task: TaskCardView } | { ok: false; error: 'task-busy' }
export type TaskStepResult = { ok: true } | { ok: false; error: 'no-active-task' | 'plan-not-approved' | 'invalid-step' }

const terminal = (task: TaskCardView) => task.closedAtMs !== null
/** Approval must target the exact latest plan version; a newer plan invalidates it. */
const authorized = (task: TaskCardView) => !terminal(task) && !!task.plan && !!task.approval && task.plan.version === task.approval.planVersion

export interface TaskService {
  propose(input: TaskProposalInput, turnId: string): TaskProposeResult
  updateStep(input: { stepId: string; status: TaskStepStatus }, turnId: string): TaskStepResult
  dispatch(command: TaskCommand, signature: string): PublicErrorCode | undefined
  /** The in-hand task, only when its current plan version is approved. D2 desk writes will consume this. */
  authorizedActiveTask(): TaskCardView | null
  isPlanAuthorized(taskId: string, planVersion?: number): boolean
}

export function createTaskService(options: { store: SessionStore; changed?: () => void }): TaskService {
  const { store } = options
  const append = (input: JournalInput) => { store.append(input); options.changed?.() }
  return {
    propose(input, turnId) {
      if (store.projection().tasks.some((task) => !terminal(task))) return { ok: false, error: 'task-busy' }
      const id = randomUUID()
      append({ type: 'task/open', id, title: input.title, ...(input.goalId ? { goalId: input.goalId } : {}), workspace: 'desk', source: 'model', turnId })
      append({ type: 'task/plan', taskId: id, planVersion: 1, source: 'model', steps: input.steps.map((text, index) => ({ id: 'step-' + (index + 1), text })), turnId })
      const task = store.projection().tasks.find((item) => item.id === id)
      if (!task) throw new Error('TASK_PROJECTION_FAILED')
      return { ok: true, task }
    },
    updateStep(input, turnId) {
      const view = store.projection()
      const task = view.tasks.find((item) => item.id === view.activeTaskId)
      if (!task) return { ok: false, error: 'no-active-task' }
      if (!authorized(task)) return { ok: false, error: 'plan-not-approved' }
      if (!task.plan?.steps.some((step) => step.id === input.stepId)) return { ok: false, error: 'invalid-step' }
      append({ type: 'task/step', taskId: task.id, stepId: input.stepId, status: input.status, turnId })
      return { ok: true }
    },
    dispatch(command, signature) {
      const view = store.projection()
      const task = view.tasks.find((item) => item.id === command.taskId)
      if (!task || terminal(task)) return 'invalid-command'
      if (command.type === 'task.approve') {
        if (!task.plan || task.plan.version !== command.planVersion) return 'invalid-command'
        if (task.approval?.planVersion === command.planVersion) return 'invalid-command'
        if (view.activeTaskId !== null && view.activeTaskId !== task.id) return 'unavailable'
        append({ type: 'task/approve', taskId: task.id, planVersion: command.planVersion, scope: { writes: 'desk', commands: 'each' },
          ...(command.requestId ? { requestId: command.requestId, commandHash: signature } : {}) })
        if (view.activeTaskId !== task.id) append({ type: 'task/focus', taskId: task.id })
      } else {
        append({ type: 'task/close', taskId: task.id, status: command.status, ...(command.summary ? { summary: command.summary } : {}),
          ...(command.requestId ? { requestId: command.requestId, commandHash: signature } : {}) })
      }
      return undefined
    },
    authorizedActiveTask() {
      const view = store.projection()
      const task = view.tasks.find((item) => item.id === view.activeTaskId)
      return task && authorized(task) ? task : null
    },
    isPlanAuthorized(taskId, planVersion) {
      const task = store.projection().tasks.find((item) => item.id === taskId)
      return !!task && authorized(task) && (planVersion === undefined || task.plan!.version === planVersion)
    },
  }
}
