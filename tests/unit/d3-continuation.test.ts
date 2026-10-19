import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createManualClock } from '../../src/main/clock'
import { createHarness } from '../../src/main/harness/loop'
import { openJournal } from '../../src/main/journal/file'
import { projectJournal } from '../../src/main/journal/projection'
import { ModelFailure, type ModelClient, type ModelReply, type ModelRequest } from '../../src/main/model/types'
import type { HarnessTool } from '../../src/main/harness/tools'
import type { SessionStore } from '../../src/main/store/session'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'lca-d3-'))
  const clock = createManualClock(1_000)
  const journal = openJournal(root, { userId: 'u', characterId: 'c' }, clock)
  const store: SessionStore = { scope: journal.scope, records: journal.records, projection: () => projectJournal(journal.records()), append: journal.append, close: journal.close }
  cleanups.push(async () => { store.close(); if (!resolve(root).startsWith(join(resolve(tmpdir()), 'lca-d3-'))) throw new Error('Unsafe cleanup path'); rmSync(root, { recursive: true, force: true }) })
  return { clock, store, journal }
}
const reply = (toolCalls: ModelReply['toolCalls'] = [], text = ''): ModelReply => ({ text, toolCalls, usage: { inputTokens: 10, outputTokens: 2 } })
function scripted(fn: (request: ModelRequest, index: number) => Promise<ModelReply> | ModelReply): ModelClient & { requests: ModelRequest[] } {
  const requests: ModelRequest[] = []
  let index = 0
  return { source: 'fake', requests, complete: async (request, report) => { report({ slot: 'chat', attempt: 1, status: 'started', waitMs: 0 }); requests.push(request); return fn(request, index++) } }
}
function start(options: Parameters<typeof createHarness>[0]) { const harness = createHarness(options); cleanups.push(() => harness.dispose()); return harness }
const prepare = (store: SessionStore) => async () => ({ messages: store.projection().context, eligibleIndexes: [] as number[] })

describe('D3 receive and task continuation', () => {
  it('delivers background events to a running turn even when the quiet gate would hide them', async () => {
    const f = fixture()
    let release!: (value: ModelReply) => void
    const echo: HarnessTool = {
      definition: { name: 'echo', description: 'synthetic tool', parameters: { type: 'object' } }, templateId: 'synthetic.echo', validate: () => true,
      run: async () => ({ ok: true, raw: { ok: true }, visible: { ok: true } }),
    }
    const model = scripted(async (_request, index) => index === 0
      ? new Promise<ModelReply>((resolve) => { release = resolve })
      : reply([], 'second reply'))
    const h = start({ ...f, model, tools: [echo], backgroundQuiet: () => true, prepareContext: prepare(f.store) })
    h.send('first message', 'r1', 'h1')
    await vi.waitFor(() => expect(model.requests).toHaveLength(1))
    h.postEvent('pomodoro', 'FOCUS_EVENT_DURING_RUN', 'event-1')
    release(reply([{ id: 'echo-1', name: 'echo', arguments: '{}' }], ''))
    await h.idle()
    expect(model.requests).toHaveLength(2)
    expect(JSON.stringify(model.requests[1].messages)).toContain('FOCUS_EVENT_DURING_RUN')
    expect(f.store.records().findLast((row) => row.type === 'inbox/drain')).toMatchObject({ ids: ['event-1'] })
  })
  it('continues the in-hand task during focus up to the per-focus turn cap, then stops', async () => {
    const f = fixture()
    const model = scripted(() => reply([], 'worked'))
    const h = start({ ...f, model, tools: [], prepareContext: prepare(f.store),
      taskRun: { available: () => true, focusKey: () => 'focus-a', turns: 2, tokens: 100_000, steps: 2 } })
    h.send('start the task', 'r1', 'h1')
    await h.idle()
    const turns = () => f.store.records().filter((row) => row.type === 'turn/start')
    expect(turns().map((row) => row.trigger)).toEqual(['user', 'autonomous', 'autonomous'])
    h.send('another user message', 'r2', 'h2')
    await h.idle()
    expect(turns().map((row) => row.trigger)).toEqual(['user', 'autonomous', 'autonomous', 'user'])
  })
  it('stops continuation when the task is waiting for the user', async () => {
    const f = fixture()
    const ask: HarnessTool = {
      definition: { name: 'ask', description: 'synthetic question', parameters: { type: 'object' } }, templateId: 'user.ask', validate: () => true,
      run: async (_input, context) => {
        f.store.append({ type: 'question/requested', id: crypto.randomUUID(), turnId: context.turnId, callId: context.callId ?? 'ask', question: '决定？', choices: [] })
        return { ok: true, raw: { asked: true }, visible: { asked: true } }
      },
    }
    const model = scripted((_request, index) => index === 0 ? reply([], 'starting') : index === 1 ? reply([{ id: 'ask-1', name: 'ask', arguments: '{}' }], '') : reply([], 'waiting'))
    const h = start({ ...f, model, tools: [ask], prepareContext: prepare(f.store),
      taskRun: { available: () => true, focusKey: () => 'focus-b', turns: 4, tokens: 100_000, steps: 2 } })
    h.send('start the task', 'r1', 'h1')
    await h.idle()
    expect(f.store.records().filter((row) => row.type === 'turn/start').map((row) => row.trigger)).toEqual(['user', 'autonomous'])
    expect(f.store.records().some((row) => row.type === 'question/requested')).toBe(true)
  })
  it('stops continuation after a failed autonomous turn', async () => {
    const f = fixture()
    let calls = 0
    const model: ModelClient = { source: 'fake', complete: async (request, report) => {
      report({ slot: 'chat', attempt: 1, status: 'started', waitMs: 0 })
      calls++
      if (calls === 1) return reply([], 'user turn done')
      throw new ModelFailure('upstream', '', 503)
    } }
    const h = start({ ...f, model, tools: [], prepareContext: prepare(f.store),
      taskRun: { available: () => true, focusKey: () => 'focus-c', turns: 4, tokens: 100_000, steps: 2 } })
    h.send('start the task', 'r1', 'h1')
    await h.idle()
    const turns = f.store.records().filter((row) => row.type === 'turn/start')
    expect(turns.map((row) => row.trigger)).toEqual(['user', 'autonomous'])
    expect(f.store.records().findLast((row) => row.type === 'turn/end')?.reason).toBe('error')
    expect(calls).toBe(2)
  })
})
