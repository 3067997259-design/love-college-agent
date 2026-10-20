import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createManualClock } from '../../src/main/clock'
import { createDesk } from '../../src/main/legacy-flow/desk'
import { openJournal } from '../../src/main/journal/file'
import { projectJournal } from '../../src/main/journal/projection'
import type { JournalInput } from '../../src/main/journal/schema'
import type { SessionStore } from '../../src/main/store/session'
import { taskDeskTools } from '../../src/main/task/desk-tools'
import { createTaskService } from '../../src/main/task/service'
import { seenFragments } from '../../src/main/memory/seen'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) {
  if (!resolve(root).startsWith(join(resolve(tmpdir()), 'lca-d2-'))) throw new Error('Unsafe test cleanup path')
  rmSync(root, { recursive: true, force: true })
} })
const owner = { userId: 'u', characterId: 'c' }
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'lca-d2-')); roots.push(root)
  const clock = createManualClock(1_000)
  const journal = openJournal(root, owner, clock)
  const store: SessionStore = { scope: journal.scope, records: journal.records, history: journal.records, projection: () => projectJournal(journal.records()), append: journal.append, close: journal.close }
  const desk = createDesk(join(root, 'desk'))
  const service = createTaskService({ store })
  const tools = taskDeskTools({ store, desk, authorized: () => !!service.authorizedActiveTask(), degraded: (turnId) => store.records().some((row) => row.type === 'turn/degraded' && row.turnId === turnId) })
  const append = (input: JournalInput) => { journal.append(input); clock.advanceBy(1_000) }
  return { root, clock, journal, store, desk, service, tools, append }
}
const context = (f: ReturnType<typeof setup>, turnId: string) => ({ clock: f.clock, store: f.store, turnId, signal: new AbortController().signal })

describe('D2 timeline and safety gates', () => {
  it('keeps workspace reads open but refuses writes until a task plan is approved', async () => {
    const f = setup()
    const read = f.tools.find((tool) => tool.definition.name === 'desk_read')!
    const write = f.tools.find((tool) => tool.definition.name === 'desk_write')!
    expect(await read.run({ path: 'answer.js' }, context(f, 'turn-1'))).toMatchObject({ ok: true })
    const refused = await write.run({ path: 'answer.js', text: 'return 42' }, context(f, 'turn-1'))
    expect(refused).toMatchObject({ ok: false, visible: { error: 'TASK_NOT_APPROVED' } })
    expect(f.store.records().some((row) => row.type === 'desk/change')).toBe(false)
    const task = f.service.propose({ title: 'synthetic', steps: ['write'] }, 'turn-2')
    if (!task.ok) throw new Error('PROPOSE_FAILED')
    f.service.dispatch({ type: 'task.approve', taskId: task.task.id, planVersion: 1, requestId: 'approve-1' }, 'sig')
    const wrote = await write.run({ path: 'answer.js', text: 'return 42' }, context(f, 'turn-3'))
    expect(wrote.ok).toBe(true)
    expect(f.store.records().find((row) => row.type === 'desk/change')).toMatchObject({ taskId: task.task.id, path: 'answer.js' })
    expect(f.desk.read('answer.js')).toBe('return 42')
    f.journal.close()
  })
  it('marks a degraded turn, refuses writes in it and refuses to create authorization while degraded', async () => {
    const f = setup()
    const task = f.service.propose({ title: 'synthetic', steps: ['write'] }, 'turn-1')
    if (!task.ok) throw new Error('PROPOSE_FAILED')
    f.append({ type: 'turn/start', turnId: 'degraded-turn', trigger: 'user' })
    f.append({ type: 'turn/degraded', turnId: 'degraded-turn', sources: ['mail'] })
    expect(projectJournal(f.store.records()).degraded).toMatchObject({ active: true, sources: ['mail'] })
    expect(f.service.dispatch({ type: 'task.approve', taskId: task.task.id, planVersion: 1, requestId: 'approve-1' }, 'sig')).toBe('permission-denied')
    const write = f.tools.find((tool) => tool.definition.name === 'desk_write')!
    expect(await write.run({ path: 'answer.js', text: 'return 42' }, context(f, 'degraded-turn')))
      .toMatchObject({ ok: false, visible: { error: 'DEGRADED_SOURCE_REQUIRES_APPROVAL' } })
    expect(f.store.records().some((row) => row.type === 'desk/change')).toBe(false)
    f.append({ type: 'turn/end', turnId: 'degraded-turn', reason: 'completed' })
    expect(projectJournal(f.store.records()).degraded).toBeNull()
    expect(f.service.dispatch({ type: 'task.approve', taskId: task.task.id, planVersion: 1, requestId: 'approve-2' }, 'sig')).toBeUndefined()
    expect(f.service.authorizedActiveTask()?.id).toBe(task.task.id)
    f.journal.close()
  })
  it('keeps workspace tool results out of experience memory while ordinary chat remains eligible', () => {
    const f = setup()
    f.append({ type: 'turn/start', turnId: 'turn-1', trigger: 'user' })
    f.append({ type: 'tool/call', turnId: 'turn-1', callId: 'call-desk', name: 'desk_write', arguments: { path: 'answer.js', text: 'return 42' }, templateId: 'desk_write' })
    f.append({ type: 'tool/result', turnId: 'turn-1', callId: 'call-desk', ok: true, raw: { changeId: 'change-1' }, visible: { changeId: 'change-1' }, elapsedMs: 1 })
    f.append({ type: 'model/seen', turnId: 'turn-1', source: 'fake', messages: [
      { role: 'user', content: 'WRITE_REQUEST' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'call-desk', name: 'desk_write', arguments: '{}' }] },
      { role: 'tool', content: '{"changeId":"change-1"}', toolCallId: 'call-desk' },
      { role: 'assistant', content: 'WORK_REPLY' },
    ], eligibleIndexes: [0, 1, 2, 3] })
    f.append({ type: 'turn/end', turnId: 'turn-1', reason: 'completed' })
    expect(seenFragments(f.store.records(), true).map((fragment) => fragment.origin)).toEqual(['user'])
    const all = seenFragments(f.store.records(), false).map((fragment) => fragment.role)
    expect(all).toContain('tool'); expect(all).toContain('assistant')
    f.journal.close()
  })
})
