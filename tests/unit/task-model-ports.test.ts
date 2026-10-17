import { describe, expect, it } from 'vitest'
import { createManualClock } from '../../src/main/clock'
import { createTaskModelPorts } from '../../src/main/model/task-ports'
import type { ProviderSlot, ProviderConfig } from '../../src/main/config/providers'
import type { SessionStore } from '../../src/main/store/session'
import type { JournalRecord } from '../../src/main/journal/schema'
import { projectJournal } from '../../src/main/journal/projection'
import { createPrivacyFilter } from '../../src/main/privacy/filter'
import type { SeenFragment } from '../../src/main/memory/seen'
import { seenFragments, memoryInputBytes } from '../../src/main/memory/seen'
import { createMemoryService } from '../../src/main/memory/service'
import { projectMemory } from '../../src/main/memory/projection'
import { validateMemories } from '../../src/main/memory/model'
import { createScheduler } from '../../src/main/scheduler'
import type { AppCommand } from '../../src/shared'
import { ResourceFailure } from '../../src/main/resources/ledger'

const configs = new Map<ProviderSlot, ProviderConfig>(['chat', 'background', 'privacy'].map((slot) => [slot as ProviderSlot, { base_url: 'http://synthetic.invalid/v1', api_key: 'synthetic-' + slot + '-credential', model: 'synthetic-' + slot + '-model' }]))
function fixture() {
  const clock = createManualClock(1000)
  const rows: JournalRecord[] = [{ version: 1, seq: 1, atMs: 0, type: 'session/header', userId: 'u', characterId: 'c', sessionId: 's' }]
  const store: SessionStore = { scope: { userId: 'u', characterId: 'c', sessionId: 's' }, records: () => rows, projection: () => projectJournal(rows), append: (input) => { rows.push({ ...input, version: 1, seq: rows.length + 1, atMs: clock.nowMs() }) }, close: () => {} }
  return { clock, rows, store }
}
function response(value: unknown) {
  return new Response('data: ' + JSON.stringify({ choices: [{ index: 0, delta: { content: JSON.stringify(value) }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 3 } }) + '\n\ndata: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } })
}
describe('production task model ports without runtime model calls', () => {
  it('gates background and privacy attempts on durable admission before any HTTP or fallback', async () => {
    const f = fixture(); let calls = 0; const buckets: string[] = []
    const ports = createTaskModelPorts(configs, f.clock, f.store, async () => { calls++; return response({}) }, {
      reserveModel: (_units, bucket) => { buckets.push(bucket); throw new ResourceFailure('budget-exceeded') }, reserveSpeech: () => crypto.randomUUID(),
    })
    await expect(ports.lifeWork!.produce({ kind: 'read', step: 1, totalSteps: 3, material: 'synthetic', previous: '' }, new AbortController().signal)).rejects.toMatchObject({ code: 'budget-exceeded' })
    await expect(ports.mail!.extract({ sourceId: 'synthetic', subject: 'synthetic', body: 'synthetic', sentAtIso: '2026-10-17T08:00:00+08:00' }, new AbortController().signal)).rejects.toMatchObject({ code: 'budget-exceeded' })
    expect(buckets).toEqual(['autonomous', 'work']); expect(calls).toBe(0); expect(f.rows.some((row) => row.type === 'model/attempt')).toBe(false)
  })
  it('runs private synthetic desk production only on background with strict JSON and metadata-only attempts', async () => {
    const f = fixture(); let calls = 0; let body: Record<string, unknown> = {}
    const ports = createTaskModelPorts(configs, f.clock, f.store, async (_url, init) => {
      calls++; body = JSON.parse(String(init.body))
      return response({ markdown: 'PRIVATE_AUTONOMOUS_PRODUCT' })
    })
    expect(await ports.lifeWork!.produce({ kind: 'read', step: 1, totalSteps: 3, material: 'REGISTERED_DESK_SOURCE', previous: '' }, new AbortController().signal)).toEqual({ markdown: 'PRIVATE_AUTONOMOUS_PRODUCT' })
    expect(body.model).toBe(configs.get('background')!.model); expect(body.tools).toBeUndefined(); expect(body.messages).toHaveLength(2); expect(body.max_tokens).toBe(4096)
    expect(JSON.parse((body.messages as { content: string }[])[1].content)).toEqual({ kind: 'read', step: 1, totalSteps: 3, material: 'REGISTERED_DESK_SOURCE', previous: '' })
    expect(calls).toBe(1); expect(JSON.stringify(f.rows)).not.toMatch(/REGISTERED_DESK|PRIVATE_AUTONOMOUS/)
    expect(f.rows.filter((row) => row.type === 'model/attempt' && row.status === 'started')).toMatchObject([{ slot: 'background', bucket: 'autonomous' }])
    expect(f.rows.some((row) => row.type === 'model/seen')).toBe(false)
    expect(createTaskModelPorts(new Map([['chat', configs.get('chat')!]]), f.clock, f.store).lifeWork).toBeNull()
  })
  it('rejects oversized work input before network, malformed output, and exhausted shared autonomous budget', async () => {
    const f = fixture(); let calls = 0
    const ports = createTaskModelPorts(configs, f.clock, f.store, async () => { calls++; return response({ markdown: '', extra: 'untrusted' }) })
    const input = { kind: 'write' as const, step: 1, totalSteps: 3, material: 'synthetic', previous: '' }
    await expect(ports.lifeWork!.produce({ ...input, material: '文'.repeat(5000) }, new AbortController().signal)).rejects.toBeDefined(); expect(calls).toBe(0)
    await expect(ports.lifeWork!.produce(input, new AbortController().signal)).rejects.toBeDefined(); expect(calls).toBe(1)
    f.store.append({ type: 'model/attempt', turnId: 'used', slot: 'background', attempt: 1, status: 'started', waitMs: 0, bucket: 'autonomous', reservedTokens: 100000 })
    await expect(ports.lifeWork!.produce(input, new AbortController().signal)).rejects.toMatchObject({ code: 'budget-exceeded' }); expect(calls).toBe(1)
  })
  it('cancels private production, ignores a late transport, and never records its body as model-seen', async () => {
    const f = fixture(); let complete!: (value: Response) => void
    const ports = createTaskModelPorts(configs, f.clock, f.store, async () => new Promise<Response>((resolve) => { complete = resolve }))
    const parent = new AbortController(); const pending = ports.lifeWork!.produce({ kind: 'write', step: 1, totalSteps: 3, material: 'PRIVATE_CANCELLED_MATERIAL', previous: '' }, parent.signal)
    const rejected = expect(pending).rejects.toBeDefined(); parent.abort(); await rejected
    complete(response({ markdown: 'PRIVATE_LATE_PRODUCT' })); await Promise.resolve(); await Promise.resolve()
    expect(JSON.stringify(f.rows)).not.toMatch(/PRIVATE_CANCELLED|PRIVATE_LATE/); expect(f.rows.some((row) => row.type === 'model/seen')).toBe(false)
  })
  it('times out a stalled life producer at thirty seconds even when the transport ignores abort', async () => {
    const f = fixture(); let complete!: (value: Response) => void
    const ports = createTaskModelPorts(configs, f.clock, f.store, async () => new Promise<Response>((resolve) => { complete = resolve }))
    const pending = ports.lifeWork!.produce({ kind: 'read', step: 1, totalSteps: 3, material: 'SYNTHETIC_STALLED_INPUT', previous: '' }, new AbortController().signal)
    const rejected = expect(pending).rejects.toMatchObject({ kind: 'timeout' }); f.clock.advanceBy(30000); await rejected
    complete(response({ markdown: 'LATE_WORK_MUST_NOT_COMMIT' })); await Promise.resolve(); await Promise.resolve()
    expect(JSON.stringify(f.rows)).not.toMatch(/SYNTHETIC_STALLED_INPUT|LATE_WORK_MUST_NOT_COMMIT/)
  })
  it('extracts a legal long CJK message then its short successor without duplicating local grounding sources', async () => {
    const f = fixture(); const requests: unknown[][] = []; const scheduler = createScheduler(f.clock)
    const text = '可见材料'.repeat(2500)
    f.store.append({ type: 'model/seen', turnId: 'long', source: 'fake', messages: [{ role: 'user', content: text }, { role: 'user', content: '后续短经历' }], eligibleIndexes: [0, 1] })
    const ports = createTaskModelPorts(configs, f.clock, f.store, async (_url, init) => {
      const body = JSON.parse(String(init.body)); const input = JSON.parse(body.messages[1].content); requests.push(input)
      expect(Buffer.byteLength(body.messages[1].content)).toBeLessThanOrEqual(28000)
      for (const fragment of input) { expect(fragment).not.toHaveProperty('source'); expect(fragment.text.length).toBeLessThanOrEqual(2000); expect(fragment.context?.before.length ?? 0).toBeLessThanOrEqual(256) }
      const last = input.find((fragment: { text: string }) => fragment.text === '后续短经历')
      return response({ items: last ? [{ sourceId: last.id, quote: last.text, kind: 'experience', topic: '短经历', replaceTopic: false }] : [] })
    })
    const repository = { view: () => projectMemory(f.rows), append: f.store.append, refresh: () => {}, close: () => {} }
    const memory = createMemoryService({ clock: f.clock, store: f.store, scheduler, repository, model: ports.memory, isBusy: () => false, rolled: () => {}, changed: () => {} })
    scheduler.cancel('memory.maintenance')
    try {
      for (let index = 0; index < 3; index++) { memory.dispatch({ protocolVersion: 1, epoch: 'test', requestId: 'long-' + index, type: 'memory.extract' } as AppCommand); await memory.idle() }
      expect(requests).toHaveLength(2); expect(repository.view().keys).toHaveLength(6); expect(repository.view().items).toMatchObject([{ text: '后续短经历' }])
      const starts = f.rows.filter((row) => row.type === 'memory/operation' && row.status === 'started')
      expect(starts).toHaveLength(2)
      starts.forEach((row, index) => { if (row.type === 'memory/operation') expect(row.reservedChars).toBe(Buffer.byteLength(JSON.stringify(requests[index]))) })
      expect(f.rows.filter((row) => row.type === 'model/attempt' && row.status === 'started')).toHaveLength(2)
      // The grounding context remains complete locally, so cutting a split-boundary negator still fails.
      const split = { ...seenFragments(f.rows)[0], source: '甲'.repeat(1999) + '不交作业', offset: 2000, text: '交作业' }
      expect(memoryInputBytes([split])).toBeLessThan(1000)
      expect(() => validateMemories({ items: [{ sourceId: split.id, quote: '交作业', kind: 'fact', topic: '作业', replaceTopic: false }] }, [split], f.store.scope, [])).toThrow()
    } finally { await memory.close(); scheduler.dispose() }
  })
  it('routes fresh read-only children only to background, preserves source fingerprints, and records no child text', async () => {
    const f = fixture(); let calls = 0
    const ports = createTaskModelPorts(configs, f.clock, f.store, async (_url, init) => {
      calls++; const body = JSON.parse(String(init.body)); expect(body.model).toBe(configs.get('background')!.model); expect(body.tools).toBeUndefined(); expect(body.messages).toHaveLength(2)
      const input = JSON.parse(body.messages[1].content); expect(Object.keys(input).sort()).toEqual(['sources', 'task']); expect(input.sources[0].sha256).toBe('a'.repeat(64)); expect(input.sources[0].text).toBe('EXPLICIT_CHILD_SOURCE')
      return response({ conclusion: 'UNREVIEWED_CHILD_OUTPUT', refs: [{ path: 'a.md', sha256: 'a'.repeat(64) }] })
    })
    await ports.delegate!.read({ task: 'bounded read', sources: [{ path: 'a.md', sha256: 'a'.repeat(64), text: 'EXPLICIT_CHILD_SOURCE' }] }, new AbortController().signal)
    expect(calls).toBe(1); expect(JSON.stringify(f.rows)).not.toMatch(/EXPLICIT_CHILD_SOURCE|UNREVIEWED_CHILD_OUTPUT/)
    expect(f.rows.filter((row) => row.type === 'model/attempt' && row.status === 'started')).toMatchObject([{ bucket: 'autonomous', slot: 'background' }])
    expect(createTaskModelPorts(new Map([['chat', configs.get('chat')!]]), f.clock, f.store).delegate).toBeNull()
  })
  it('denies child model requests before network when the shared autonomous reserve is exhausted', async () => {
    const f = fixture(); let calls = 0
    f.store.append({ type: 'model/attempt', turnId: 'prior', slot: 'background', attempt: 1, status: 'started', waitMs: 0, bucket: 'autonomous', reservedTokens: 100000 })
    const ports = createTaskModelPorts(configs, f.clock, f.store, async () => { calls++; return response({}) })
    await expect(ports.delegate!.read({ task: 'budget', sources: [{ path: 'a.md', sha256: 'a'.repeat(64), text: 'small' }] }, new AbortController().signal)).rejects.toMatchObject({ code: 'budget-exceeded' })
    expect(calls).toBe(0)
  })
  it('routes subjective diaries to chat with autonomous budget and never persists their prose', async () => {
    const f = fixture(); const models: string[] = []
    const ports = createTaskModelPorts(configs, f.clock, f.store, async (_url, init) => { models.push(JSON.parse(String(init.body)).model); return response({ entry: 'SYNTHETIC_SUBJECTIVE_DIARY' }) })
    expect(await ports.diary!.write([{ id: 'seen', text: 'VISIBLE_ONLY' }], new AbortController().signal)).toEqual({ entry: 'SYNTHETIC_SUBJECTIVE_DIARY' })
    expect(models).toEqual([configs.get('chat')!.model]); expect(JSON.stringify(f.rows)).not.toContain('SYNTHETIC_SUBJECTIVE_DIARY')
    expect(f.rows.filter((row) => row.type === 'model/attempt' && row.status === 'started')).toMatchObject([{ bucket: 'autonomous', slot: 'chat' }])
  })
  it('routes memory to background without tools and preserves scrubbed provenance IDs', async () => {
    const f = fixture(); let model = ''; let auth = ''; let sourceId = ''; let tools: unknown
    const ports = createTaskModelPorts(configs, f.clock, f.store, async (_url, init) => {
      const body = JSON.parse(String(init.body)); model = body.model; auth = (init.headers as Record<string, string>).Authorization; tools = body.tools
      sourceId = JSON.parse(body.messages[1].content)[0].id
      return response({ items: [{ sourceId, quote: '可见纸桥', kind: 'experience', topic: '纸桥', replaceTopic: false }] })
    })
    const fragment: SeenFragment = { id: 'generated-provenance-id-longer-than-32:8:0:0', key: 'a'.repeat(64), sessionId: 's', frameSeq: 8, index: 0, offset: 0, atMs: 0, role: 'user', text: '可见纸桥' }
    const output = await ports.memory!.extract([fragment], new AbortController().signal)
    expect(sourceId).toBe(fragment.id); expect(output).toHaveProperty('items'); expect(model).toBe(configs.get('background')!.model); expect(auth).toBe('Bearer ' + configs.get('background')!.api_key); expect(tools).toBeUndefined()
    expect(f.rows.filter((row) => row.type === 'model/attempt')).toHaveLength(2); expect(JSON.stringify(f.rows)).not.toContain('可见纸桥')
  })
  it('sends private document content only to privacy and logs neither source nor output', async () => {
    const f = fixture(); const models: string[] = []; let input = ''
    const ports = createTaskModelPorts(configs, f.clock, f.store, async (_url, init) => {
      const body = JSON.parse(String(init.body)); models.push(body.model); input = body.messages[1].content
      return response({ markdown: 'USER_ONLY_PRIVATE_OUTPUT', deadline: null })
    })
    const result = await ports.document!.organize({ text: 'RAW_ONLY_PRIVATE_DOCUMENT sk-syntheticcredential123456789', format: 'text', pageCount: null }, new AbortController().signal)
    expect(models).toEqual([configs.get('privacy')!.model]); expect(input).toContain('RAW_ONLY_PRIVATE_DOCUMENT'); expect(input).not.toContain('sk-synthetic')
    expect(result).toEqual({ markdown: 'USER_ONLY_PRIVATE_OUTPUT', deadline: null }); expect(JSON.stringify(f.rows)).not.toMatch(/RAW_ONLY_|USER_ONLY_|synthetic-privacy-credential/)
  })
  it('fails closed on privacy configuration failure and never falls back to chat', async () => {
    const f = fixture(); const models: string[] = []
    const ports = createTaskModelPorts(configs, f.clock, f.store, async (_url, init) => { models.push(JSON.parse(String(init.body)).model); return new Response('SYNTHETIC_DENIAL', { status: 401 }) })
    expect(await createPrivacyFilter(ports.narrow)('RAW_ONLY_REMOTE')).toEqual({ ok: false, error: 'privacy-unavailable' })
    expect(models).toEqual([configs.get('privacy')!.model])
    const absent = createTaskModelPorts(new Map([['chat', configs.get('chat')!]]), f.clock, f.store)
    expect(absent.memory).toBeNull(); expect(absent.document).toBeNull(); expect(absent.mail).toBeNull(); expect(absent.narrow).toBeNull()
  })
  it('cancels the private request when the caller is stopped', async () => {
    const f = fixture(); let aborted = false; let started!: () => void; const ready = new Promise<void>((resolve) => { started = resolve })
    const ports = createTaskModelPorts(configs, f.clock, f.store, async (_url, init) => new Promise<Response>((_resolve, reject) => { init.signal!.addEventListener('abort', () => { aborted = true; reject(new Error('SYNTHETIC_ABORT')) }, { once: true }); started() }))
    const parent = new AbortController(); const pending = ports.document!.organize({ text: 'RAW_ONLY_CANCELLED', format: 'text', pageCount: null }, parent.signal)
    const stopped = expect(pending).rejects.toBeDefined(); await ready; parent.abort(); await stopped; expect(aborted).toBe(true)
    expect(JSON.stringify(f.rows)).not.toContain('RAW_ONLY_CANCELLED')
  })
})
