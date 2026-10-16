import { describe, expect, it } from 'vitest'
import { createManualClock } from '../../src/main/clock'
import { createTaskModelPorts } from '../../src/main/model/task-ports'
import type { ProviderSlot, ProviderConfig } from '../../src/main/config/providers'
import type { SessionStore } from '../../src/main/store/session'
import type { JournalRecord } from '../../src/main/journal/schema'
import { projectJournal } from '../../src/main/journal/projection'
import { createPrivacyFilter } from '../../src/main/privacy/filter'
import type { SeenFragment } from '../../src/main/memory/seen'

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
