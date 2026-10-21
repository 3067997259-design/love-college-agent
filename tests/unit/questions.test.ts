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
import { createAppController } from '../../src/main/bridge/controller'
import type { SessionStore } from '../../src/main/store/session'
import type { AppCommand } from '../../src/shared'

const cleanup: (() => void | Promise<void>)[] = []
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn() })
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'lca-questions-')); const clock = createManualClock(1000)
  const journal = openJournal(root, { userId: 'u', characterId: 'c' }, clock)
  const store: SessionStore = { scope: journal.scope, records: journal.records, append: journal.append, projection: () => projectJournal(journal.records()), close: journal.close }
  const options = { store, clock, changed: vi.fn(), safeText: (text: string) => text.replaceAll('SECRET_CANARY', '[redacted]') }
  const q = createQuestions(options); cleanup.push(() => { q.close(); journal.close(); if (!resolve(root).startsWith(join(resolve(tmpdir()), 'lca-questions-'))) throw new Error('UNSAFE'); rmSync(root, { recursive: true, force: true }) })
  const abort = new AbortController()
  const start = (turnId = 'turn') => { store.append({ type: 'turn/start', turnId, trigger: 'user' }); return turnId }
  const ask = (turnId = 'turn') => q.tool().run({ question: 'Which format?', choices: ['Markdown', 'Text'] }, { store, clock, signal: abort.signal, turnId, callId: randomUUID() })
  const command = (body: object) => ({ protocolVersion: 1, epoch: 'epoch', requestId: randomUUID(), ...body }) as AppCommand
  const answer = (text = 'Markdown') => q.dispatch(command({ type: 'question.answer', questionId: q.view()!.id, answer: text }), 'hash')
  return { root, store, clock, q, options, abort, start, ask, command, answer }
}
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
it.each(['abort', 'supersede', 'disable', 'close', 'lights', 'sleep', 'settled'] as const)('invalidates a pending question on %s', async (cause) => {
  const f = fixture(); f.start(); const p = f.ask(); const id = f.q.view()!.id
  if (cause === 'abort') f.abort.abort()
  if (cause === 'supersede') f.q.interrupt()
  if (cause === 'disable') f.q.setEnabled(false)
  if (cause === 'close') f.q.close()
  if (cause === 'settled') f.q.settled('turn')
  if (cause === 'lights') f.store.append({ type: 'companion/lights', lightsOut: true, requestId: 'off', commandHash: 'h' })
  if (cause === 'sleep') f.store.append({ type: 'companion/sleep', sleeping: true, cause: 'user' })
  f.q.stateChanged(); expect((await p).ok).toBe(false); expect(f.q.view()).toBeUndefined()
  expect(f.q.dispatch(f.command({ type: 'question.answer', questionId: id, answer: 'late' }), 'h')).toBe('invalid-command')
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
