import { mkdtempSync, rmSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import { createManualClock } from '../../src/main/clock'
import { openJournal } from '../../src/main/journal/file'
import { projectJournal } from '../../src/main/journal/projection'
import { createScheduler } from '../../src/main/scheduler'
import { createDesk } from '../../src/main/legacy-flow/desk'
import { createLifeWork } from '../../src/main/life/work/service'
import { createLife } from '../../src/main/life/service'
import { createAppController } from '../../src/main/bridge/controller'
import { createFakeLifeWorkModel } from '../../src/main/life/work/fake'
import { workHash, workPath, workRecords } from '../../src/main/life/work/records'
import type { LifeWorkModel } from '../../src/main/life/work/schema'
import type { AppCommand } from '../../src/shared'
import type { SessionStore } from '../../src/main/store/session'
const cleanups: (() => void | Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
function setup(model: LifeWorkModel | null = createFakeLifeWorkModel()) {
  const root = mkdtempSync(join(tmpdir(), 'lca-work-')); cleanups.push(() => { if (!resolve(root).startsWith(join(resolve(tmpdir()), 'lca-work-'))) throw new Error('UNSAFE'); rmSync(root, { recursive: true, force: true }) })
  const clock = createManualClock(1792202400000); const journal = openJournal(root, { userId: 'u', characterId: 'c' }, clock)
  const store: SessionStore = { scope: journal.scope, records: journal.records, append: journal.append, projection: () => projectJournal(journal.records()), close: journal.close }
  const desk = createDesk(join(root, '书桌')); const scheduler = createScheduler(clock); let available = true; const previews: string[] = []
  const options = { store, desk, clock, scheduler, model, developer: true, available: () => available, changed: () => {}, projected: () => {}, open: (_path: string, text: string) => { previews.push(text) } }
  const work = createLifeWork(options); const send = (body: object) => work.dispatch(body as AppCommand)
  cleanups.push(() => { scheduler.dispose(); store.close() }); cleanups.push(work.close)
  expect(send({ type: 'developer.life.seed' })).toBeUndefined()
  return { root, work, store, desk, clock, scheduler, options, send, previews, available: (value: boolean) => { available = value } }
}
it('refuses mixing fake checkpoints with a real producer and preserves the old product', async () => {
  const f = setup(); f.send({ type: 'life.work.start', kind: 'read' }); await f.work.idle()
  const before = f.work.view().jobs[0]; const content = f.desk.read(before.output!.path); await f.work.close()
  const produce = vi.fn(async () => ({ markdown: 'NEW_REAL_TRANSPORT_PRODUCT' }))
  const next = createLifeWork({ ...f.options, model: { source: 'real', produce } }); cleanups.push(next.close)
  expect(next.dispatch({ type: 'life.work.resume', workId: before.id } as AppCommand)).toBe('unavailable')
  await next.tick(); expect(produce).not.toHaveBeenCalled(); expect(f.desk.read(before.output!.path)).toBe(content)
  expect(next.view().jobs[0]).toMatchObject({ source: 'fake', completedSteps: 1, status: 'failed', reason: 'model' })
  f.scheduler.cancel('life.work'); f.clock.advanceBy(86400000)
  expect(next.dispatch({ type: 'life.work.start', kind: 'read' } as AppCommand)).toBeUndefined(); await next.idle()
  expect(produce).toHaveBeenCalledOnce(); expect(next.view().jobs.at(-1)).toMatchObject({ source: 'real', completedSteps: 1 })
})
it('reports shared reservation exhaustion as budget and never commits a product', async () => {
  const f = setup({ source: 'fake', produce: async () => { throw Object.assign(new Error('LOCAL_BUDGET'), { code: 'budget-exceeded' }) } })
  f.send({ type: 'life.work.start', kind: 'read' }); await f.work.idle()
  expect(f.work.view().jobs[0]).toMatchObject({ status: 'failed', reason: 'budget', completedSteps: 0 })
  expect(f.work.view().jobs[0].output).toBeUndefined()
})
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
it('settles an agenda only after the producer has three actual products and keeps book-only strict commands', async () => {
  const f = setup(); const life = createLife({ ...f.options, working: () => false, emit: () => {}, work: f.work })
  const controller = createAppController(f.clock, undefined, f.store); controller.attachLifeWork(f.work); controller.attachLife(life)
  const command = { protocolVersion: 1, requestId: randomUUID(), epoch: controller.getSnapshot().epoch, type: 'life.work.start', kind: 'read' }
  expect(controller.dispatch(command, 'mini').status).toBe('rejected'); expect(controller.dispatch({ ...command, path: 'user.md' }).status).toBe('rejected')
  f.work.ensure('read'); await f.work.tick(); life.reconcile(); expect(life.view().agenda.find((item) => item.kind === 'read')?.state).not.toBe('settled')
  await f.work.tick(); await f.work.tick(); life.reconcile(); expect(life.view().agenda.find((item) => item.kind === 'read')?.state).toBe('settled')
  controller.dispose()
})
/** Commit all three steps of one job, then edit the third product so the next rebuild sees a conflict. */
async function completedThenConflict(f: ReturnType<typeof setup>) {
  const job = f.work.ensure('write')!
  for (let step = 1; step <= 3; step++) await f.work.tick()
  expect(f.work.view().jobs.find((entry) => entry.id === job.id)!.status).toBe('completed')
  const output = f.work.view().jobs.find((entry) => entry.id === job.id)!.output!
  writeFileSync(join(f.root, '书桌', output.path), 'USER_EDITED_OUTSIDE_THE_APP')
  return job
}
it('never queues a fourth step when a completed work conflicts, and does not strand a running state (issue #16)', async () => {
  const f = setup(); const job = await completedThenConflict(f)
  const before = f.store.records().filter((row) => row.type === 'life/work-attempt').length
  // 恢复原文之后重启：这一项其实已经完成，启动对账就应当把它结算掉，而不是留下永久 conflict。
  const committed = workRecords(f.store.records()).committed.get(job.id)!.at(-1)!
  f.desk.write(committed.path, committed.text)
  const restarted = createLifeWork(f.options)
  expect(restarted.view().jobs.find((entry) => entry.id === job.id)!.status).toBe('completed')
  const settled = f.work.view().jobs.find((entry) => entry.id === job.id)!
  expect(settled.completedSteps).toBe(3)
  // 旧实现：续做会写 step=4 的 attempt，被 journal 拒绝后留下一个没有 worker 的 running 状态。
  // 现在这一项已被结算为完成，续做请求会被正常拒绝，而不是排进一个不存在的第 4 步。
  expect(f.send({ type: 'life.work.resume', workId: job.id })).toBe('unavailable')
  await f.work.idle(); await f.work.tick()
  const after = f.work.view().jobs.find((entry) => entry.id === job.id)!
  expect(after.status).toBe('completed'); expect(after.completedSteps).toBe(3)
  expect(f.store.records().filter((row) => row.type === 'life/work-attempt' && row.step > 3)).toHaveLength(0)
  expect(f.store.records().filter((row) => row.type === 'life/work-attempt').length).toBe(before)
  expect(f.work.active()).toBe(false)
})
it('survives an oversized or unreadable checkpoint instead of failing app startup (issue #17)', async () => {
  const f = setup(); const job = f.work.ensure('write')!
  for (let step = 1; step <= 3; step++) await f.work.tick()
  const output = f.work.view().jobs.find((entry) => entry.id === job.id)!.output!
  const file = join(f.root, '书桌', output.path)
  writeFileSync(file, 'x'.repeat(64_001))
  // 构造服务不再抛出：否则 index.ts 的 catch 会直接 app.exit(1)，用户再也打不开应用。
  let restarted!: ReturnType<typeof createLifeWork> | undefined
  expect(() => { restarted = createLifeWork(f.options) }).not.toThrow()
  const conflicted = restarted!.view().jobs.find((entry) => entry.id === job.id)!
  expect(conflicted.reason).toBe('conflict')
  expect(readFileSync(file, 'utf8')).toHaveLength(64_001)
  // 路径被换成目录同样只影响这一项。
  unlinkSync(file); mkdirSync(file)
  expect(() => createLifeWork(f.options)).not.toThrow()
})
it.each(['oversized', 'nul', 'directory'] as const)('isolates a %s pending draft without committing, overwriting or blocking another job (reopened #16)', async (kind) => {
    const f = setup(); const job = f.work.ensure('read')!; const other = f.work.ensure('write')!
    const text = '# Interrupted synthetic draft'; const path = workPath(job.id, 1)
    f.store.append({ type: 'life/work-draft', draft: { id: randomUUID(), workId: job.id, step: 1, path, text, sha256: workHash(text) } })
    f.desk.write(path, text); const absolute = join(f.root, '书桌', path)
    if (kind === 'directory') { unlinkSync(absolute); mkdirSync(absolute) } else writeFileSync(absolute, kind === 'oversized' ? 'x'.repeat(64001) : 'before\0after')
    let restarted!: ReturnType<typeof createLifeWork>
    expect(() => { restarted = createLifeWork(f.options) }).not.toThrow(); cleanups.push(restarted.close)
    expect(restarted.view().jobs.find((entry) => entry.id === job.id)).toMatchObject({ status: 'failed', reason: 'conflict', completedSteps: 0 })
    expect(workRecords(f.store.records()).committed.get(job.id)).toBeUndefined()
    if (kind !== 'directory') expect(readFileSync(absolute)).toEqual(Buffer.from(kind === 'oversized' ? 'x'.repeat(64001) : 'before\0after'))
    expect(restarted.dispatch({ type: 'life.work.resume', workId: other.id } as AppCommand)).toBeUndefined(); await restarted.idle()
    expect(restarted.view().jobs.find((entry) => entry.id === other.id)?.completedSteps).toBe(1)
})
it('keeps 3/3 conflicts until actual material and checkpoints match, including without a producer (reopened #17)', async () => {
  const f = setup(); const job = await completedThenConflict(f); const attempts = f.store.records().filter((row) => row.type === 'life/work-attempt').length
  const next = createLifeWork({ ...f.options, model: null }); cleanups.push(next.close)
  expect(next.view().jobs.find((entry) => entry.id === job.id)).toMatchObject({ status: 'failed', reason: 'conflict', completedSteps: 3 })
  expect(next.dispatch({ type: 'life.work.resume', workId: job.id } as AppCommand)).toBe('unavailable')
  expect(next.completed('write', job.dayKey)).toBe(false); expect(next.view().jobs.find((entry) => entry.id === job.id)?.reason).toBe('conflict'); expect(next.active()).toBe(false)
  const draft = workRecords(f.store.records()).committed.get(job.id)!.at(-1)!
  expect(f.desk.read(draft.path)).toBe('USER_EDITED_OUTSIDE_THE_APP')
  f.desk.write(draft.path, draft.text); expect(next.dispatch({ type: 'life.work.resume', workId: job.id } as AppCommand)).toBeUndefined()
  expect(next.completed('write', job.dayKey)).toBe(true); expect(f.store.records().filter((row) => row.type === 'life/work-attempt')).toHaveLength(attempts)
}, 20_000)
