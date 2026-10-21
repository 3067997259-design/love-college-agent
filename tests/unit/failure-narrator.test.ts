import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { createManualClock } from '../../src/main/clock'
import { openJournal } from '../../src/main/journal/file'
import { projectJournal } from '../../src/main/journal/projection'
import type { SessionStore } from '../../src/main/store/session'
import { createHarness } from '../../src/main/harness/loop'
import { ModelFailure, type ModelClient, type ModelRequest } from '../../src/main/model/types'
import { createModelClient } from '../../src/main/model/client'
import { ResourceFailure } from '../../src/main/resources/ledger'
import { seenFragments } from '../../src/main/memory/seen'
import { createQuestions } from '../../src/main/questions/service'
import type { AppCommand } from '../../src/shared'
import { builtinTools } from '../../src/main/harness/tools'
import { createVoice } from '../../src/main/voice/service'
const cleanup: (() => void | Promise<void>)[] = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'lca-failure-')); const clock = createManualClock(1000); const journal = openJournal(root, { userId: 'u', characterId: 'c' }, clock)
  const store: SessionStore = { scope: journal.scope, records: journal.records, append: journal.append, projection: () => projectJournal(journal.records()), close: journal.close }
  cleanup.push(() => { store.close(); if (!resolve(root).startsWith(join(resolve(tmpdir()), 'lca-failure-'))) throw new Error('UNSAFE'); rmSync(root, { recursive: true, force: true }) })
  const start = (model: ModelClient, extra: Partial<Parameters<typeof createHarness>[0]> = {}) => { const h = createHarness({ store, clock, model, tools: [], ...extra }); cleanup.push(h.dispose); return h }
  return { store, clock, start }
}
const reply = { text: 'SYNTHETIC_REPLY', toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 } }
it('binds a failed recall request to its original anchor without attaching it to a later ordinary request', async () => {
  const f = fixture(); const anchor = { sessionId: 'old', messageId: 'seen', start: 0, end: 3 }
  f.store.append({ type: 'history/recall-request', requestId: 'recall-r1', anchor, sourceCount: 1 })
  const h = f.start({ source: 'fake', complete: async () => { throw new ModelFailure('configuration') } })
  h.send('Recall question', 'recall-r1', 'h'); await h.idle()
  expect(f.store.projection().messages.findLast((message) => message.failure)?.failure).toMatchObject({ sourceRecallAnchor: anchor })
  h.send('Ordinary question', 'ordinary-r2', 'h'); await h.idle()
  expect(f.store.projection().messages.findLast((message) => message.failure)?.failure?.sourceRecallAnchor).toBeUndefined()
})
it('projects legacy saved failures from the request chain without mutating their persisted payload', async () => {
  const f = fixture(); const anchor = { sessionId: 'old', messageId: 'seen', start: 0, end: 3 }
  f.store.append({ type: 'history/recall-request', requestId: 'legacy-recall', anchor, sourceCount: 1 })
  const h = f.start({ source: 'fake', complete: async () => { throw new ModelFailure('configuration') } })
  h.send('Legacy question', 'legacy-recall', 'h'); await h.idle()
  const current = f.store.records().findLast((row) => row.type === 'narrator/failure')!
  if (current.type !== 'narrator/failure') throw new Error('MISSING_FAILURE')
  const failure = { ...current.failure }; delete failure.sourceRecallAnchor
  f.store.append({ type: 'narrator/failure', id: 'legacy-saved', turnId: current.turnId, text: current.text, failure })
  expect(f.store.projection().messages.find((message) => message.id === 'legacy-saved')?.failure?.sourceRecallAnchor).toEqual(anchor)
  expect(f.store.records().findLast((row) => row.type === 'narrator/failure')).toMatchObject({ failure })
  expect((f.store.records().at(-1) as typeof current).failure.sourceRecallAnchor).toBeUndefined()
})
it('never sends failure narration or partial replies to an enabled speech port', async () => {
  const f = fixture(); const spoken: string[] = []; let count = 0
  const voice = createVoice({ store: f.store, clock: f.clock, blocked: () => false, changed: () => {}, safeText: (text) => text,
    port: { source: 'fake', synthesize: async (text, _signal, emit) => { spoken.push(text); emit(new Uint8Array([0, 0])) } } }); cleanup.push(voice.close)
  voice.dispatch({ type: 'voice.set', enabled: true } as AppCommand)
  const h = f.start({ source: 'fake', complete: async () => { if (!count++) throw new ModelFailure('interrupted', 'SAFE_PARTIAL'); return reply } })
  h.send('fail first', 'r1', 'h'); await h.idle(); voice.observe(); await voice.idle(); expect(spoken).toEqual([])
  h.send('success next', 'r2', 'h'); await h.idle(); voice.observe(); await voice.idle(); expect(spoken).toEqual(['SYNTHETIC_REPLY'])
})
it.each([
  ['configuration', 'configuration-failed', 'configuration'], ['network', 'connection-failed', 'network'], ['upstream', 'upstream-busy', 'upstream'],
  ['quota', 'quota-exhausted', 'quota'], ['content-filtered', 'content-filtered', 'content-filtered'], ['interrupted', 'stream-interrupted', 'interrupted'], ['invalid-output', 'invalid-model-output', 'invalid-response'],
] as const)('keeps %s narration out of subsequent model input and memory', async (kind, code, category) => {
  const f = fixture(); const requests: ModelRequest[] = []; let count = 0
  const h = f.start({ source: 'fake', complete: async (request, attempt) => { requests.push(structuredClone({ ...request, signal: undefined }) as unknown as ModelRequest); attempt({ slot: 'chat', attempt: 1, status: 'started', waitMs: 0 }); if (!count++) throw new ModelFailure(kind, kind === 'interrupted' ? 'SAFE_PARTIAL' : '', 401); return reply } })
  h.send('ORIGINAL_REQUEST', 'r1', 'h1'); await h.idle(); const narration = f.store.projection().messages.find((message) => message.role === 'narrator')!
  expect(narration.failure).toMatchObject({ code, category, attemptCount: 1, httpStatus: 401, toolsExecuted: false, sourceMessageId: f.store.projection().messages[0].id })
  if (kind === 'interrupted') expect(f.store.projection().messages.some((message) => message.text === 'SAFE_PARTIAL' && message.status === 'interrupted')).toBe(true)
  h.send('NEXT_REQUEST', 'r2', 'h2'); await h.idle(); expect(JSON.stringify(requests[1].messages)).not.toContain(narration.text)
  expect(seenFragments(f.store.records()).some((fragment) => fragment.text.includes(narration.text))).toBe(false)
  const countBefore = f.store.records().filter((row) => row.type === 'narrator/failure').length; await h.dispose(); f.start({ source: 'fake', complete: async () => { throw new Error('NO_REPLAY') } })
  expect(f.store.records().filter((row) => row.type === 'narrator/failure')).toHaveLength(countBefore)
})
it('never renders or logs an arbitrary exception body', async () => {
  const f = fixture(); const h = f.start({ source: 'fake', complete: async () => { throw new Error('SECRET_RAW_VENDOR_BODY') } })
  h.send('task', 'r', 'h'); await h.idle(); expect(f.store.projection().messages.at(-1)?.failure?.category).toBe('internal'); expect(JSON.stringify(f.store.records())).not.toContain('SECRET_RAW_VENDOR_BODY')
})
it('has a budget narration with zero recorded attempts when admission rejects before HTTP', async () => {
  const f = fixture(); const fetcher = vi.fn()
  const model = createModelClient(new Map([['chat', { base_url: 'http://synthetic.invalid/v1', api_key: 'synthetic-private', model: 'synthetic' }]]), ['chat'], f.clock, fetcher)
  const h = f.start(model, { budget: { reserveModel: () => { throw new ResourceFailure('budget-exceeded') }, reserveSpeech: () => 'unused' } })
  h.send('task', 'r', 'h'); await h.idle(); expect(f.store.projection().messages.at(-1)?.failure).toMatchObject({ code: 'budget-exceeded', category: 'budget', attemptCount: 0 })
  expect(fetcher).not.toHaveBeenCalled()
})
it('holds background failure narration during quiet and exposes it once at rest', async () => {
  const f = fixture(); let reject!: (error: Error) => void
  const h = f.start({ source: 'fake', complete: () => new Promise((_resolve, fail) => { reject = fail }) }); h.postEvent('autonomous', 'synthetic event', 'e')
  f.store.append({ type: 'companion/mode', mode: 'quiet', requestId: 'q', commandHash: 'q' }); reject(new ModelFailure('upstream')); await h.idle()
  expect(f.store.projection().messages).toEqual([]); f.store.append({ type: 'companion/mode', mode: 'rest', requestId: 'r', commandHash: 'r' })
  expect(f.store.projection().messages).toHaveLength(1); expect(f.store.projection().messages[0].failure?.sourceMessageId).toBeUndefined()
})
it('does not report user stop as a model failure', async () => {
  const f = fixture(); const h = f.start({ source: 'fake', complete: (request) => new Promise((_resolve, reject) => request.signal.addEventListener('abort', () => reject(new ModelFailure('cancelled')))) })
  h.send('task', 'r', 'h'); expect(h.stop(f.store.projection().task!.id)).toBe(true); await h.idle(); expect(f.store.projection().task?.status).toBe('aborted'); expect(f.store.projection().messages.some((message) => message.role === 'narrator')).toBe(false)
})
it('does not guess a single resend request from mixed user steering', async () => {
  const f = fixture(); let release!: () => void; let calls = 0
  const h = f.start({ source: 'fake', complete: async () => { if (!calls++) return new Promise((done) => { release = () => done({ ...reply, text: '', toolCalls: [{ id: 'clock', name: 'get_clock', arguments: '{}' }] }) }); throw new ModelFailure('network') } }, { tools: builtinTools() })
  h.send('first', 'r1', 'h'); h.send('second', 'r2', 'h'); release(); await h.idle()
  const failures = f.store.projection().messages.filter((message) => message.failure)
  expect(failures).toHaveLength(1); expect(failures[0].failure?.sourceMessageId).toBeUndefined()
})
it('selects the original request, not the answer to ask_user, after a tool failure', async () => {
  const f = fixture(); const q = createQuestions({ store: f.store, clock: f.clock, changed: () => {}, safeText: (text) => text }); cleanup.push(q.close); let calls = 0
  const h = f.start({ source: 'fake', complete: async () => !calls++ ? { ...reply, text: '', toolCalls: [{ id: 'ask', name: 'ask_user', arguments: '{"question":"format?"}' }] } : Promise.reject(new ModelFailure('network')) }, { tools: [q.tool()], afterTools: q.commit, turnSettled: q.settled })
  h.send('PARENT_REQUEST', 'r', 'h'); const original = f.store.projection().messages[0].id; await vi.waitFor(() => expect(q.view()?.status).toBe('waiting'))
  q.dispatch({ protocolVersion: 1, epoch: 'x', requestId: 'answer', type: 'question.answer', questionId: q.view()!.id, answer: 'ANSWER_INFORMATION' } as AppCommand, 'h'); await h.idle()
  expect(f.store.projection().messages.at(-1)?.failure).toMatchObject({ toolsExecuted: true, sourceMessageId: original })
})
it.each(['plain-403', 'explicit-http', 'explicit-stream'] as const)('uses explicit content markers and never falls back on %s', async (source) => {
  const f = fixture(); const never = vi.fn(async () => ({ ok: true, raw: {}, visible: {} }))
  const fetcher = vi.fn(async () => source === 'plain-403' ? new Response('{"error":{"message":"content filter SECRET_VENDOR","code":"invalid_api_key"}}', { status: 403 })
    : source === 'explicit-http' ? new Response('{"error":{"code":"content_policy_violation","message":"SECRET_VENDOR"}}', { status: 400 })
    : new Response('data: ' + JSON.stringify({ choices: [{ index: 0, delta: { content: 'SAFE_PARTIAL', tool_calls: [{ index: 0, id: 'never', function: { name: 'do_effect', arguments: '{}' } }] }, finish_reason: 'content_filter' }] }) + '\n\ndata: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } }))
  const config = { base_url: 'http://synthetic.invalid/v1', api_key: 'synthetic-private', model: 'synthetic' }
  const model = createModelClient(new Map([['chat', config], ['chat_google', config]]), source === 'plain-403' ? ['chat'] : ['chat', 'chat_google'], f.clock, fetcher)
  const h = f.start(model, { tools: [{ definition: { name: 'do_effect', description: 'test', parameters: {} }, templateId: 'test.effect', validate: () => true, run: never }] })
  h.send('task', 'r', 'h'); await h.idle(); expect(fetcher).toHaveBeenCalledOnce(); expect(never).not.toHaveBeenCalled()
  expect(f.store.projection().messages.at(-1)?.failure?.category).toBe(source === 'plain-403' ? 'configuration' : 'content-filtered'); expect(JSON.stringify(f.store.records())).not.toContain('SECRET_VENDOR')
})
