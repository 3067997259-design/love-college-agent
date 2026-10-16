import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { createManualClock } from '../../src/main/clock'
import { openJournal } from '../../src/main/journal/file'
import { projectJournal } from '../../src/main/journal/projection'
import { createBinaryAssets } from '../../src/main/storage/assets'
import { createOpticalMemory } from '../../src/main/optical/service'
import { createOpticalHttpPort, opticalConfigSchema, readOpticalConfig } from '../../src/main/optical/client'
import { opticalPages } from '../../src/main/optical/sources'
import { validateOpticalRecords } from '../../src/main/optical/records'
import type { SessionStore } from '../../src/main/store/session'
import type { AppCommand } from '../../src/shared'
import type { OpticalPort } from '../../src/main/optical/schema'
const cleanups: (() => void | Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
const source = '2026年10月16日，我们一起折了蓝色的纸桥。作者叫林青，编号 B-104。\n我今天不交作业。'
// Unit tests validate the PNG envelope. Real pixels and image decoding are covered by Electron.
function png() { const bytes = Buffer.alloc(33); Buffer.from('89504e470d0a1a0a', 'hex').copy(bytes); bytes.write('IHDR', 12, 'ascii'); bytes.writeUInt32BE(1280, 16); bytes.writeUInt32BE(1280, 20); return bytes }
function fixture(text = source, model?: OpticalPort) {
  const root = mkdtempSync(join(tmpdir(), 'lca-optical-')); cleanups.push(() => { if (!resolve(root).startsWith(join(resolve(tmpdir()), 'lca-optical-'))) throw new Error('UNSAFE'); rmSync(root, { recursive: true, force: true }) })
  const clock = createManualClock(0); clock.advanceBy(clock.parse('2026-10-16T12:00:00+08:00'))
  const old = openJournal(root, { userId: 'u', characterId: 'c' }, clock)
  old.append({ type: 'user/message', id: 'source', text, requestId: 'r', commandHash: 'h' }); old.append({ type: 'inbox/drain', ids: ['source'] })
  old.append({ type: 'assistant/message', id: 'reply', turnId: 't', text: '这件事留在我们共同的记录里。', status: 'complete' })
  old.append({ type: 'tool/result', turnId: 't', callId: 'private', raw: { text: 'PRIVATE_MAIL_DOCUMENT_OUTPUT' }, visible: {}, ok: true, elapsedMs: 0 })
  old.append({ type: 'model/seen', turnId: 'next', source: 'fake', messages: [{ role: 'user', content: text }, { role: 'assistant', content: '这件事留在我们共同的记录里。' }, { role: 'tool', content: 'PRIVATE_MAIL_DOCUMENT_OUTPUT' }], eligibleIndexes: [0, 1] })
  old.append({ type: 'flow/open', id: 'private-flow', mode: 'plan', prefix: [] })
  old.append({ type: 'user/message', id: 'flow', text: 'PRIVATE_FLOW_SOURCE', requestId: 'r2', commandHash: 'h2' }); old.append({ type: 'inbox/drain', ids: ['flow'] })
  old.append({ type: 'model/seen', turnId: 'flowturn', source: 'fake', messages: [{ role: 'user', content: 'PRIVATE_FLOW_SOURCE' }], eligibleIndexes: [0] })
  old.append({ type: 'flow/close', id: 'private-flow', summary: '{}' })
  old.append({ type: 'assistant/message', id: 'unseen', turnId: 'last', text: 'UNWITNESSED_FINAL_REPLY', status: 'complete' })
  const oldRows = old.records(); const oldId = old.scope.sessionId; old.close(); clock.advanceBy(86400000)
  const current = openJournal(root, { userId: 'u', characterId: 'c' }, clock)
  const store: SessionStore = { scope: current.scope, records: current.records, history: () => [...oldRows, ...current.records()], pages: () => [{ sessionId: oldId, dayKey: '2026-10-16', records: oldRows }, { sessionId: current.scope.sessionId, dayKey: '2026-10-17', records: current.records() }], append: current.append, projection: () => projectJournal(current.records()), close: current.close }
  const assets = createBinaryAssets(root, store); const rendered: string[] = []; const credentials: string[] = []; let choose: string | null = null
  const options = { root, store, clock, assets, developer: true, render: async (text: string) => { rendered.push(text); return png() }, choose: async () => choose, available: () => true, changed: () => {}, protectCredential: (value: string) => { credentials.push(value) }, ...(model ? { port: model } : {}) }
  const optical = createOpticalMemory(options); cleanups.push(store.close); cleanups.push(optical.close)
  const send = (body: object) => optical.dispatch(body as AppCommand)
  const encode = async () => { send({ type: 'optical.enable', enabled: true }); expect(send({ type: 'optical.encode', sessionId: oldId })).toBeUndefined(); await optical.idle(); return optical.view().frames[0].id }
  return { root, clock, store, assets, optical, options, send, encode, oldId, rendered, credentials, choose: (file: string | null) => { choose = file } }
}
it('encodes only old ordinary witnessed dialogue, rejects open/foreign pages, paginates instead of silently truncating', async () => {
  const f = fixture(); expect(f.optical.view()).toMatchObject({ enabled: false, source: 'none', status: 'unconfigured' })
  expect(f.send({ type: 'optical.encode', sessionId: f.oldId })).toBe('unavailable'); await f.encode()
  expect(f.rendered.join('\n')).toContain('作者叫林青'); expect(f.rendered.join('\n')).not.toMatch(/PRIVATE_|UNWITNESSED_/)
  expect(f.send({ type: 'optical.encode', sessionId: f.store.scope.sessionId })).toBe('invalid-command'); expect(f.send({ type: 'optical.encode', sessionId: 'foreign' })).toBe('invalid-command')
  expect(JSON.stringify(f.optical.view())).not.toContain('作者叫林青'); expect(() => validateOpticalRecords(f.store.history!())).not.toThrow()
  const long = fixture('合成阅读材料'.repeat(1000)); await long.encode(); expect(long.optical.view().frames).toHaveLength(4)
  const count = opticalPages(long.store, long.oldId).length; expect(count).toBeGreaterThan(4)
  long.send({ type: 'optical.encode', sessionId: long.oldId }); await long.optical.idle(); expect(long.optical.view().frames.length).toBe(Math.min(8, count))
  expect(long.optical.view().frames[0]).toMatchObject({ pageIndex: 0, pageCount: count })
})
it('guards replacements and cut negation, preserves unknown rather than inventing, and exposes no prose in public state', async () => {
  const f = fixture(source, { source: 'fake', decode: async (bytes) => { expect(bytes.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a'); return 'U: 我们一起折了蓝色的纸桥。\n作者叫林红，编号 B-104。\n交作业。\nPRIVATE_OCR_INJECTION' } })
  const id = await f.encode(); expect(f.send({ type: 'optical.decode', frameId: id, tier: 'large' })).toBeUndefined(); await f.optical.idle()
  expect(f.optical.view().impressions[0]).toMatchObject({ status: 'guarded', verifiedLineCount: 1, rejectedLineCount: 3 })
  const read = f.optical.read(id); expect(read.impressions[0].fragments).toEqual(['我们一起折了蓝色的纸桥。'])
  expect(JSON.stringify(read)).not.toMatch(/林红|交作业/); expect(JSON.stringify(f.optical.view())).not.toContain('纸桥')
  expect(JSON.stringify(f.store.records())).not.toMatch(/林红|PRIVATE_OCR_INJECTION/)
  const result = await f.optical.tool().run({ frameId: id }, { clock: f.clock, store: f.store, turnId: 'read', signal: new AbortController().signal })
  expect(result.visible).toMatchObject({ memoryAuthority: 'none', status: 'guarded', source: 'fake' })
  f.send({ type: 'optical.enable', enabled: false }); await expect(f.optical.tool().run({ frameId: id }, { clock: f.clock, store: f.store, turnId: 'read', signal: new AbortController().signal })).rejects.toThrow()
  expect(f.optical.read(id).frameId).toBe(id)
})
it('caches four actual decoder tiers and refuses a ninth daily attempt without a fallback model', async () => {
  let calls = 0; const f = fixture(source, { source: 'fake', decode: async () => { calls++; throw new Error('PRIVATE_TRANSPORT_ERROR') } }); const id = await f.encode()
  for (let i = 0; i < 8; i++) { f.send({ type: 'optical.decode', frameId: id, tier: 'tiny' }); await f.optical.idle() }
  expect(f.send({ type: 'optical.decode', frameId: id, tier: 'large' })).toBe('budget-exceeded'); expect(calls).toBe(8); expect(JSON.stringify(f.optical.view())).not.toContain('PRIVATE_TRANSPORT_ERROR')
  const ok = fixture(source, { source: 'fake', decode: async () => 'UNKNOWN_CHANGED_NAME' }); const good = await ok.encode()
  for (const tier of ['large', 'base', 'small', 'tiny'] as const) { ok.send({ type: 'optical.decode', frameId: good, tier }); await ok.optical.idle() }
  expect(ok.optical.view().impressions).toHaveLength(4); expect(ok.optical.view().impressions.every((entry) => entry.status === 'rejected')).toBe(true)
  ok.send({ type: 'optical.decode', frameId: good, tier: 'large' }); await ok.optical.idle(); expect(ok.store.records().filter((row) => row.type === 'optical/attempt' && row.operation === 'decode')).toHaveLength(4)
})
it('cancels non-cooperative decoders, times out, and never accepts late results or resumes work at startup', async () => {
  let finish!: (value: string) => void; const f = fixture(source, { source: 'fake', decode: () => new Promise((done) => { finish = done }) }); const id = await f.encode()
  f.send({ type: 'optical.decode', frameId: id, tier: 'large' }); await Promise.resolve(); f.optical.foreground(); await f.optical.idle(); finish('我们一起折了蓝色的纸桥。'); await Promise.resolve()
  expect(f.optical.view().impressions).toHaveLength(0)
  f.send({ type: 'optical.decode', frameId: id, tier: 'large' }); await Promise.resolve(); f.clock.advanceBy(30000); await f.optical.idle(); expect(f.optical.view().impressions).toHaveLength(0)
  const next = createOpticalMemory(f.options); cleanups.push(next.close); expect(next.view().status).toBe('idle'); expect(next.view().frames).toHaveLength(1); expect(next.view().impressions).toHaveLength(0)
})
it('validates source-bound private replay and keeps broken optional images from taking down the app', async () => {
  const f = fixture(); const id = await f.encode(); const record = f.store.records().find((row) => row.type === 'optical/frame')!
  if (record.type !== 'optical/frame') throw new Error('FIXTURE')
  const rows = structuredClone(f.store.history!()); const changed = rows.find((row) => row.type === 'optical/frame')!
  if (changed.type !== 'optical/frame') throw new Error('FIXTURE'); changed.frame.sources[0].sha256 = 'a'.repeat(64)
  expect(() => validateOpticalRecords(rows)).toThrow()
  const foreign = createOpticalMemory({ ...f.options, store: { ...f.store, scope: { ...f.store.scope, characterId: 'foreign' } } }); cleanups.push(foreign.close); expect(foreign.view().status).toBe('failed'); expect(() => foreign.read(id)).toThrow()
  const missing = createOpticalMemory({ ...f.options, assets: { ...f.assets, read: () => { throw new Error('MISSING') } } }); cleanups.push(missing.close); expect(missing.view().status).toBe('failed')
})
it('keeps native configuration and credentials private, defaults off on reconfiguration, and refuses developer remote endpoints', async () => {
  const f = fixture(); const file = join(f.root, 'local-config.json'); writeFileSync(file, JSON.stringify({ endpoint: 'http://127.0.0.1:5555/decode', apiKey: 'SYNTHETIC_OPTICAL_CREDENTIAL' }))
  f.choose(file); f.send({ type: 'optical.configure' }); await f.optical.idle(); expect(f.optical.view()).toMatchObject({ enabled: false, source: 'fake', status: 'idle' })
  expect(f.credentials).toContain('SYNTHETIC_OPTICAL_CREDENTIAL'); expect(JSON.stringify(f.optical.view())).not.toMatch(/127.0.0.1|SYNTHETIC_OPTICAL_CREDENTIAL/)
  writeFileSync(file, JSON.stringify({ endpoint: 'https://synthetic.invalid/decode', apiKey: '' })); expect(() => readOpticalConfig(file, true)).toThrow()
  for (const endpoint of ['http://remote.invalid/decode', 'https://user:pass@remote.invalid/decode', 'https://remote.invalid/decode?key=secret']) expect(opticalConfigSchema.safeParse({ endpoint, apiKey: '' }).success).toBe(false)
})
it('sends only PNG and documented size/crop settings over the decoder adapter with no redirects or secret logs', async () => {
  const sizes: number[] = []; const port = createOpticalHttpPort({ endpoint: 'http://127.0.0.1:5555/decode', apiKey: 'SYNTHETIC_ONLY' }, 'fake', async (_url, init) => {
    const body = JSON.parse(String(init!.body)); expect(init!.redirect).toBe('error'); expect(body.crop_mode).toBe(false); expect(body.base_size).toBe(body.image_size); expect(body).not.toHaveProperty('text'); expect(body).not.toHaveProperty('sources'); sizes.push(body.image_size)
    return new Response(JSON.stringify({ text: '合成解码' }))
  })
  for (const tier of ['large', 'base', 'small', 'tiny'] as const) expect(await port.decode(png(), tier, new AbortController().signal)).toBe('合成解码')
  expect(sizes).toEqual([1280, 1024, 640, 512])
})
