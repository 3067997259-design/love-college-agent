import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createManualClock } from '../../src/main/clock'
import { openJournal } from '../../src/main/journal/file'
import { projectJournal } from '../../src/main/journal/projection'
import type { SessionStore } from '../../src/main/store/session'
import { createHarness } from '../../src/main/harness/loop'
import { builtinTools, type HarnessTool } from '../../src/main/harness/tools'
import { ModelFailure, type ModelClient, type ModelReply, type ModelRequest } from '../../src/main/model/types'
import { ResourceFailure } from '../../src/main/resources/ledger'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'lca-harness-'))
  const clock = createManualClock(1_000)
  const journal = openJournal(root, { userId: 'u', characterId: 'c' }, clock)
  const store: SessionStore = { scope: journal.scope, records: journal.records, projection: () => projectJournal(journal.records()), append: journal.append, close: journal.close }
  cleanups.push(async () => { store.close(); if (!resolve(root).startsWith(join(resolve(tmpdir()), 'lca-harness-'))) throw new Error('Unsafe cleanup path'); rmSync(root, { recursive: true, force: true }) })
  return { clock, store }
}
function start(options: Parameters<typeof createHarness>[0]) { const harness = createHarness(options); cleanups.push(() => harness.dispose()); return harness }
const reply = (toolCalls: ModelReply['toolCalls'] = [], text = ''): ModelReply => ({ text, toolCalls, usage: { inputTokens: 1, outputTokens: 1 } })
function scripted(fn: (request: ModelRequest, index: number) => Promise<ModelReply>): ModelClient {
  let index = 0
  return { source: 'fake', complete: async (request, report) => { report({ slot: 'chat', attempt: 1, status: 'started', waitMs: 0 }); return fn(request, index++) } }
}
function echoTool(run = vi.fn(async () => ({ ok: true, raw: { private: 'synthetic original' }, visible: { ok: true } }))) {
  const tool: HarnessTool = { definition: { name: 'echo', description: 'synthetic', parameters: { type: 'object' } }, templateId: 'synthetic.echo', validate: () => true, run }
  return { tool, run }
}
function aborted(signal: AbortSignal): Promise<ModelReply> { return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new ModelFailure('cancelled')), { once: true })) }

describe('single inbox execution loop', () => {
  it('discards a reply produced before an ignore or permission change and rebuilds before executing its tools', async () => {
    const f = fixture(); let version = 'before'; const tool = echoTool()
    const model = scripted(async (_request, index) => { if (index === 0) { version = 'after'; return reply([{ id: 'stale-call', name: tool.tool.definition.name, arguments: '{}' }], 'STALE_REPLY') } return reply([], 'fresh reply') })
    const h = start({ ...f, model, tools: [tool.tool], contextVersion: () => version })
    h.send('请读文件', 'context-change', 'hash'); await h.idle()
    expect(tool.run).not.toHaveBeenCalled(); expect(JSON.stringify(f.store.records())).not.toContain('STALE_REPLY')
    expect(f.store.projection().messages.at(-1)?.text).toBe('fresh reply')
  })
  it('refuses a durable resource admission before model dispatch, independently of the book projection', async () => {
    const f = fixture(); const dispatched = vi.fn(async () => reply([], 'must not dispatch'))
    const reserveModel = vi.fn(() => { throw new ResourceFailure('budget-exceeded') })
    const h = start({ ...f, model: scripted(dispatched), tools: [], budget: { reserveModel, reserveSpeech: () => crypto.randomUUID() } })
    h.send('synthetic', 'request', 'hash'); await h.idle()
    expect(dispatched).not.toHaveBeenCalled(); expect(reserveModel).toHaveBeenCalledOnce(); expect(f.store.projection().task).toMatchObject({ status: 'failed', error: { code: 'budget-exceeded' } })
    expect(f.store.records().some((row) => row.type === 'model/attempt')).toBe(false)
  })
  it('executes a real deterministic clock tool and projects only its model-visible result', async () => {
    const f = fixture()
    const model = scripted(async (_request, index) => index === 0 ? reply([{ id: 'call', name: 'get_clock', arguments: '{}' }]) : reply([], 'synthetic final'))
    const harness = start({ ...f, model, tools: builtinTools() })
    harness.send('synthetic question', 'r1', 'hash1')
    await harness.idle()
    expect(f.store.projection().task?.status).toBe('completed')
    expect(f.store.projection().context.find((message) => message.role === 'tool')?.content).toContain('1000')
    expect(f.store.projection().messages.at(-1)?.text).toBe('synthetic final')
    expect(f.store.projection().activities[0].status).toBe('completed')
  })
  it('drains mid-flight user input only after the previous assistant/tool pair', async () => {
    const f = fixture(); const { tool } = echoTool()
    let release!: (value: ModelReply) => void
    const requests: ModelRequest[] = []
    const model = scripted(async (request, index) => { requests.push(request); return index === 0 ? new Promise<ModelReply>((resolve) => { release = resolve }) : reply([], 'done') })
    const harness = start({ ...f, model, tools: [tool] })
    harness.send('first', 'r1', 'h1')
    harness.send('second', 'r2', 'h2')
    expect(requests[0].messages.map((message) => message.content)).toEqual(['first'])
    release(reply([{ id: 'c1', name: 'echo', arguments: '{}' }]))
    await harness.idle()
    expect(requests[1].messages.map((message) => message.role)).toEqual(['user', 'assistant', 'tool', 'user'])
    expect(requests[1].messages.at(-1)?.content).toBe('second')
    expect(JSON.stringify(f.store.projection())).not.toContain('synthetic original')
    expect(f.store.records().filter((record) => record.type === 'turn/start')).toHaveLength(1)
  })
  it('blocks the third equal call despite argument key reordering', async () => {
    const f = fixture(); const { tool, run } = echoTool()
    const model = scripted(async (_request, index) => reply([{ id: `c${index}`, name: 'echo', arguments: index % 2 ? '{"b":2,"a":1}' : '{"a":1,"b":2}' }]))
    const harness = start({ ...f, model, tools: [tool] })
    harness.send('synthetic', 'r', 'h'); await harness.idle()
    expect(run).toHaveBeenCalledTimes(2)
    expect(f.store.projection().task).toMatchObject({ status: 'failed', error: { code: 'repeat-limit' } })
  })
  it('enforces the default twelve-step limit on distinct calls', async () => {
    const f = fixture(); const { tool, run } = echoTool()
    const model = scripted(async (_request, index) => reply([{ id: `c${index}`, name: 'echo', arguments: JSON.stringify({ n: index }) }]))
    const harness = start({ ...f, model, tools: [tool] })
    harness.send('synthetic', 'r', 'h'); await harness.idle()
    expect(run).toHaveBeenCalledTimes(12)
    expect(f.store.projection().task).toMatchObject({ status: 'failed', error: { code: 'step-limit' } })
  })
  it('returns malformed/non-object JSON as tool errors without executing', async () => {
    for (const argumentsText of ['{}{}', '[]']) {
      const f = fixture(); const { tool, run } = echoTool()
      const model = scripted(async (_request, index) => index === 0 ? reply([{ id: 'c', name: 'echo', arguments: argumentsText }]) : reply([], 'corrected'))
      const harness = start({ ...f, model, tools: [tool] })
      harness.send('synthetic', 'r', 'h'); await harness.idle()
      expect(run).not.toHaveBeenCalled()
      expect(f.store.projection().context.find((message) => message.role === 'tool')?.content).toContain('invalid-tool-arguments')
    }
  })
  it('cancels a model and drops the queued input; accepted stop precedes terminal state', async () => {
    const f = fixture(); const model = scripted(async (request) => aborted(request.signal))
    const harness = start({ ...f, model, tools: [] })
    harness.send('first', 'r1', 'h1'); harness.send('queued', 'r2', 'h2')
    expect(harness.stop(f.store.projection().task!.id)).toBe(true)
    expect(f.store.projection().task?.status).toBe('cancelling')
    await harness.idle()
    expect(f.store.projection().task?.status).toBe('aborted')
    expect(f.store.projection().messages.at(-1)?.status).toBe('undelivered')
  })
  it('passes cancellation to an active tool and records its outcome', async () => {
    const f = fixture(); let receivedAbort = false
    const tool = echoTool().tool
    tool.run = async (_input, { signal }) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => { receivedAbort = true; reject(new Error('synthetic')) }, { once: true }))
    const harness = start({ ...f, tools: [tool], model: scripted(async () => reply([{ id: 'c', name: 'echo', arguments: '{}' }])) })
    harness.send('synthetic', 'r', 'h')
    await vi.waitFor(() => expect(f.store.projection().activities).toHaveLength(1))
    harness.stop(f.store.projection().task!.id); await harness.idle()
    expect(receivedAbort).toBe(true)
    expect(f.store.projection().task?.status).toBe('aborted')
    expect(f.store.projection().activities[0].status).toBe('cancelled')
  })
  it('pauses on lights out and resumes the same turn only after lights return', async () => {
    const f = fixture(); let calls = 0
    const model = scripted(async (request, index) => { calls++; return index === 0 ? aborted(request.signal) : reply([], 'resumed') })
    const harness = start({ ...f, model, tools: [] })
    harness.send('synthetic', 'r', 'h')
    f.store.append({ type: 'companion/lights', lightsOut: true, requestId: 'off', commandHash: 'off' }); harness.stateChanged()
    await vi.waitFor(() => expect(f.store.projection().task?.status).toBe('waiting-user'))
    f.clock.advanceBy(60_000); expect(calls).toBe(1)
    f.store.append({ type: 'companion/lights', lightsOut: false, requestId: 'on', commandHash: 'on' }); harness.stateChanged()
    await harness.idle()
    expect(f.store.projection().task?.status).toBe('completed')
    expect(f.store.records().filter((row) => row.type === 'turn/start')).toHaveLength(1)
  })
  it('buffers scheduler events during quiet mode, while user turns still run', async () => {
    const f = fixture(); const complete = vi.fn(async () => reply([], 'done'))
    f.store.append({ type: 'companion/mode', mode: 'quiet', requestId: 'quiet', commandHash: 'quiet' })
    const harness = start({ ...f, tools: [], model: scripted(complete) })
    harness.postEvent('pomodoro', 'synthetic phase event'); await harness.idle(); expect(complete).not.toHaveBeenCalled()
    harness.send('user-initiated', 'r', 'h'); await harness.idle(); expect(complete).toHaveBeenCalledTimes(1)
    f.store.append({ type: 'companion/mode', mode: 'rest', requestId: 'rest', commandHash: 'rest' }); harness.stateChanged(); await harness.idle()
    expect(complete).toHaveBeenCalledTimes(2)
  })
  it('updates a checklist through the validated plan tool', async () => {
    const f = fixture()
    const steps = [{ id: 'one', text: 'synthetic planned step', status: 'pending' as const }]
    const harness = start({ ...f, tools: builtinTools(), model: scripted(async (_request, index) => index === 0
      ? reply([{ id: 'plan', name: 'update_plan', arguments: JSON.stringify({ steps }) }]) : reply([], 'plan recorded')) })
    harness.send('synthetic', 'r', 'h'); await harness.idle()
    expect(f.store.projection().task?.steps).toEqual(steps)
    expect(f.store.records().some((row) => row.type === 'plan/update')).toBe(true)
  })
  it('reserves a persisted budget before requests and never resumes crashed effects', async () => {
    const f = fixture(); const complete = vi.fn(async () => reply([], 'done'))
    const harness = start({ ...f, tools: [], model: scripted(complete), limits: { dailyTokens: 5000 } })
    harness.send('first', 'r1', 'h1'); await harness.idle()
    harness.send('second', 'r2', 'h2'); await harness.idle()
    expect(complete).toHaveBeenCalledTimes(1)
    expect(f.store.projection().task).toMatchObject({ status: 'failed', error: { code: 'budget-exceeded' } })
    await harness.dispose()
    f.store.append({ type: 'turn/start', turnId: 'crashed', trigger: 'user' })
    f.store.append({ type: 'assistant/message', turnId: 'crashed', id: 'a', text: '', status: 'complete', toolCalls: [{ id: 'unknown', name: 'echo', arguments: '{}' }] })
    start({ ...f, tools: [], model: scripted(complete) })
    expect(f.store.projection().task?.status).toBe('aborted')
    expect(f.store.projection().context.at(-1)?.content).toContain('not-started')
    expect(complete).toHaveBeenCalledTimes(1)
  })
  it('does not execute an effect when its call cannot be journaled', async () => {
    const f = fixture(); const { tool, run } = echoTool()
    const store: SessionStore = { ...f.store, append: (input) => { if (input.type === 'tool/call') throw new Error('synthetic storage failure'); f.store.append(input) } }
    const harness = start({ clock: f.clock, store, tools: [tool], model: scripted(async () => reply([{ id: 'blocked', name: 'echo', arguments: '{}' }])) })
    harness.send('synthetic', 'r', 'h'); await harness.idle()
    expect(run).not.toHaveBeenCalled()
    expect(f.store.projection().task).toMatchObject({ status: 'failed', error: { code: 'internal' } })
  })
})
