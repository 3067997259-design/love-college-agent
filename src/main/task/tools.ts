import { z } from 'zod'
import type { HarnessTool, ToolResult } from '../harness/tools'
import type { TaskService } from './service'

const proposeSchema = z.strictObject({
  title: z.string().trim().min(1).max(200),
  steps: z.array(z.string().trim().min(1).max(500)).min(1).max(30),
  goalId: z.string().min(1).max(128).optional(),
})
const stepSchema = z.strictObject({ stepId: z.string().min(1).max(128), status: z.enum(['pending', 'active', 'done', 'failed']) })

/**
 * Model-facing D1 task tools. `task_propose` only creates a proposal plus a plan version; it never
 * grants a scope. `task_step` can update the approved in-hand plan only. Both expose fixed error
 * codes back to the model and never echo journal internals.
 */
export function taskTools(service: TaskService): { propose: HarnessTool; step: HarnessTool } {
  return {
    propose: {
      definition: {
        name: 'task_propose',
        description: 'Propose one cross-turn task with a versioned plan. This is a proposal, not authorization: the user must approve the plan version before desk writes or commands are allowed. Refused while another task is open.',
        parameters: {
          type: 'object',
          properties: {
            title: { type: 'string', description: 'Short task title.' },
            steps: { type: 'array', items: { type: 'string' }, description: 'Ordered plan steps, one concrete action each.' },
            goalId: { type: 'string', description: 'Optional existing work-goal id.' },
          },
          required: ['title', 'steps'],
          additionalProperties: false,
        },
      },
      templateId: 'task.propose',
      validate: (input) => proposeSchema.safeParse(input).success,
      run: async (input, { turnId, signal }): Promise<ToolResult> => {
        signal.throwIfAborted()
        const result = service.propose(proposeSchema.parse(input), turnId)
        if (!result.ok) {
          const raw: ToolResult['raw'] = { error: result.error }
          const visible: ToolResult['visible'] = { error: result.error, requirement: 'Close the current task before proposing a new one.' }
          return { ok: false, raw, visible }
        }
        const raw: ToolResult['raw'] = { taskId: result.task.id, planVersion: result.task.plan?.version ?? 1 }
        const visible: ToolResult['visible'] = { taskId: result.task.id, title: result.task.title, planVersion: result.task.plan?.version ?? 1,
          steps: result.task.plan?.steps.map((step) => step.text) ?? [] }
        return { ok: true, raw, visible }
      },
    },
    step: {
      definition: {
        name: 'task_step',
        description: 'Update one step of the in-hand task plan after the user approved its current plan version. Refused when no task is in hand or the plan version is not approved.',
        parameters: {
          type: 'object',
          properties: {
            stepId: { type: 'string', description: 'Plan step id from the approved proposal.' },
            status: { type: 'string', enum: ['pending', 'active', 'done', 'failed'] },
          },
          required: ['stepId', 'status'],
          additionalProperties: false,
        },
      },
      templateId: 'task.step',
      validate: (input) => stepSchema.safeParse(input).success,
      run: async (input, { turnId, signal }): Promise<ToolResult> => {
        signal.throwIfAborted()
        const result = service.updateStep(stepSchema.parse(input), turnId)
        const raw: ToolResult['raw'] = result.ok ? { updated: true } : { error: result.error }
        const visible: ToolResult['visible'] = { ...raw }
        return { ok: result.ok, raw, visible }
      },
    },
  }
}
