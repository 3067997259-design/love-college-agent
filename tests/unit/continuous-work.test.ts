import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createManualClock } from '../../src/main/clock'
import { createContinuousWork, type WorkRuntimeContext, type WorkRuntime } from '../../src/main/work/service'
import { openWorkJournal } from '../../src/main/work/journal'
import type { ContinuousWorkCommand, ContinuousWorkView } from '../../src/shared/continuity'

const owner = { userId: 'user', characterId: 'character', dataRootId: 'isolated-profile' }
const services: ReturnType<typeof createContinuousWork>[] = []
afterEach(async () => { await Promise.all(services.splice(0).map(service => service.close())) })
const tick = async () => { for (let i = 0; i < 10; i++) await Promise.resolve() }
const target = (work: ContinuousWorkView) => ({ identity: work.identity, expectedRevision: work.revision })
function fixture(root = mkdtempSync(join(tmpdir(), 'lca-work-'))) {
  const clock = createManualClock(1_790_000_000_000)
  const instances: { context: WorkRuntimeContext; events: string[]; revisions: number[]; stopped: boolean }[] = []
  let held = false
  const service = createContinuousWork({ root, owner, clock, available: () => true, held: () => held,
    project: id => ({ id, path: `D:/fixture/${id}` }), decision: id => ({ id, text: `Original ${id}`, atMs: clock.nowMs() }), safeText: text => text, changed: () => {},
    createRuntime: context => {
      const instance = { context, events: [] as string[], revisions: [] as number[], stopped: false }; instances.push(instance)
      const runtime: WorkRuntime = { deliver: async event => { instance.events.push(event.eventId) }, invalidateWork: value => { instance.revisions.push(value) },
        close: async () => { instance.stopped = true }, busy: () => !instance.stopped, stateChanged: () => {}, untrust: () => {}, efforts: () => {} }
      return runtime
    } })
  services.push(service)
  const create = (id: string, projectId = 'project-a') => {
    const command: ContinuousWorkCommand = { type: 'work.create', projectId, objective: `Objective ${id}`, acceptance: ['Actual output'], decisionIds: [id] }
    const result = service.dispatch(command, `create-${id}`); expect(result.error).toBeUndefined(); return { command, workId: result.work!.identity.workId }
  }
  const view = (id: string) => service.view().items.find(work => work.identity.workId === id)!
  return { root, service, instances, create, view, clock, hold: () => { held = true; service.stateChanged() } }
}

describe('durable work scheduling and delivery', () => {
  it('runs two projects, serializes the same project, and does not count turn-end as completion', async () => {
    const f = fixture(), a = f.create('a'), b = f.create('b'), c = f.create('c', 'project-b'), d = f.create('d', 'project-c')
    await tick()
    expect(f.instances).toHaveLength(2)
    expect(f.view(a.workId).status).toBe('running'); expect(f.view(b.workId).status).toBe('queued'); expect(f.view(c.workId).status).toBe('running'); expect(f.view(d.workId).status).toBe('queued')
    f.instances[0].context.consumed('create-a'); f.instances[0].context.settled(false); await tick()
    expect(f.view(a.workId).status).toBe('waiting')
    expect(f.instances[0].stopped).toBe(true)
    expect(f.view(b.workId).status).toBe('running')
    expect(f.service.view().active).toBe(2)
  })
  it('deduplicates mutations and consumed receipts, rejects stale targets and foreign owners', async () => {
    const f = fixture(), a = f.create('a'); await tick()
    expect(f.service.dispatch(a.command, 'create-a').work?.identity.workId).toBe(a.workId)
    const before = f.view(a.workId), update: ContinuousWorkCommand = { type: 'work.supplement', target: target(before), text: 'changed', decisionId: 'new-decision' }
    expect(f.service.dispatch(update, 'update-a').error).toBeUndefined(); await tick()
    expect(f.instances[0].revisions).toEqual([2]); expect(f.instances[0].events).toEqual(['create-a', 'update-a'])
    expect(f.service.dispatch(update, 'update-a').error).toBeUndefined(); await tick(); expect(f.instances[0].events).toHaveLength(2)
    expect(f.service.dispatch(update, 'different-operation').error).toBe('invalid-command')
    f.instances[0].context.consumed('update-a'); expect(f.service.get(a.workId)?.consumedThrough).toBe(0)
    f.instances[0].context.consumed('create-a'); const revision = f.view(a.workId).revision
    f.instances[0].context.consumed('create-a'); expect(f.view(a.workId).revision).toBe(revision)
    expect(f.service.get(a.workId)?.consumedThrough).toBe(2)
    const foreign = target(f.view(a.workId)); foreign.identity.owner.userId = 'somebody-else'
    expect(f.service.dispatch({ type: 'work.stop', target: foreign }, 'foreign-stop').error).toBe('invalid-command')
  })
  it('cancels one root immediately and resumes a new generation without old receipts', async () => {
    const f = fixture(), a = f.create('a'), b = f.create('b', 'project-b'); await tick()
    f.service.dispatch({ type: 'work.stop', target: target(f.view(a.workId)) }, 'stop-a')
    expect(f.instances[0].stopped).toBe(true); expect(f.instances[1].stopped).toBe(false)
    await tick(); expect(f.view(a.workId).status).toBe('stopped'); expect(f.view(b.workId).status).toBe('running')
    f.clock.advanceBy(86_400_000)
    expect(f.service.dispatch({ type: 'work.resume', target: target(f.view(a.workId)) }, 'resume-a').error).toBeUndefined(); await tick()
    const work = f.service.get(a.workId)!
    expect(work.identity.generation).toBe(2); expect(work.inputs[0].state).toBe('unknown'); expect(f.instances[2].events).toEqual(['resume-a'])
    f.instances[0].context.consumed('create-a'); expect(f.service.get(a.workId)?.inputs[0].state).toBe('unknown')
  })
  it('recovers nonempty state without launching or replaying pending events', async () => {
    const first = fixture(), a = first.create('a'); await tick(); await first.service.close()
    const second = fixture(first.root); await tick()
    expect(second.view(a.workId).status).toBe('review_required'); expect(second.instances).toHaveLength(0)
    expect(second.service.get(a.workId)?.inputs[0].state).toBe('unknown')
    expect(second.service.dispatch(a.command, 'create-a').work?.identity.workId).toBe(a.workId)
    second.service.dispatch({ type: 'work.resume', target: target(second.view(a.workId)) }, 'resume'); await tick()
    expect(second.instances).toHaveLength(1); expect(second.instances[0].events).toEqual(['resume'])
  })
  it('pauses active roots when lights/restore hold work, then waits for explicit resume', async () => {
    const f = fixture(), a = f.create('a'); await tick(); f.hold(); await tick()
    expect(f.view(a.workId).status).toBe('paused'); expect(f.instances[0].stopped).toBe(true)
  })
  it('does not strand an accepted but unconsumed event after a failed turn', async () => {
    const f = fixture(), a = f.create('a'); await tick()
    f.instances[0].context.settled(true); await tick()
    expect(f.view(a.workId).status).toBe('review_required')
    expect(f.service.get(a.workId)?.inputs[0].state).toBe('unknown')
    expect(f.service.busy()).toBe(false)
  })
  it('preserves a torn final frame and rejects changed ownership or committed bytes', () => {
    const f = fixture(), file = join(f.root, 'events.log'); f.create('a')
    const original = readFileSync(file, 'utf8'); writeFileSync(file, original + '\x1e{"row":')
    const reopened = openWorkJournal(file, owner, f.clock); expect(reopened.rows()).toHaveLength(2)
    expect(readFileSync(file, 'utf8')).toContain('\x1e{"row":')
    expect(() => openWorkJournal(file, { ...owner, userId: 'other' }, f.clock)).toThrow()
    writeFileSync(file, original.replace('Objective a', 'Objective b'))
    expect(() => openWorkJournal(file, owner, f.clock)).toThrow('WORK_JOURNAL_CORRUPT')
  })
})
