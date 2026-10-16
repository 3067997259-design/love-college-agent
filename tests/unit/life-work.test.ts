import { mkdtempSync, rmSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, expect, it } from 'vitest'
import { createManualClock } from '../../src/main/clock'
import { openJournal } from '../../src/main/journal/file'
import { projectJournal } from '../../src/main/journal/projection'
import { createScheduler } from '../../src/main/scheduler'
import { createDesk } from '../../src/main/heart-flow/desk'
import { createLifeWork } from '../../src/main/life/work/service'
import { createFakeLifeWorkModel } from '../../src/main/life/work/fake'
import { workHash, workPath, workRecords } from '../../src/main/life/work/records'
import type { LifeWorkModel } from '../../src/main/life/work/schema'
import type { AppCommand } from '../../src/shared'
import type { SessionStore } from '../../src/main/store/session'
const cleanups: (() => void | Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
function setup(model: LifeWorkModel | null = createFakeLifeWorkModel()) {
  const root = mkdtempSync(join(tmpdir(), 'lca-work-')); cleanups.push(() => rmSync(root, { recursive: true, force: true }))
  const clock = createManualClock(1792202400000); const journal = openJournal(root, { userId: 'u', characterId: 'c' }, clock)
  const store: SessionStore = { scope: journal.scope, records: journal.records, append: journal.append, projection: () => projectJournal(journal.records()), close: journal.close }
  const desk = createDesk(join(root, '书桌')); const scheduler = createScheduler(clock); let available = true; const previews: string[] = []
  const options = { store, desk, clock, scheduler, model, developer: true, available: () => available, changed: () => {}, projected: () => {}, open: (_path: string, text: string) => { previews.push(text) } }
  const work = createLifeWork(options); const send = (body: object) => work.dispatch(body as AppCommand)
  cleanups.push(() => { scheduler.dispose(); store.close() }); cleanups.push(work.close)
  expect(send({ type: 'developer.life.seed' })).toBeUndefined()
  return { root, work, store, desk, clock, scheduler, options, send, previews, available: (value: boolean) => { available = value } }
}
it('writes reading notes and a revised manuscript as actual immutable desk checkpoints; no raw context or fake completion', async () => {
  const f = setup(); f.desk.write('用户秘密.md', 'PRIVATE_UNREGISTERED_CANARY'); const original = f.work.view().materials[0]
  for (const kind of ['read', 'write'] as const) {
    const job = f.work.ensure(kind)!
    for (let i = 1; i <= 3; i++) { await f.work.tick(); const now = f.work.view().jobs.find((j) => j.id === job.id)!; expect(now.completedSteps).toBe(i); expect(now.status).toBe(i === 3 ? 'completed' : 'queued'); expect(workHash(readFileSync(join(f.root, '书桌', now.output!.path), 'utf8'))).toBe(now.output!.sha256) }
    expect(f.send({ type: 'life.work.open', workId: job.id })).toBeUndefined()
    expect(f.work.ensure(kind)?.id).toBe(job.id)
  }
  expect(f.previews).toHaveLength(2); expect(f.previews[1]).toContain('修订稿'); expect(f.desk.read(original.path)).toContain('合成阅读材料')
  expect(JSON.stringify(f.work.view())).not.toMatch(/折痕与支撑|PRIVATE_UNREGISTERED_CANARY|修订稿/)
  expect(f.store.records().some((row) => row.type === 'model/seen' || row.type === 'inbox/event')).toBe(false)
  expect(f.work.view().attemptsToday).toBe(6); expect(workRecords(f.store.records()).committed.size).toBe(2)
})
it('rejects model claims/empty products, enforces daily attempt budget, and never reads other files', async () => {
  let calls = 0; const f = setup({ source: 'fake', produce: async (input) => { calls++; expect(JSON.stringify(input)).not.toContain('PRIVATE_CANARY'); return { completed: true, markdown: '' } } })
  f.desk.write('user.md', 'PRIVATE_CANARY'); const job = f.work.ensure('read')!
  for (let i = 0; i < 9; i++) { if (i) f.send({ type: 'life.work.resume', workId: job.id }); await f.work.tick() }
  expect(calls).toBe(8); expect(f.work.view().jobs[0]).toMatchObject({ completedSteps: 0, status: 'paused', reason: 'budget', completedAtMs: null })
  expect(f.store.records().some((row) => row.type === 'life/work-commit')).toBe(false)
})
it('does not commit or count a failed disk write, and preserves an external conflicting file', async () => {
  const f = setup(); const job = f.work.ensure('read')!; f.desk.write(workPath(job.id, 1), 'USER_EDIT')
  await f.work.tick(); expect(f.work.view().jobs[0]).toMatchObject({ status: 'failed', reason: 'conflict', completedSteps: 0 }); expect(f.desk.read(workPath(job.id, 1))).toBe('USER_EDIT')
  f.desk.write(workPath(job.id, 1), null)
  const failing = createLifeWork({ ...f.options, desk: { ...f.desk, write: () => { throw new Error('PRIVATE_ERROR_CANARY') } } }); cleanups.push(failing.close)
  failing.dispatch({ type: 'life.work.resume', workId: job.id } as AppCommand); await failing.idle()
  expect(failing.view().jobs[0].completedSteps).toBe(0); expect(JSON.stringify(failing.view())).not.toContain('PRIVATE_ERROR_CANARY')
})
it('yields to foreground/lights, ignores a late uncooperative model, and preserves user pause', async () => {
  let resolve!: (value: unknown) => void
  const f = setup({ source: 'fake', produce: () => new Promise((done) => { resolve = done }) }); const job = f.work.ensure('write')!
  const run = f.work.tick(); await Promise.resolve(); f.send({ type: 'life.work.pause', workId: job.id }); await run
  resolve({ markdown: 'LATE_PRIVATE_PRODUCT' }); await Promise.resolve()
  expect(f.work.view().jobs[0]).toMatchObject({ status: 'paused', reason: 'user', completedSteps: 0 }); await f.work.tick(); expect(f.work.view().attemptsToday).toBe(1)
  f.store.append({ type: 'companion/lights', lightsOut: true, requestId: 'lights', commandHash: 'lights' }); f.send({ type: 'life.work.resume', workId: job.id }); await f.work.tick(); expect(f.work.view().attemptsToday).toBe(1)
})
it('restarts at the exact saved step without offline work, rebuilds missing products, then explicitly resumes', async () => {
  const f = setup(); const job = f.work.ensure('read')!; await f.work.tick(); const saved = structuredClone(f.work.view().jobs[0]); await f.work.close(); f.scheduler.dispose()
  unlinkSync(join(f.root, '书桌', saved.output!.path)); f.clock.advanceBy(3 * 86400000)
  const scheduler = createScheduler(f.clock); const next = createLifeWork({ ...f.options, scheduler }); cleanups.push(() => scheduler.dispose()); cleanups.push(next.close)
  expect(next.view().jobs[0]).toMatchObject({ completedSteps: 1, status: 'interrupted', output: saved.output }); expect(next.view().attemptsToday).toBe(0)
  expect(f.desk.read(saved.output!.path)).toBeTruthy(); await next.tick(); expect(next.view().jobs[0].completedSteps).toBe(1)
  next.dispatch({ type: 'life.work.resume', workId: job.id } as AppCommand); await next.idle(); await next.tick(); expect(next.view().jobs[0]).toMatchObject({ completedSteps: 3, status: 'completed' })
  expect(() => workRecords(f.store.records())).not.toThrow()
})
it.each([false, true])('recovers a pending intent only if the actual matching file exists (%s)', async (written) => {
  const f = setup(); const job = f.work.ensure('write')!; await f.work.close(); f.scheduler.dispose()
  const text = '实际生成的合成草稿'; const path = workPath(job.id, 1); const id = randomUUID()
  f.store.append({ type: 'life/work-draft', draft: { id, workId: job.id, step: 1, path, text, sha256: workHash(text) } }); if (written) f.desk.write(path, text)
  const scheduler = createScheduler(f.clock); const next = createLifeWork({ ...f.options, scheduler }); cleanups.push(() => scheduler.dispose()); cleanups.push(next.close)
  expect(next.view().jobs[0].completedSteps).toBe(written ? 1 : 0); expect(next.view().jobs[0].status).toBe('interrupted')
})
it('rejects forged progress and source hashes before private restore, and refuses unknown work IDs', async () => {
  const f = setup(); const job = f.work.ensure('read')!
  expect(f.send({ type: 'life.work.open', workId: 'a'.repeat(64) })).toBe('unavailable')
  f.store.append({ type: 'life/work-state', job: { ...job, totalSteps: 3, status: 'completed', completedSteps: 3, completedAtMs: f.clock.nowMs() } })
  expect(() => workRecords(f.store.records())).toThrow('WORK_INVALID')
  writeFileSync(join(f.root, '书桌', '未登记.md'), 'UNREGISTERED')
})
