import { mkdtempSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { expect, it, vi } from 'vitest'
import { createManualClock } from '../../src/main/clock'
import { createContinuousWork } from '../../src/main/work/service'
import { inspectWorkArchive, restoreWorkArchive } from '../../src/main/work/archive'

it('restores a work into a new owner generation without replay and continues only after a new resume command', async () => {
  const root = mkdtempSync(join(resolve('test-results'), 'work-archive-')); const clock = createManualClock(1790000000000)
  const owner = { userId: 'u', characterId: 'c', dataRootId: 'original-root' }; const receiving = { ...owner, dataRootId: 'receiving-root' }
  const createRuntime = vi.fn<Parameters<typeof createContinuousWork>[0]['createRuntime']>(() => ({ deliver: async () => {}, invalidateWork: () => {}, close: async () => {}, busy: () => false, stateChanged: () => {}, untrust: () => {}, efforts: () => {} }))
  const common = { clock, available: () => true, held: () => false, project: (id: string) => ({ id, path: root }), decision: (id: string) => ({ id, text: 'Original user requirement', atMs: clock.nowMs() }), safeText: (text: string) => text, changed: () => {}, createRuntime }
  const original = createContinuousWork({ ...common, root: join(root, 'original'), owner })
  const started = original.dispatch({ type: 'work.create', projectId: 'project', objective: 'Persistent objective', acceptance: ['An actual artifact'], decisionIds: ['decision'] }, 'create')
  const bytes = readFileSync(join(root, 'original/events.log')); await original.close()
  expect(createRuntime).not.toHaveBeenCalled()
  expect(inspectWorkArchive(bytes, owner).works).toHaveLength(1)
  expect(() => inspectWorkArchive(bytes, { ...owner, characterId: 'other' })).toThrow('SCOPE_MISMATCH')
  const target = join(root, 'restored')
  restoreWorkArchive({ path: join(target, 'events.log'), bytes, from: owner, owner: receiving, clock, restoreId: randomUUID() })
  const service = createContinuousWork({ ...common, root: target, owner: receiving })
  try {
    service.stateChanged(); await Promise.resolve()
    const work = service.get(started.work!.identity.workId)!
    expect(work.identity.owner).toEqual(receiving); expect(work.identity.generation).toBe(2)
    expect(work.status).toBe('review_required'); expect(work.inputs[0].state).toBe('unknown')
    expect(work.decisions).toEqual(inspectWorkArchive(bytes, owner).works[0].decisions)
    expect(createRuntime).not.toHaveBeenCalled()
    const duplicate = service.dispatch({ type: 'work.create', projectId: 'project', objective: 'Persistent objective', acceptance: ['An actual artifact'], decisionIds: ['decision'] }, 'create')
    expect(duplicate.work?.identity.workId).toBe(started.work!.identity.workId)
    expect(service.view().items).toHaveLength(1); expect(createRuntime).not.toHaveBeenCalled()
    const result = service.dispatch({ type: 'work.resume', target: { identity: work.identity, expectedRevision: work.revision } }, 'new-resume')
    expect(result.error).toBeUndefined(); await Promise.resolve()
    expect(createRuntime).toHaveBeenCalledTimes(1)
    expect(createRuntime.mock.calls[0][0].work.identity.generation).toBe(3)
    const inputs = service.get(work.identity.workId)!.inputs
    expect(inputs[0].state).toBe('unknown'); expect(inputs.at(-1)?.eventId).toBe('new-resume')
    expect(readFileSync(join(root, 'original/events.log'))).toEqual(bytes)
  } finally { await service.close() }
})
