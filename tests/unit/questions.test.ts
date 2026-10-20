import { mkdtempSync, rmSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { createManualClock } from '../../src/main/clock'
import { openJournal } from '../../src/main/journal/file'
import { projectJournal } from '../../src/main/journal/projection'
import { createQuestions } from '../../src/main/questions/service'
import { answerInput, questionInput } from '../../src/main/questions/schema'
import { createHarness } from '../../src/main/harness/loop'
import { builtinTools } from '../../src/main/harness/tools'
import { createAppController } from '../../src/main/bridge/controller'
import { normalContextAllowedSeqs } from '../../src/main/legacy-flow/context'
import type { SessionStore } from '../../src/main/store/session'
import type { AppCommand } from '../../src/shared'
import type { ModelRequest } from '../../src/main/model/types'
import { createDesk } from '../../src/main/legacy-flow/desk'
import { createHeartFlow } from '../../src/main/heart-flow/service'

const cleanup: (() => void | Promise<void>)[] = []
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn() })
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'lca-questions-')); const clock = createManualClock(1000)
  const journal = openJournal(root, { userId: 'u', characterId: 'c' }, clock)
  const store: SessionStore = { scope: journal.scope, records: journal.records, append: journal.append, projection: () => projectJournal(journal.records()), close: journal.close }
  let flowId: string | null = null
  const options = { store, clock, flowId: () => flowId, changed: vi.fn(), safeText: (text: string) => text.replaceAll('SECRET_CANARY', '[redacted]') }
  const q = createQuestions(options); cleanup.push(() => { q.close(); journal.close(); if (!resolve(root).startsWith(join(resolve(tmpdir()), 'lca-questions-'))) throw new Error('UNSAFE'); rmSync(root, { recursive: true, force: true }) })
  const abort = new AbortController()
  const start = (turnId = 'turn') => { store.append({ type: 'turn/start', turnId, trigger: 'user' }); return turnId }
  const ask = (turnId = 'turn') => q.tool().run({ question: 'Which format?', choices: ['Markdown', 'Text'] }, { store, clock, signal: abort.signal, turnId, callId: randomUUID() })
  const command = (body: object) => ({ protocolVersion: 1, epoch: 'epoch', requestId: randomUUID(), ...body }) as AppCommand
  const answer = (text = 'Markdown') => q.dispatch(command({ type: 'question.answer', questionId: q.view()!.id, answer: text }), 'hash')
  return { root, store, clock, q, options, abort, start, ask, command, answer, flow: (id: string | null) => { flowId = id } }
}
it.each(['direct', 'slash', 'rejected'] as const)('invalidates questions only for accepted goal updates through %s', async (route) => {
  const f = fixture(); const controller = createAppController(f.clock, undefined, f.store)
  const flow = createHeartFlow({ store: f.store, clock: f.clock, desk: createDesk(join(f.root, 'desk')), booth: false, busy: () => false, changed: () => {},
    prepare: async () => ({ messages: [], eligibleIndexes: [] }), emit: () => {}, run: async () => '' })
  cleanup.push(() => { flow.close(); controller.dispose() }); controller.attachQuestions(f.q); controller.attachHeartFlow(flow)
  const dispatch = (body: object) => controller.dispatch({ ...f.command(body), epoch: controller.getSnapshot().epoch })
  dispatch({ type: 'flow.enter' }); await vi.waitFor(() => expect(flow.active()).toBe(true)); f.flow(flow.view().activeId!)
  f.start(); const pending = f.ask(); const id = f.q.view()!.id
  const ack = dispatch(route === 'slash' ? { type: 'message.send', text: '/goal new goal' } : { type: 'flow.goal.set', text: 'new goal', ...(route === 'rejected' ? { goalId: randomUUID() } : {}) })
  if (route === 'rejected') {
    expect(ack.status).toBe('rejected'); expect(f.q.view()?.id).toBe(id); expect(f.answer('still valid')).toBeUndefined(); await pending
  } else {
    expect(ack.status).toBe('accepted'); expect((await pending).visible).toMatchObject({ status: 'superseded' }); expect(f.q.view()).toBeUndefined()
    expect(dispatch({ type: 'question.answer', questionId: id, answer: 'OLD_GOAL_ANSWER' })).toMatchObject({ status: 'rejected' })
    expect(f.store.records().some((row) => row.type === 'user/message' && row.text === 'OLD_GOAL_ANSWER')).toBe(false)
  }
})
it('queues without exposing the prompt; only visible time consumes the deadline', async () => {
  const f = fixture(); f.start(); f.store.append({ type: 'companion/mode', mode: 'quiet', requestId: 'quiet', commandHash: 'q' })
  const pending = f.ask(); expect(f.q.view()).toMatchObject({ status: 'queued' }); expect(JSON.stringify(f.q.view())).not.toContain('Which format?')
  expect(f.store.projection().messages).toEqual([]); f.clock.advanceBy(3600_000); expect(f.q.view()?.status).toBe('queued')
  expect(f.answer()).toBe('invalid-command')
  f.store.append({ type: 'companion/mode', mode: 'rest', requestId: 'rest', commandHash: 'r' }); f.q.stateChanged()
  expect(f.q.view()).toMatchObject({ status: 'waiting', expiresAtMs: f.clock.nowMs() + 600_000 }); expect(f.store.projection().task?.status).toBe('waiting-user')
  f.clock.advanceBy(200_000); f.store.append({ type: 'companion/mode', mode: 'quiet', requestId: 'quiet2', commandHash: 'q' }); f.q.stateChanged(); f.clock.advanceBy(3600_000)
  f.store.append({ type: 'companion/mode', mode: 'rest', requestId: 'rest2', commandHash: 'r' }); f.q.stateChanged(); expect(f.q.view()).toMatchObject({ expiresAtMs: f.clock.nowMs() + 400_000 })
  f.clock.advanceBy(400_000); expect((await pending).visible).toMatchObject({ status: 'timeout' }); expect(f.q.view()).toBeUndefined()
  expect(f.store.projection().context).toEqual([]); expect(f.store.projection().messages).toHaveLength(1)
})
it.each(['abort', 'supersede', 'disable', 'close', 'lights', 'sleep', 'scope', 'settled'] as const)('invalidates a pending question on %s', async (cause) => {
  const f = fixture(); f.start(); const p = f.ask(); const id = f.q.view()!.id
  if (cause === 'abort') f.abort.abort()
  if (cause === 'supersede') f.q.interrupt()
  if (cause === 'disable') f.q.setEnabled(false)
  if (cause === 'close') f.q.close()
  if (cause === 'settled') f.q.settled('turn')
  if (cause === 'lights') f.store.append({ type: 'companion/lights', lightsOut: true, requestId: 'off', commandHash: 'h' })
  if (cause === 'sleep') f.store.append({ type: 'companion/sleep', sleeping: true, cause: 'user' })
  if (cause === 'scope') f.flow('different')
  f.q.stateChanged(); expect((await p).ok).toBe(false); expect(f.q.view()).toBeUndefined()
  expect(f.q.dispatch(f.command({ type: 'question.answer', questionId: id, answer: 'late' }), 'h')).toBe('invalid-command')
})
it('records an answer as user information only after the complete tool batch', async () => {
  const f = fixture(); const requests: ModelRequest[] = []; let index = 0
  const harness = createHarness({ ...f, tools: [f.q.tool(), ...builtinTools()], foreground: f.q.interrupt, afterTools: f.q.commit, turnSettled: f.q.settled,
    model: { source: 'fake', complete: async (request) => { requests.push(structuredClone({ ...request, signal: undefined }) as unknown as ModelRequest); return index++ === 0 ? { usage: { inputTokens: 1, outputTokens: 1 }, text: '', toolCalls: [{ id: 'ask', name: 'ask_user', arguments: '{"question":"Which format?"}' }, { id: 'clock', name: 'get_clock', arguments: '{}' }] } : { usage: { inputTokens: 1, outputTokens: 1 }, text: 'done', toolCalls: [] } } } })
  cleanup.push(harness.dispose); harness.send('Please prepare it', 'r', 'h'); await vi.waitFor(() => expect(f.q.view()?.status).toBe('waiting'))
  expect(f.answer('human reply')).toBeUndefined(); expect(f.store.projection().context.some((message) => message.content === 'human reply')).toBe(false)
  await harness.idle(); const messages = requests[1].messages
  expect(messages.map((message) => message.role)).toEqual(['user', 'assistant', 'tool', 'tool', 'user']); expect(messages.at(-1)?.content).toBe('human reply')
  expect(messages[2].content).not.toContain('human reply'); expect(messages.some((message) => message.content === 'Which format?')).toBe(false)
  const seen = f.store.records().filter((row) => row.type === 'model/seen').at(-1); expect(seen?.type === 'model/seen' && seen.messages.at(-1)?.role).toBe('user')
})
it.each(['abort', 'settled', 'restart'] as const)('drops an answered but incomplete batch on %s', async (cause) => {
  const f = fixture(); f.start(); const p = f.ask(); f.answer('must not reach a model'); await p
  if (cause === 'abort') f.abort.abort()
  if (cause === 'settled') f.q.settled('turn')
  if (cause === 'restart') { const reopened = createQuestions(f.options); expect(reopened.view()).toBeUndefined(); reopened.close() }
  expect(f.store.projection().messages.at(-1)?.status).toBe('undelivered'); expect(f.store.projection().context).toEqual([])
})
it('does not revive waiting questions after restart and rejects duplicate or stale answers', async () => {
  const f = fixture(); f.start(); const p = f.ask(); const id = f.q.view()!.id
  const reopened = createQuestions(f.options); expect(reopened.view()).toBeUndefined(); reopened.close()
  f.q.close(); await p; expect(f.q.dispatch(f.command({ type: 'question.answer', questionId: id, answer: 'stale' }), 'h')).toBe('invalid-command')
})
it('enforces prompt, choices, answer, secret and per-turn/per-day bounds', async () => {
  const f = fixture(); expect(questionInput.safeParse({ question: 'x\ny' }).success).toBe(false); expect(questionInput.safeParse({ question: '字'.repeat(241) }).success).toBe(false)
  expect(questionInput.safeParse({ question: 'x', choices: ['a', 'b', 'c', 'd'] }).success).toBe(false)
  expect(answerInput.safeParse('😀'.repeat(1000)).success).toBe(true); expect(answerInput.safeParse('😀'.repeat(1001)).success).toBe(false); expect(answerInput.safeParse('\ud800').success).toBe(false)
  for (let turn = 0; turn < 4; turn++) {
    const turnId = f.start('turn' + turn)
    for (let i = 0; i < 3; i++) { const p = f.ask(turnId); expect(f.answer('SECRET_CANARY')).toBe('invalid-command'); f.q.dispatch(f.command({ type: 'question.dismiss', questionId: f.q.view()!.id }), 'h'); await p }
    expect((await f.ask(turnId)).visible).toMatchObject({ status: 'question-limit' })
  }
  f.start('last'); expect((await f.ask('last')).visible).toMatchObject({ status: 'question-limit' })
})
it('keeps work questions and replies out of ordinary context eligibility', async () => {
  const f = fixture(); f.flow('flow'); f.store.append({ type: 'flow/open', id: 'flow', mode: 'plan', prefix: [] }); f.start(); const p = f.ask(); f.answer('WORK_ANSWER_CANARY'); await p
  const request = f.store.records().find((row) => row.type === 'question/requested')!; if (request.type !== 'question/requested') throw new Error('MISSING')
  f.q.commit('turn', [request.callId]); f.store.append({ type: 'flow/close', id: 'flow', summary: 'metadata only' })
  const entries = f.store.projection().contextEntries; expect(entries.some((entry) => entry.message.content === 'WORK_ANSWER_CANARY')).toBe(true)
  const allowed = normalContextAllowedSeqs(f.store, entries.map((entry) => entry.seq)); expect(entries.filter((entry) => allowed.has(entry.seq))).toEqual([])
})
it('allows only book answers and preserves command idempotency', async () => {
  const f = fixture(); const c = createAppController(f.clock, undefined, f.store); c.attachQuestions(f.q); f.start(); const p = f.ask(); c.refresh('task')
  const command = { ...f.command({ type: 'question.answer', questionId: f.q.view()!.id, answer: 'choice' }), epoch: c.getSnapshot().epoch }
  expect(c.dispatch(command, 'mini')).toMatchObject({ status: 'rejected', error: { code: 'permission-denied' } }); expect(c.dispatch(command)).toMatchObject({ status: 'accepted' }); expect(c.dispatch(command)).toMatchObject({ status: 'accepted' })
  await p; expect(f.store.records().filter((row) => row.type === 'question/answered')).toHaveLength(1); c.dispose()
})
it('asks approvals without the question budget and accepts only their choices', async () => {
  const f = fixture(); f.start()
  const approve = () => f.q.approve({ question: 'Run node a.js here?', choices: ['允许这一次', '拒绝'] }, { store: f.store, clock: f.clock, signal: f.abort.signal, turnId: 'turn', callId: randomUUID() })
  for (let i = 0; i < 4; i++) {
    const pending = approve()
    expect(f.q.view()).toMatchObject({ status: 'waiting', kind: 'approval', choices: ['允许这一次', '拒绝'] })
    expect(f.answer('let me think')).toBe('invalid-command')
    expect(f.answer(i % 2 ? '拒绝' : '允许这一次')).toBeUndefined()
    expect((await pending).raw).toMatchObject({ status: 'answered' })
  }
  // A fourth ask_user in the same turn is still refused: approvals did not use the questions' budget, and
  // the three questions after them do.
  for (let i = 0; i < 3; i++) { const pending = f.ask(); expect(f.q.view()).not.toHaveProperty('kind'); f.answer(); await pending }
  expect((await f.ask()).raw).toMatchObject({ status: 'question-limit' })
  // The book lays approvals and the chosen answers out apart from her words and typed lines.
  const messages = f.store.projection().messages
  expect(messages.filter((message) => message.kind === 'approval').map((message) => message.text)).toEqual(Array(4).fill('Run node a.js here?'))
  expect(messages.filter((message) => message.kind === 'approval-answer').map((message) => message.text)).toEqual(['允许这一次', '拒绝', '允许这一次', '拒绝'])
  expect(messages.filter((message) => !message.kind && message.role === 'user')).toHaveLength(3)
})
