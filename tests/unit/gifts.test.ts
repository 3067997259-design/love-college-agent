import { afterEach, describe, expect, it } from 'vitest'
import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createManualClock, systemClock } from '../../src/main/clock'
import { openJournal } from '../../src/main/journal/file'
import { projectJournal } from '../../src/main/journal/projection'
import { createScheduler } from '../../src/main/scheduler'
import { projectMemory } from '../../src/main/memory/projection'
import { createBinaryAssets, validateGlb } from '../../src/main/storage/assets'
import { createRodinApi } from '../../src/main/gifts/rodin-api'
import { createRodinMcp } from '../../src/main/gifts/mcp'
import { createGiftService } from '../../src/main/gifts/service'
import { syntheticGlb } from '../../src/main/gifts/fixture'
import { idleTimer } from '../../src/main/pomodoro/schema'
import type { SessionStore } from '../../src/main/store/session'

const cleanups: (() => void | Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'lca-gifts-')); const clock = createManualClock(1000)
  cleanups.push(() => { if (!resolve(root).startsWith(join(resolve(tmpdir()), 'lca-gifts-'))) throw new Error('Unsafe cleanup'); rmSync(root, { recursive: true, force: true }) })
  const journal = openJournal(root, { userId: 'u', characterId: 'c' }, clock); cleanups.push(journal.close)
  const store: SessionStore = { scope: journal.scope, records: journal.records, append: journal.append, projection: () => projectJournal(journal.records()), close: journal.close }
  const assets = createBinaryAssets(root, store); const scheduler = createScheduler(clock); cleanups.push(scheduler.dispose)
  const memory = { view: () => projectMemory(store.records()), refresh: () => {}, append: store.append, close: () => {} }
  store.append({ type: 'model/seen', turnId: 't', source: 'fake', messages: [{ role: 'user', content: '合成的共同纸桥经历' }], eligibleIndexes: [0] })
  store.append({ type: 'memory/batch', source: 'fake', batchId: 'a'.repeat(64), keys: [], entries: [{ id: 'mem:proof', kind: 'experience', text: '合成的共同纸桥经历', topic: null, supersedes: [], sources: [{ id: 'seen-proof', sessionId: store.scope.sessionId, frameSeq: 2, index: 0, offset: 0, atMs: 1000 }] }] })
  return { root, clock, store, assets, scheduler, memory }
}
async function apiFixture(badDownload = false) {
  const submissions: string[] = []; let polls = 0; let downloadAuthorization: string | undefined
  const server = createServer(async (request, response) => {
    let text = ''; for await (const chunk of request) text += chunk
    if (request.url === '/model.glb') { downloadAuthorization = request.headers.authorization; response.writeHead(200); response.end(syntheticGlb()); return }
    response.writeHead(201, { 'Content-Type': 'application/json' })
    if (request.url === '/api/v2/rodin') { submissions.push(text); response.end(JSON.stringify({ uuid: '11111111-1111-4111-8111-111111111111', jobs: { subscription_key: 'PRIVATE_RODIN_HANDLE' } })); return }
    if (request.url === '/api/v2/status') { polls++; response.end(JSON.stringify({ jobs: [{ status: polls > 1 ? 'Done' : 'Waiting' }] })); return }
    response.end(JSON.stringify({ list: [{ name: 'model.glb', url: badDownload ? 'http://169.254.169.254/model.glb' : 'http://127.0.0.1:' + (server.address() as { port: number }).port + '/model.glb' }] }))
  })
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done)); cleanups.push(async () => { server.closeAllConnections(); await new Promise<void>((done) => server.close(() => done())) })
  const api = createRodinApi({ base_url: 'http://127.0.0.1:' + (server.address() as { port: number }).port, api_key: 'SYNTHETIC_RODIN_KEY' }, systemClock)
  return { api, submissions, downloadAuthorization: () => downloadAuthorization }
}
describe('Rodin MCP lifecycle, provenance, privacy and local assets', () => {
  it('uses real MCP and REST, preserves private handles for restart, and never forwards credentials to asset downloads', async () => {
    const f = fixture(); const upstream = await apiFixture(); const id = randomUUID(); const signal = new AbortController().signal
    const port = await createRodinMcp(upstream.api, f.assets, f.root); cleanups.push(port.close)
    expect(await port.call('begin', { id, objectId: 'cup', motif: 'sakura' }, signal)).toEqual({ accepted: true })
    expect(await port.call('poll', { id }, signal)).toEqual({ state: 'waiting' }); await port.close()
    const resumed = await createRodinMcp(upstream.api, f.assets, f.root); cleanups.push(resumed.close)
    await resumed.call('begin', { id, objectId: 'cup', motif: 'sakura' }, signal); const result = await resumed.call('poll', { id }, signal)
    expect(result).toMatchObject({ state: 'ready', asset: { format: 'glb' } }); expect(JSON.stringify(result)).not.toMatch(/PRIVATE_RODIN_HANDLE|SYNTHETIC_RODIN_KEY|subscription|11111111/)
    expect(upstream.submissions).toHaveLength(1); expect(upstream.submissions[0]).toContain('Gen-2.5-Low'); expect(upstream.submissions[0]).not.toContain('共同纸桥经历'); expect(upstream.downloadAuthorization()).toBeUndefined()
    expect(readFileSync(join(f.root, '.rodin-jobs.private.json'), 'utf8')).toContain('PRIVATE_RODIN_HANDLE')
    await expect(resumed.call('begin', { id: randomUUID(), objectId: 'leaf', motif: 'plain' }, signal)).rejects.toMatchObject({ code: 'budget-exceeded' }); expect(upstream.submissions).toHaveLength(1)
  })
  it('rejects private-network download redirects and externally referenced GLB content', async () => {
    const upstream = await apiFixture(true); const signal = new AbortController().signal; const handle = await upstream.api.submit('cup', 'plain', signal)
    await expect(upstream.api.download(handle, signal)).rejects.toThrow('RODIN_DOWNLOAD_REFUSED')
    expect(() => validateGlb(Buffer.from('not a model'))).toThrow(); expect(() => validateGlb(syntheticGlb())).not.toThrow()
    const json = Buffer.from(JSON.stringify({ asset: { version: '2.0' }, buffers: [{ uri: 'https://untrusted.invalid/exfil' }] })); const header = Buffer.alloc(20); header.writeUInt32LE(0x46546c67); header.writeUInt32LE(2, 4); header.writeUInt32LE(20 + json.length, 8); header.writeUInt32LE(json.length, 12); header.writeUInt32LE(0x4e4f534a, 16)
    expect(() => validateGlb(Buffer.concat([header, json]))).toThrow('GLB_EXTERNAL_RESOURCE')
  })
  it('requires witnessed experience and focus, gives only at rest, and charges failed/cancelled submissions to the daily budget', async () => {
    const f = fixture(); let submits = 0; const asset = f.assets.write(syntheticGlb(), 'glb')
    const port = { call: async (name: string) => { if (name === 'begin') { submits++; return { accepted: true } }; return { state: 'ready', asset } }, close: async () => {} }
    const service = createGiftService({ ...f, port, source: 'fake', changed: () => {}, open: () => {} }); cleanups.push(service.close); f.scheduler.cancel('gifts.lifecycle')
    const base = { protocolVersion: 1 as const, requestId: 'r', epoch: 'e' }; const propose = { ...base, type: 'gift.propose' as const, sourceMemoryId: 'mem:proof', objectId: 'cup' as const, motif: 'plain' as const }
    expect(service.dispatch({ ...propose, sourceMemoryId: 'unseen' })).toBe('evidence-unavailable'); expect(service.view().items).toHaveLength(0)
    expect(service.dispatch(propose)).toBeUndefined(); const id = service.view().items[0].id
    expect(service.dispatch({ ...base, type: 'gift.accept', giftId: id })).toBeUndefined()
    expect(service.view().items[0].acceptedAtMs).toEqual(expect.any(Number)); expect(service.dispatch({ ...base, type: 'gift.accept', giftId: id })).toBeUndefined()
    expect(service.dispatch({ ...base, type: 'gift.start', giftId: id })).toBe('unavailable')
    const focus = () => f.store.append({ type: 'pomodoro/state', view: { ...idleTimer(), phase: 'focus', status: 'running', remainingMs: 60000, endsAtMs: 61000, plannedCount: 1, focusIndex: 1, phaseDurationMs: 60000 }, pauseReason: null, cause: 'started' })
    focus(); service.reconcile(); await service.idle(); expect(submits).toBe(1); expect(service.view().items[0].status).toBe('making')
    service.reconcile(); await service.idle(); expect(service.view().items[0].status).toBe('ready'); service.reconcile(); expect(service.view().items[0].status).toBe('ready')
    f.store.append({ type: 'pomodoro/state', view: idleTimer(), pauseReason: null, cause: 'elapsed' }); service.reconcile(); expect(service.view().items[0].status).toBe('given')
    expect(service.dispatch(propose)).toBeUndefined(); focus(); expect(service.dispatch({ ...base, type: 'gift.start', giftId: service.view().items[1].id })).toBe('budget-exceeded')
    expect(JSON.stringify(f.store.records())).not.toMatch(/PRIVATE_RODIN_HANDLE|SYNTHETIC_RODIN_KEY/)
  })
  it('refuses missing configuration and tampered local model bytes', async () => {
    const f = fixture(); const disabled = createGiftService({ ...f, port: null, source: 'real', changed: () => {}, open: () => {} }); cleanups.push(disabled.close)
    expect(disabled.dispatch({ protocolVersion: 1, requestId: 'r', epoch: 'e', type: 'gift.propose', sourceMemoryId: 'mem:proof', objectId: 'leaf', motif: 'plain' })).toBe('not-configured')
    const asset = f.assets.write(syntheticGlb(), 'glb'); expect(f.assets.owned(asset.sha256)).toBeUndefined(); f.store.append({ type: 'asset/stored', asset }); expect(f.assets.owned(asset.sha256)).toEqual(asset)
    const bytes = f.assets.read(asset); bytes[25] ^= 1; writeFileSync(join(f.root, 'artifacts', asset.sha256 + '.glb'), bytes); expect(() => f.assets.read(asset)).toThrow('ASSET_INVALID')
  })
  it('ignores a late result after cancel and does not refund the submission budget', async () => {
    const f = fixture(); const asset = f.assets.write(syntheticGlb(), 'glb'); let deliver: (value: unknown) => void = () => {}
    const port = { call: async (name: string) => name === 'begin' ? { accepted: true } : new Promise((done) => { deliver = done }), close: async () => {} }
    const service = createGiftService({ ...f, port, source: 'fake', changed: () => {}, open: () => {} }); cleanups.push(service.close); f.scheduler.cancel('gifts.lifecycle')
    const base = { protocolVersion: 1 as const, requestId: 'r', epoch: 'e' }; const proposal = { ...base, type: 'gift.propose' as const, sourceMemoryId: 'mem:proof', objectId: 'leaf' as const, motif: 'plain' as const }
    f.store.append({ type: 'pomodoro/state', view: { ...idleTimer(), phase: 'focus', status: 'running', remainingMs: 60000, endsAtMs: 61000, phaseDurationMs: 60000, focusIndex: 1, plannedCount: 1 }, pauseReason: null, cause: 'started' })
    service.dispatch(proposal); service.reconcile(); await service.idle(); service.reconcile(); const id = service.view().items[0].id
    service.dispatch({ ...base, type: 'gift.cancel', giftId: id }); deliver({ state: 'ready', asset }); await service.idle()
    expect(service.view().items[0].status).toBe('cancelled'); expect(f.assets.owned(asset.sha256)).toBeUndefined()
    service.dispatch(proposal); expect(service.dispatch({ ...base, type: 'gift.start', giftId: service.view().items[1].id })).toBe('budget-exceeded')
  })
})
