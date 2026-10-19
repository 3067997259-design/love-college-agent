import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createManualClock } from '../../src/main/clock'
import { openJournal } from '../../src/main/journal/file'
import { projectJournal } from '../../src/main/journal/projection'
import type { SessionStore } from '../../src/main/store/session'
import { carryOpenTask } from '../../src/main/task/carry'
import { createTaskService } from '../../src/main/task/service'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) {
  if (!resolve(root).startsWith(join(resolve(tmpdir()), 'lca-carry-'))) throw new Error('Unsafe test cleanup path')
  rmSync(root, { recursive: true, force: true })
} })
const owner = { userId: 'u', characterId: 'c' }
const storeFor = (journal: ReturnType<typeof openJournal>, history: () => ReturnType<ReturnType<typeof openJournal>['records']>): SessionStore => ({
  scope: journal.scope, records: journal.records, history, projection: () => projectJournal(journal.records()), append: journal.append, close: journal.close,
})

describe('D4 cross-day task carry', () => {
  it('reopens a previous-day child task as a fresh proposal with its handoff checkpoint and requires re-approval', () => {
    const root = mkdtempSync(join(tmpdir(), 'lca-carry-'))
    roots.push(root)
    const day1 = createManualClock(Date.parse('2026-10-19T10:00:00+08:00'))
    const first = openJournal(root, owner, day1)
    first.append({ type: 'task/open', id: 'task-1', title: '写完作业二', workspace: 'desk', source: 'model' })
    first.append({ type: 'task/plan', taskId: 'task-1', planVersion: 1, source: 'model', steps: [{ id: 'step-1', text: '写 answer.js' }, { id: 'step-2', text: '检查' }] })
    first.append({ type: 'task/approve', taskId: 'task-1', planVersion: 1, scope: { writes: 'desk', commands: 'each' }, requestId: 'approve-1', commandHash: 'h' })
    first.append({ type: 'task/focus', taskId: 'task-1' })
    first.append({ type: 'task/handoff', id: 'handoff-1', taskId: 'task-1', planVersion: 1, source: 'model', completed: ['写 answer.js'], decisions: [], unresolved: [], next: ['检查'], evidence: { changes: [], commands: [], lifeWork: [] } })
    const day1Rows = first.records()
    first.close()
    // A day later the session store opens a new day; the previous day is only history.
    const day2 = createManualClock(Date.parse('2026-10-20T10:00:00+08:00'))
    const second = openJournal(root, owner, day2)
    const history = () => [...day1Rows, ...second.records()]
    const store = storeFor(second, history)
    expect(carryOpenTask(store)).toBe(true)
    const view = projectJournal(second.records())
    expect(view.tasks).toHaveLength(1)
    expect(view.tasks[0]).toMatchObject({ id: 'task-1', title: '写完作业二', status: 'proposed', plan: { version: 1 }, latestHandoff: { source: 'model', completed: ['写 answer.js'], next: ['检查'] } })
    expect(view.tasks[0].approval).toBeUndefined()
    expect(view.activeTaskId).toBeNull()
    expect(carryOpenTask(store)).toBe(false)
    // The user must approve the plan version again; a new approval is a new fact.
    const service = createTaskService({ store })
    expect(service.authorizedActiveTask()).toBeNull()
    expect(service.dispatch({ type: 'task.approve', taskId: 'task-1', planVersion: 1, requestId: 'approve-2' }, 'sig')).toBeUndefined()
    expect(projectJournal(second.records()).activeTaskId).toBe('task-1')
    expect(second.records().filter((row) => row.type === 'task/approve')).toHaveLength(1)
    second.close()
  })
})
