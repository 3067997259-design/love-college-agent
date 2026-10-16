import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { createManualClock } from '../../src/main/clock'
import { openJournal } from '../../src/main/journal/file'
import { projectJournal } from '../../src/main/journal/projection'
import { createDelegates } from '../../src/main/delegates/service'
import { createFakeDelegateModel } from '../../src/main/delegates/fake'
import type { DelegateModel } from '../../src/main/delegates/schema'
import type { SessionStore } from '../../src/main/store/session'
const cleanups: (() => void | Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
function fixture(model: DelegateModel | null = createFakeDelegateModel()) {
  const root = mkdtempSync(join(tmpdir(), 'lca-delegates-')); cleanups.push(() => { if (!resolve(root).startsWith(join(resolve(tmpdir()), 'lca-delegates-'))) throw new Error('UNSAFE'); rmSync(root, { recursive: true, force: true }) })
  const clock = createManualClock(1000); const journal = openJournal(root, { userId: 'u', characterId: 'c' }, clock)
  const store: SessionStore = { scope: journal.scope, records: journal.records, append: journal.append, projection: () => projectJournal(journal.records()), close: journal.close }
  const files = new Map([['a.md', 'EXPLICIT_SOURCE_ONLY'], ['b.md', 'SECOND_SOURCE']]); let flowId: string | null = 'flow'
  const options = { store, clock, model, flowId: () => flowId, read: (path: string) => files.get(path) ?? null, changed: () => {} }
  const delegates = createDelegates(options); cleanups.push(store.close); cleanups.push(delegates.close)
  return { delegates, options, clock, store, files, flow: (id: string | null) => { flowId = id } }
}
it('creates fresh read-only inputs, returns referenced unreviewed conclusions only to the parent, and detects changed sources', async () => {
  const f = fixture(); f.store.append({ type: 'user/message', id: 'private', text: 'UNRELATED_PRIVATE_CHAT', requestId: 'r', commandHash: 'h' })
  const id = f.delegates.start({ task: 'read', paths: ['a.md'] }, new AbortController().signal); await f.delegates.idle()
  expect(await f.delegates.result(id, true, new AbortController().signal)).toMatchObject({ conclusion: 'EXPLICIT_SOURCE_ONLY', trust: 'unreviewed', memoryAuthority: 'parent-only', refs: [{ path: 'a.md', current: true }] })
  expect(JSON.stringify(f.delegates.views())).not.toMatch(/EXPLICIT_SOURCE_ONLY|UNRELATED_PRIVATE_CHAT/)
  f.files.set('a.md', 'EDITED'); expect(await f.delegates.result(id, false, new AbortController().signal)).toMatchObject({ refs: [{ current: false }] })
  expect(f.delegates.tools.map((tool) => tool.definition.name)).toEqual(['delegate_readonly', 'delegate_result'])
  expect(f.store.records().some((row) => row.type === 'memory/batch' || row.type === 'model/seen')).toBe(false)
  f.flow('other'); await expect(f.delegates.result(id, true, new AbortController().signal)).rejects.toThrow()
})
it('limits concurrency to three and attempts to twelve; no recursive execution or writes', async () => {
  const f = fixture({ source: 'fake', read: () => new Promise(() => {}) }); const signal = new AbortController().signal
  for (let round = 0; round < 4; round++) {
    for (let i = 0; i < 3; i++) f.delegates.start({ task: 'bounded', paths: ['a.md'] }, signal)
    expect(() => f.delegates.start({ task: 'fourth', paths: ['a.md'] }, signal)).toThrow()
    f.delegates.cancelAll(); await f.delegates.idle()
  }
  expect(() => f.delegates.start({ task: 'thirteenth', paths: ['a.md'] }, signal)).toThrow('DELEGATE_BUDGET')
  expect(f.delegates.views().filter((view) => view.status === 'cancelled')).toHaveLength(12); expect(f.files.get('a.md')).toBe('EXPLICIT_SOURCE_ONLY')
})
it('ignores late cancelled output and fails closed on forged references or oversized/invalid sources', async () => {
  let finish!: (value: unknown) => void
  const f = fixture({ source: 'fake', read: () => new Promise((done) => { finish = done }) }); const signal = new AbortController()
  const id = f.delegates.start({ task: 'cancel', paths: ['a.md'] }, signal.signal); await Promise.resolve(); signal.abort(); await f.delegates.idle()
  finish({ conclusion: 'LATE', refs: [] }); await Promise.resolve(); expect(f.delegates.views()[0].status).toBe('cancelled')
  expect(f.store.records().some((row) => row.type === 'delegate/result')).toBe(false)
  const bad = createDelegates({ ...f.options, model: { source: 'fake', read: async () => ({ conclusion: 'forged', refs: [{ path: 'secret.md', sha256: 'a'.repeat(64) }] }) } }); cleanups.push(bad.close)
  bad.start({ task: 'bad', paths: ['a.md'] }, new AbortController().signal); await bad.idle(); expect(bad.views().at(-1)?.error).toBe('invalid-output')
  expect(() => bad.start({ task: 'invalid', paths: ['../secret'] }, new AbortController().signal)).toThrow()
  f.files.set('huge.md', 'x'.repeat(33000)); expect(() => bad.start({ task: 'too big', paths: ['huge.md'] }, new AbortController().signal)).toThrow('DELEGATE_SOURCE_TOO_LARGE')
  await expect(f.delegates.result(id, false, new AbortController().signal)).resolves.toMatchObject({ status: 'cancelled' })
})
it('times out through the unified clock, stops on lights, and never resumes saved requests', async () => {
  const f = fixture({ source: 'fake', read: () => new Promise(() => {}) }); f.delegates.start({ task: 'timeout', paths: ['a.md'] }, new AbortController().signal)
  await Promise.resolve(); f.clock.advanceBy(30000); await f.delegates.idle(); expect(f.delegates.views()[0]).toMatchObject({ status: 'cancelled', error: 'timeout' })
  const id = f.delegates.start({ task: 'restart', paths: ['b.md'] }, new AbortController().signal)
  const restarted = createDelegates(f.options); cleanups.push(restarted.close); expect(restarted.views().find((view) => view.id === id)).toMatchObject({ status: 'cancelled', error: 'interrupted' })
  f.store.append({ type: 'companion/lights', lightsOut: true, requestId: 'lights', commandHash: 'lights' }); f.delegates.cancelAll(); await f.delegates.idle()
  expect(() => restarted.start({ task: 'lights', paths: ['a.md'] }, new AbortController().signal)).toThrow('DELEGATE_UNAVAILABLE')
})
it('cancels the child when its parent stops waiting, without rewriting old journal events', async () => {
  const f = fixture({ source: 'fake', read: () => new Promise(() => {}) })
  const id = f.delegates.start({ task: 'wait', paths: ['a.md'] }, new AbortController().signal); await Promise.resolve()
  const wait = new AbortController(); const result = f.delegates.result(id, true, wait.signal); wait.abort(); await expect(result).rejects.toThrow(); await f.delegates.idle()
  expect(f.delegates.views()[0].status).toBe('cancelled')
  const started = f.store.records().find((row) => row.type === 'delegate/state'); expect(started).toMatchObject({ view: { status: 'running' } })
  const restarted = createDelegates(f.options); cleanups.push(restarted.close); expect(started).toMatchObject({ view: { status: 'running' } })
})
