import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createAppController } from '../../src/main/bridge/controller'
import { createManualClock } from '../../src/main/clock'
import { openJournal } from '../../src/main/journal/file'
import { projectJournal } from '../../src/main/journal/projection'
import type { JournalInput } from '../../src/main/journal/schema'
import type { SessionStore } from '../../src/main/store/session'
import { createTaskService } from '../../src/main/task/service'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) {
  if (!resolve(root).startsWith(join(resolve(tmpdir()), 'lca-task-service-'))) throw new Error('Unsafe test cleanup path')
  rmSync(root, { recursive: true, force: true })
} })
const owner = { userId: 'u', characterId: 'c' }
function wrap(journal: ReturnType<typeof openJournal>): SessionStore {
  return { scope: journal.scope, records: journal.records, history: journal.records,
    projection: () => projectJournal(journal.records()), append: journal.append, close: journal.close }
}
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'lca-task-service-')); roots.push(root)
  const clock = createManualClock(1_000)
  const journal = openJournal(root, owner, clock)
  const store = wrap(journal)
  const service = createTaskService({ store })
  const append = (input: JournalInput) => { journal.append(input); clock.advanceBy(1_000) }
  return { root, clock, journal, store, service, append }
}
function proposed(service: ReturnType<typeof createTaskService>) {
  const result = service.propose({ title: 'write answer', steps: ['read the input', 'write answer.js'] }, 'turn-1')
  if (!result.ok) throw new Error('PROPOSE_FAILED')
  return result.task
}

describe('D1 task service', () => {
  it('creates one proposal with a plan and refuses a second open task', () => {
    const f = setup()
    const task = proposed(f.service)
    expect(task).toMatchObject({ title: 'write answer', status: 'proposed', plan: { version: 1, source: 'model' } })
    expect(task.plan?.steps.map((step) => step.text)).toEqual(['read the input', 'write answer.js'])
    expect(f.journal.records().filter((row) => row.type === 'task/open')).toHaveLength(1)
    expect(f.journal.records().filter((row) => row.type === 'task/plan')).toHaveLength(1)
    expect(f.service.propose({ title: 'other task', steps: ['x'] }, 'turn-2')).toEqual({ ok: false, error: 'task-busy' })
    f.journal.close()
  })
  it('binds approval to the exact plan version and puts only one task in hand', () => {
    const f = setup(); const task = proposed(f.service)
    expect(f.service.dispatch({ type: 'task.approve', taskId: task.id, planVersion: 2, requestId: 'r1' }, 'sig')).toBe('invalid-command')
    expect(f.service.dispatch({ type: 'task.approve', taskId: task.id, planVersion: 1, requestId: 'r2' }, 'sig')).toBeUndefined()
    const view = projectJournal(f.journal.records())
    expect(view.activeTaskId).toBe(task.id)
    expect(view.tasks[0]).toMatchObject({ status: 'active', approval: { planVersion: 1, scope: { writes: 'desk', commands: 'each' } } })
    expect(f.service.dispatch({ type: 'task.approve', taskId: task.id, planVersion: 1, requestId: 'r3' }, 'sig')).toBe('invalid-command')
    expect(f.service.authorizedActiveTask()?.id).toBe(task.id)
    expect(f.service.isPlanAuthorized(task.id, 1)).toBe(true)
    expect(f.service.isPlanAuthorized(task.id, 2)).toBe(false)
    f.journal.close()
  })
  it('updates steps only for the approved in-hand task', () => {
    const f = setup(); const task = proposed(f.service)
    expect(f.service.updateStep({ stepId: 'step-1', status: 'done' }, 'turn-1')).toEqual({ ok: false, error: 'no-active-task' })
    f.service.dispatch({ type: 'task.approve', taskId: task.id, planVersion: 1, requestId: 'r1' }, 'sig')
    expect(f.service.updateStep({ stepId: 'step-1', status: 'done' }, 'turn-2')).toEqual({ ok: true })
    expect(f.service.updateStep({ stepId: 'unknown', status: 'done' }, 'turn-2')).toEqual({ ok: false, error: 'invalid-step' })
    const view = projectJournal(f.journal.records())
    expect(view.tasks[0].plan?.steps.map((step) => step.status)).toEqual(['done', 'pending'])
    f.journal.close()
  })
  it('lets only the user close a task and clears the in-hand slot', () => {
    const f = setup(); const task = proposed(f.service)
    f.service.dispatch({ type: 'task.approve', taskId: task.id, planVersion: 1, requestId: 'r1' }, 'sig')
    expect(f.service.dispatch({ type: 'task.close', taskId: task.id, status: 'completed', summary: 'synthetic done', requestId: 'r2' }, 'sig')).toBeUndefined()
    const view = projectJournal(f.journal.records())
    expect(view.activeTaskId).toBeNull()
    expect(view.tasks[0]).toMatchObject({ status: 'completed' })
    expect(f.service.dispatch({ type: 'task.close', taskId: task.id, status: 'abandoned', requestId: 'r3' }, 'sig')).toBe('invalid-command')
    f.journal.close()
  })
  it('keeps state across restart and requires a fresh approval for a new plan version', () => {
    const f = setup(); const task = proposed(f.service)
    f.service.dispatch({ type: 'task.approve', taskId: task.id, planVersion: 1, requestId: 'r1' }, 'sig')
    f.journal.close()
    const reopened = openJournal(f.root, owner, f.clock)
    const store = wrap(reopened)
    const service = createTaskService({ store })
    expect(service.authorizedActiveTask()?.id).toBe(task.id)
    reopened.append({ type: 'task/plan', taskId: task.id, planVersion: 2, source: 'model', steps: [{ id: 'step-1', text: 'read again' }] })
    expect(service.authorizedActiveTask()).toBeNull()
    expect(service.isPlanAuthorized(task.id)).toBe(false)
    expect(service.updateStep({ stepId: 'step-1', status: 'done' }, 'turn-2')).toEqual({ ok: false, error: 'plan-not-approved' })
    expect(service.dispatch({ type: 'task.approve', taskId: task.id, planVersion: 1, requestId: 'r2' }, 'sig')).toBe('invalid-command')
    expect(service.dispatch({ type: 'task.approve', taskId: task.id, planVersion: 2, requestId: 'r3' }, 'sig')).toBeUndefined()
    expect(service.authorizedActiveTask()?.plan?.version).toBe(2)
    reopened.close()
  })
  it('replays a repeated task.approve request without writing a second approval', () => {
    const f = setup(); const task = proposed(f.service)
    const controller = createAppController(f.clock, undefined, f.store)
    controller.attachTask(f.service)
    const command = { protocolVersion: 1 as const, requestId: 'approve-request', epoch: controller.getSnapshot().epoch, type: 'task.approve' as const, taskId: task.id, planVersion: 1 }
    expect(controller.dispatch(command).status).toBe('accepted')
    expect(controller.dispatch(command).status).toBe('accepted')
    expect(f.journal.records().filter((row) => row.type === 'task/approve')).toHaveLength(1)
    expect(controller.getSnapshot().activeTaskId).toBe(task.id)
    expect(controller.dispatch({ protocolVersion: 1, requestId: 'close-request', epoch: controller.getSnapshot().epoch, type: 'task.close', taskId: task.id, status: 'completed' }).status).toBe('accepted')
    expect(controller.getSnapshot().tasks?.[0]).toMatchObject({ status: 'completed' })
    controller.dispose()
    f.journal.close()
  })
})
