import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import type { AppCommand } from '../../src/shared'
import { createManualClock } from '../../src/main/clock'
import { createHarness } from '../../src/main/harness/loop'
import { createDesk } from '../../src/main/heart-flow/desk'
import { createHeartFlow, deskTools } from '../../src/main/heart-flow/service'
import { openJournal } from '../../src/main/journal/file'
import { projectJournal } from '../../src/main/journal/projection'
import type { ModelReply, ModelRequest } from '../../src/main/model/types'
import type { SessionStore } from '../../src/main/store/session'

const cleanups: (() => void | Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
const reply = (tool?: string, args?: unknown): ModelReply => ({ text: tool ? '' : 'MODEL_CLAIM_DONE', usage: { inputTokens: 0, outputTokens: 0 }, toolCalls: tool ? [{ id: randomUUID(), name: tool, arguments: JSON.stringify(args) }] : [] })
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'lca-drafts-'))
  cleanups.push(() => { if (!resolve(root).startsWith(join(resolve(tmpdir()), 'lca-drafts-'))) throw new Error('UNSAFE'); rmSync(root, { recursive: true, force: true }) })
  const clock = createManualClock(1000); const journal = openJournal(root, { userId: 'u', characterId: 'c' }, clock)
  const store: SessionStore = { scope: journal.scope, records: journal.records, append: journal.append, projection: () => projectJournal(journal.records()), close: journal.close }
  cleanups.push(store.close)
  const desk = createDesk(join(root, 'desk')); const preview = vi.fn()
  let respond: (request: ModelRequest) => Promise<ModelReply> = async () => reply()
  const requests: ModelRequest[] = []
  const options = { store, desk, clock, booth: false, busy: () => harness?.isBusy() ?? false, changed: () => {}, prepare: async () => ({ messages: [{ role: 'system' as const, content: 'SYSTEM' }], eligibleIndexes: [] }), emit: vi.fn(), run: vi.fn(async () => 'never'),
    modelSource: () => 'fake' as const, previewDraft: preview, cancelTask: (id: string) => { harness?.stop(id) }, requestDraft: (text: string, id: string, hash: string) => { harness!.send(text, id, hash); return store.projection().task!.id } }
  const flow = createHeartFlow(options)
  const harness = createHarness({ store, clock, tools: deskTools(flow), prepareContext: flow.prepareContext, settled: flow.settled, model: { source: 'fake', complete: async (request) => { requests.push(request); return respond(request) } } })
  cleanups.push(flow.close); cleanups.push(harness.dispose)
  const dispatch = (type: AppCommand['type'], extra: object = {}, requestId = randomUUID()) => flow.dispatch({ protocolVersion: 1, epoch: 'e', requestId, type, ...extra } as AppCommand)
  dispatch('flow.enter'); await vi.waitFor(() => expect(flow.active()).toBe(true))
  const execute = () => dispatch('flow.mode', { mode: 'execute' })
  const script = (...steps: ModelReply[]) => { let index = 0; respond = async () => steps[index++] ?? reply() }
  const start = (type: 'init' | 'review') => { const id = randomUUID(); return { id, path: `工作草稿/${id}.md`, send: () => dispatch(type === 'init' ? 'flow.init' : 'flow.review', {}, id) } }
  return { store, desk, clock, flow, options, dispatch, execute, script, start, harness, preview, requests, respond: (fn: typeof respond) => { respond = fn } }
}
it('requires execute, reads only the selected desk scope and marks ready only with actual read and artifact evidence', async () => {
  const f = await fixture(); f.desk.write('source.md', 'DESK_SOURCE_CANARY')
  expect(f.dispatch('flow.init')).toBe('permission-denied'); f.execute(); const op = f.start('init')
  f.script(reply('desk_read', { path: 'source.md' }), reply('desk_write', { path: op.path, text: 'UNREVIEWED_ACTUAL_DRAFT' }), reply())
  expect(op.send()).toBeUndefined(); await f.harness.idle()
  expect(f.flow.view().operations).toMatchObject([{ id: op.id, status: 'ready', sourceCount: 1, artifact: { byteLength: 23 } }])
  expect(f.desk.read(op.path)).toBe('UNREVIEWED_ACTUAL_DRAFT'); expect(f.dispatch('flow.operation.open', { operationId: op.id })).toBeUndefined()
  expect(f.preview.mock.calls[0][1]).toBe('UNREVIEWED_ACTUAL_DRAFT')
  expect(JSON.stringify(f.flow.view())).not.toContain('DESK_SOURCE_CANARY'); expect(JSON.stringify(f.flow.view())).not.toContain('UNREVIEWED_ACTUAL_DRAFT')
  const seen = f.store.records().filter((row) => row.type === 'model/seen'); expect(seen).toHaveLength(3); for (const row of seen) expect(row.eligibleIndexes).toEqual([])
  const restarted = createHeartFlow(f.options); expect(restarted.view().operations?.[0].status).toBe('ready'); restarted.close()
  f.desk.write(op.path, 'EXTERNAL_EDIT'); const corrupt = createHeartFlow(f.options); expect(corrupt.view().operations?.[0]).toMatchObject({ status: 'failed', error: 'source-changed' }); expect(corrupt.dispatch({ type: 'flow.operation.open', operationId: op.id } as AppCommand)).toBe('unavailable'); corrupt.close()
})
it('does not treat model claims, unread input, changed input, or pre-existing output as a completed project draft', async () => {
  const f = await fixture(); f.execute(); f.desk.write('source.md', 'INPUT')
  let op = f.start('init'); f.script(reply()); op.send(); await f.harness.idle(); expect(f.flow.view().operations?.at(-1)).toMatchObject({ status: 'failed' }); expect(f.desk.read(op.path)).toBeNull()
  op = f.start('init'); f.script(reply('desk_write', { path: op.path, text: 'UNREAD_INPUT_DRAFT' }), reply()); op.send(); await f.harness.idle(); expect(f.flow.view().operations?.at(-1)).toMatchObject({ status: 'failed', error: 'source-changed', artifact: {} })
  op = f.start('init'); let step = 0; f.respond(async () => { if (step++ === 0) return reply('desk_read', { path: 'source.md' }); f.desk.write('source.md', 'INTERVENING_INPUT'); return step === 2 ? reply('desk_write', { path: op.path, text: 'STALE_DRAFT' }) : reply() })
  op.send(); await f.harness.idle(); expect(f.flow.view().operations?.at(-1)).toMatchObject({ status: 'failed', error: 'source-changed' })
  op = f.start('init'); f.desk.write(op.path, 'KEEP_PREEXISTING'); expect(op.send()).toBe('unavailable'); expect(f.desk.read(op.path)).toBe('KEEP_PREEXISTING')
})
it('bounds source coverage and forbids other writes, scripts and reading omitted sources during a draft', async () => {
  const f = await fixture(); f.execute()
  for (let i = 0; i < 9; i++) f.desk.write(`source-${i}.md`, '字'.repeat(1000))
  const op = f.start('init'); let release!: (value: ModelReply) => void
  f.respond(() => new Promise((done) => { release = done })); op.send(); await vi.waitFor(() => expect(release).toBeTypeOf('function'))
  expect(f.flow.view().operations?.[0]).toMatchObject({ sourceCount: 8, omittedSourceCount: 1 })
  expect(() => f.flow.read('source-8.md')).toThrow(); expect(() => f.flow.write('source-0.md', 'WRONG')).toThrow()
  expect(f.dispatch('flow.run', { code: 'return 42' })).toBe('unavailable'); expect(f.flow.list()).toHaveLength(8)
  f.desk.write(op.path, 'INTERVENING_TARGET'); expect(() => f.flow.write(op.path, 'WRONG')).toThrow(); expect(f.desk.read(op.path)).toBe('INTERVENING_TARGET')
  release(reply()); await f.harness.idle(); expect(f.flow.view().operations?.[0].status).toBe('failed')
})
it('reviews only applied current-flow diffs, including deletion, without editing the source or declaring review passed', async () => {
  const f = await fixture(); f.execute(); expect(f.dispatch('flow.review')).toBe('unavailable')
  f.desk.write('deleted.md', 'DELETED_SOURCE'); f.flow.write('deleted.md', null); f.flow.write('new.md', 'ACTUAL_CHANGE')
  const op = f.start('review'); f.script(reply('desk_write', { path: op.path, text: 'Possible issue in new.md. Tests were not run.' }), reply()); op.send(); await f.harness.idle()
  expect(f.flow.view().operations?.[0]).toMatchObject({ kind: 'review', status: 'ready', sourceCount: 2 })
  expect(JSON.stringify(f.requests[0].messages)).toContain('DELETED_SOURCE'); expect(JSON.stringify(f.requests[0].messages)).toContain('ACTUAL_CHANGE')
  expect(f.desk.read('deleted.md')).toBeNull(); expect(f.desk.read('new.md')).toBe('ACTUAL_CHANGE'); expect(f.options.run).not.toHaveBeenCalled()
})
it.each(['manual', 'auto'] as const)('reviews the first before through the final after of repeated edits after %s compaction (#25)', async (compact) => {
  const f = await fixture(); f.execute(); const initial = 'if (!user.allowed) throw new Error("deny");\nreturn transfer();'
  f.desk.write('transfer.js', initial); f.flow.write('transfer.js', 'return transfer();'); f.flow.write('transfer.js', '// explanatory comment\nreturn transfer();')
  if (compact === 'manual') f.dispatch('flow.compact')
  else for (let i = 0; i < 5; i++) { const id = 'old-' + i; f.store.append({ type: 'user/message', id, text: 'OLD_WORK'.repeat(2500), requestId: id, commandHash: id }); f.store.append({ type: 'inbox/drain', ids: [id] }) }
  const op = f.start('review'); f.script(reply('desk_write', { path: op.path, text: 'Check the removed permission guard in transfer.js. Draft, tests not run.' }), reply()); op.send(); await f.harness.idle()
  expect(f.flow.view().operations?.[0]).toMatchObject({ status: 'ready', sourceCount: 1, omittedSourceCount: 0 })
  for (const request of f.requests) {
    const task = request.messages.flatMap((message) => { try { const data = JSON.parse(message.content); return data.userRequestedFlowDraft ? [data.userRequestedFlowDraft] : [] } catch { return [] } })[0]
    expect(task.reviewBasis).toBe('flow-initial-before-to-current-after'); expect(task.reviewDiffs).toEqual([{ path: 'transfer.js', diff: { before: initial, after: '// explanatory comment\nreturn transfer();', steps: 2, externalEditsObserved: false } }])
  }
  expect(f.store.records().some((row) => row.type === 'flow/compact')).toBe(true)
})
it('aggregates delete/recreate/undo, excludes fully reverted paths and flags discontinuous external edits (#25)', async () => {
  const f = await fixture(); f.execute(); f.desk.write('deleted.md', 'ORIGINAL_BEFORE_DELETE'); const deletion = f.flow.write('deleted.md', null); const recreate = f.flow.write('deleted.md', 'RECREATED')
  expect(f.dispatch('flow.undo', { changeId: recreate })).toBeUndefined(); expect(f.dispatch('flow.undo', { changeId: deletion })).toBeUndefined(); expect(f.dispatch('flow.review')).toBe('unavailable')
  f.flow.write('deleted.md', null); f.flow.write('deleted.md', 'NEW_CURRENT'); f.desk.write('external.md', 'START'); f.flow.write('external.md', 'FIRST'); f.desk.write('external.md', 'USER_EDIT'); f.flow.write('external.md', 'FINAL')
  const op = f.start('review'); f.script(reply('desk_write', { path: op.path, text: 'Bounded net-diff draft' }), reply()); op.send(); await f.harness.idle(); expect(f.flow.view().operations?.[0].status).toBe('ready')
  const task = f.requests[0].messages.flatMap((message) => { try { return JSON.parse(message.content).userRequestedFlowDraft ?? [] } catch { return [] } })[0]
  expect(task.reviewDiffs).toEqual([{ path: 'deleted.md', diff: { before: 'ORIGINAL_BEFORE_DELETE', after: 'NEW_CURRENT', steps: 6, externalEditsObserved: false } }, { path: 'external.md', diff: { before: 'START', after: 'FINAL', steps: 2, externalEditsObserved: true } }])
})
it.each(['interrupt', 'lights', 'goal', 'stop'] as const)('cancels %s without executing a late tool result and never resumes a draft after restart', async (action) => {
  const f = await fixture(); f.execute(); const op = f.start('init'); let release!: (value: ModelReply) => void
  f.respond(() => new Promise((done) => { release = done })); op.send(); await vi.waitFor(() => expect(release).toBeTypeOf('function'))
  if (action === 'interrupt') f.flow.interruptDraft()
  if (action === 'stop') f.flow.stopChildren()
  if (action === 'goal') f.dispatch('flow.goal.set', { text: 'NEW_GOAL' })
  if (action === 'lights') { f.store.append({ type: 'companion/lights', lightsOut: true, requestId: 'lights', commandHash: 'lights' }); f.flow.stateChanged() }
  release(reply('desk_write', { path: op.path, text: 'LATE_PRODUCT' })); await f.harness.idle()
  expect(f.flow.view().operations?.[0]).toMatchObject({ status: 'cancelled', error: 'cancelled' }); expect(f.desk.read(op.path)).toBeNull()
  const restarted = createHeartFlow(f.options); expect(restarted.view().operations?.[0].status).toBe('cancelled'); restarted.close()
})
it('recovers an interrupted job conservatively without issuing a new model request', async () => {
  const f = await fixture(); f.execute(); const op = f.start('init'); let release!: (value: ModelReply) => void
  f.respond(() => new Promise((done) => { release = done })); op.send(); await vi.waitFor(() => expect(release).toBeTypeOf('function'))
  const restarted = createHeartFlow(f.options); expect(restarted.view().operations?.[0]).toMatchObject({ status: 'failed', error: 'interrupted' }); expect(f.requests).toHaveLength(1)
  restarted.close(); f.harness.stop(f.store.projection().task!.id); release(reply()); await f.harness.idle(); expect(f.desk.read(op.path)).toBeNull()
})
