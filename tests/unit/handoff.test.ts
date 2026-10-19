import { readFileSync } from 'node:fs'
import { mkdtempSync, rmSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createManualClock } from '../../src/main/clock'
import { openJournal } from '../../src/main/journal/file'
import { projectJournal } from '../../src/main/journal/projection'
import type { JournalInput } from '../../src/main/journal/schema'
import type { SessionStore } from '../../src/main/store/session'
import { createHandoffService } from '../../src/main/task/handoff'
import { createTaskService } from '../../src/main/task/service'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) {
  if (!resolve(root).startsWith(join(resolve(tmpdir()), 'lca-handoff-'))) throw new Error('Unsafe test cleanup path')
  rmSync(root, { recursive: true, force: true })
} })
const owner = { userId: 'u', characterId: 'c' }
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'lca-handoff-')); roots.push(root)
  const clock = createManualClock(1_000)
  const journal = openJournal(root, owner, clock)
  const store: SessionStore = { scope: journal.scope, records: journal.records, history: journal.records, projection: () => projectJournal(journal.records()), append: journal.append, close: journal.close }
  const tasks = createTaskService({ store })
  const handoff = createHandoffService({ store, tasks })
  const append = (input: JournalInput) => { journal.append(input); clock.advanceBy(1_000) }
  const approved = () => {
    const proposed = tasks.propose({ title: '写完作业二', steps: ['写 answer.js', '检查'] }, 'turn-1')
    if (!proposed.ok) throw new Error('PROPOSE_FAILED')
    tasks.dispatch({ type: 'task.approve', taskId: proposed.task.id, planVersion: 1, requestId: 'approve-1' }, 'sig')
    return proposed.task.id
  }
  return { clock, journal, store, tasks, handoff, append, approved }
}
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex')

describe('D4 handoff checkpoint', () => {
  it('validates user decisions, attaches code evidence and becomes the latest task checkpoint', () => {
    const f = setup(); const taskId = f.approved()
    f.append({ type: 'user/message', id: 'user-1', text: '用 JSON 写，不要用 YAML', requestId: 'r1', commandHash: 'h1' })
    f.append({ type: 'turn/start', turnId: 'handoff-turn', trigger: 'pomodoro' })
    f.append({ type: 'desk/change', id: 'change-1', taskId, path: 'answer.js', before: null, after: 'return 42', pending: true })
    f.append({ type: 'desk/settled', id: 'change-1', status: 'applied' })
    const result = f.handoff.submit({ completed: ['写了 answer.js'], decisions: [{ messageId: 'user-1', text: '用 JSON 写' }], unresolved: ['还没检查'], next: ['运行检查'] }, 'handoff-turn')
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('HANDOFF_REJECTED')
    expect(result.handoff).toMatchObject({ taskId, planVersion: 1, source: 'model', completed: ['写了 answer.js'], decisions: [{ messageId: 'user-1', text: '用 JSON 写' }] })
    expect(result.handoff.evidence.changes).toEqual([{ path: 'answer.js', sha256: sha256('return 42') }])
    expect(projectJournal(f.store.records()).tasks[0].latestHandoff).toMatchObject({ id: result.handoff.id, source: 'model' })
    expect(f.store.records().find((row) => row.type === 'task/handoff')).toMatchObject({ turnId: 'handoff-turn', source: 'model' })
    f.journal.close()
  })
  it('rejects paraphrased decisions, empty checkpoints and unauthorized submissions', () => {
    const f = setup(); const taskId = f.approved()
    f.append({ type: 'user/message', id: 'user-1', text: '用 JSON 写，不要用 YAML', requestId: 'r1', commandHash: 'h1' })
    f.append({ type: 'turn/start', turnId: 't', trigger: 'pomodoro' })
    expect(f.handoff.submit({ completed: ['写了 answer.js'], decisions: [{ messageId: 'user-1', text: '她同意用 JSON' }], unresolved: [], next: [] }, 't')).toEqual({ ok: false, error: 'invalid-decision' })
    expect(f.handoff.submit({ completed: [], decisions: [], unresolved: [], next: [] }, 't')).toEqual({ ok: false, error: 'invalid-content' })
    expect(f.store.records().some((row) => row.type === 'task/handoff')).toBe(false)
    expect(f.store.records().find((row) => row.type === 'desk/change' && row.taskId === taskId)).toBeUndefined()
    f.journal.close()
  })
  it('writes a code-only fallback with evidence when the model turn produced no valid checkpoint', () => {
    const f = setup(); const taskId = f.approved()
    f.tasks.updateStep({ stepId: 'step-1', status: 'done' }, 'work-turn')
    f.append({ type: 'desk/change', id: 'change-1', taskId, path: 'answer.js', before: null, after: 'return 42', pending: true })
    f.append({ type: 'desk/settled', id: 'change-1', status: 'applied' })
    const fallback = f.handoff.fallback('handoff-turn')
    expect(fallback).toMatchObject({ taskId, source: 'fallback', completed: ['写 answer.js'], next: ['检查'] })
    expect(fallback?.evidence.changes).toEqual([{ path: 'answer.js', sha256: sha256('return 42') }])
    f.journal.close()
  })
  it('wires the handoff tool, B-segment insertion and fallback into the main composition', () => {
    const source = readFileSync(new URL('../../src/main/index.ts', import.meta.url), 'utf8')
    expect(source).toContain('handoffTool')
    expect(source).toContain('handoffCheckpoint')
    expect(source).toContain('handoffService.fallback(turnId)')
    expect(source).toContain("kind === 'focus-ended'")
  })
})
