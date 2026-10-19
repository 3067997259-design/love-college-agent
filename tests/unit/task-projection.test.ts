import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createManualClock } from '../../src/main/clock'
import { openJournal } from '../../src/main/journal/file'
import { projectJournal } from '../../src/main/journal/projection'
import type { JournalInput } from '../../src/main/journal/schema'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) {
  if (!resolve(root).startsWith(join(resolve(tmpdir()), 'lca-task-'))) throw new Error('Unsafe test cleanup path')
  rmSync(root, { recursive: true, force: true })
} })
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'lca-task-')); roots.push(root)
  const clock = createManualClock(1_000)
  const journal = openJournal(root, { userId: 'u', characterId: 'c' }, clock)
  const append = (input: JournalInput) => { journal.append(input); clock.advanceBy(1_000) }
  return { root, clock, journal, append }
}
const openTask = (id = 'task-1'): JournalInput => ({ type: 'task/open', id, title: 'Synthetic task', workspace: 'desk', source: 'model' })
const planTask = (planVersion = 1): JournalInput => ({ type: 'task/plan', taskId: 'task-1', planVersion, source: 'model', steps: [{ id: 's1', text: 'read' }, { id: 's2', text: 'write' }] })
const approve = (planVersion = 1): JournalInput => ({ type: 'task/approve', taskId: 'task-1', planVersion, scope: { writes: 'desk', commands: 'each' } })
const focus = (): JournalInput => ({ type: 'task/focus', taskId: 'task-1' })

describe('D1 task object projection', () => {
  it('projects proposal, approval, in-hand task, step, checkpoint and close, and replays identically after restart', () => {
    const f = setup()
    f.append(openTask()); f.append(planTask()); f.append(approve()); f.append(focus())
    f.append({ type: 'task/step', taskId: 'task-1', stepId: 's1', status: 'done' })
    f.append({ type: 'task/checkpoint', id: 'cp-1', taskId: 'task-1', source: 'model', summary: 'read the input', evidenceSeqs: [4] })
    const view = projectJournal(f.journal.records())
    expect(view.activeTaskId).toBe('task-1')
    expect(view.tasks).toHaveLength(1)
    const card = view.tasks[0]
    expect(card).toMatchObject({ id: 'task-1', title: 'Synthetic task', workspace: 'desk', status: 'active', closedAtMs: null,
      approval: { planVersion: 1, scope: { writes: 'desk', commands: 'each' } } })
    expect(card.plan?.version).toBe(1)
    expect(card.plan?.steps.map((step) => step.status)).toEqual(['done', 'pending'])
    expect(card.checkpoints).toMatchObject([{ id: 'cp-1', summary: 'read the input', source: 'model', evidenceSeqs: [4] }])
    f.append({ type: 'task/close', taskId: 'task-1', status: 'completed' })
    const closed = projectJournal(f.journal.records())
    expect(closed.activeTaskId).toBeNull()
    expect(closed.tasks[0]).toMatchObject({ status: 'completed' })
    expect(closed.tasks[0].closedAtMs).not.toBeNull()
    const before = JSON.stringify(closed)
    f.journal.close()
    const reopened = openJournal(f.root, { userId: 'u', characterId: 'c' }, f.clock)
    expect(JSON.stringify(projectJournal(reopened.records()))).toBe(before)
    reopened.close()
  })
  it('drops a stale approval and resets step progress when a new plan version is proposed', () => {
    const f = setup()
    f.append(openTask()); f.append(planTask(1)); f.append(approve(1)); f.append(focus())
    f.append({ type: 'task/step', taskId: 'task-1', stepId: 's1', status: 'done' })
    f.append(planTask(2))
    const card = projectJournal(f.journal.records()).tasks[0]
    expect(card.approval).toBeUndefined()
    expect(card.status).toBe('active')
    expect(card.plan?.version).toBe(2)
    expect(card.plan?.steps.map((step) => step.status)).toEqual(['pending', 'pending'])
    f.journal.close()
  })
  it('keeps an unapproved task proposed and clears the in-hand task when it is abandoned', () => {
    const f = setup()
    f.append(openTask()); f.append(planTask())
    expect(projectJournal(f.journal.records()).tasks[0]).toMatchObject({ status: 'proposed' })
    f.append(approve()); f.append(focus())
    f.append({ type: 'task/close', taskId: 'task-1', status: 'abandoned' })
    const view = projectJournal(f.journal.records())
    expect(view.activeTaskId).toBeNull()
    expect(view.tasks[0]).toMatchObject({ status: 'abandoned' })
    f.journal.close()
  })
})
