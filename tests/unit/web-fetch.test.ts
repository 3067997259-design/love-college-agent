import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createServer, request as httpRequest } from 'node:http'
import { Agent } from 'node:https'
import { afterEach, expect, it, vi } from 'vitest'
import { createManualClock } from '../../src/main/clock'
import { openJournal } from '../../src/main/journal/file'
import { projectJournal } from '../../src/main/journal/projection'
import { createFlowFetch } from '../../src/main/web-fetch/service'
import { createPublicWebPort, publicFetchUrl, publicIPv4, type WebText, type WebTextPort } from '../../src/main/web-fetch/port'
import type { SessionStore } from '../../src/main/store/session'
import type { AppCommand } from '../../src/shared'
import { createHeartFlow } from '../../src/main/heart-flow/service'
import { createDesk } from '../../src/main/legacy-flow/desk'
const cleanup: (() => void | Promise<void>)[] = []; afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn() })
function fixture(read = vi.fn<WebTextPort['read']>(async (): Promise<WebText> => ({ text: 'PUBLIC_WORK_TEXT PRIVATE_KEY_CANARY', receivedBytes: 34, contentType: 'text/plain', truncated: false }))) {
  const root = mkdtempSync(join(tmpdir(), 'lca-fetch-')); cleanup.push(() => { if (!resolve(root).startsWith(join(resolve(tmpdir()), 'lca-fetch-'))) throw new Error('UNSAFE'); rmSync(root, { recursive: true, force: true }) })
  const clock = createManualClock(1000); const j = openJournal(root, { userId: 'u', characterId: 'c' }, clock); cleanup.push(j.close)
  const store: SessionStore = { scope: j.scope, records: j.records, append: j.append, projection: () => projectJournal(j.records()), close: j.close }; let allowed = true; let flowId: string | null = 'flow'
  const options = { store, clock, port: { source: 'fake' as const, read }, allowed: () => allowed, flowId: () => flowId, safeText: (text: string) => text.replaceAll('PRIVATE_KEY_CANARY', '[redacted]'), changed: () => {} }
  const fetch = createFlowFetch(options); cleanup.push(fetch.cancel); const request = (signal = new AbortController().signal) => fetch.tools[0].run({ url: 'https://public.synthetic.invalid/readme' }, { store, clock, turnId: 't', signal })
  const decide = (allow: boolean) => fetch.dispatch({ type: 'flow.fetch.approve', approvalId: fetch.view().pending!.id, allow } as AppCommand)
  return { root, store, clock, fetch, request, decide, options, read, block: () => { allowed = false; fetch.stateChanged() }, foreign: () => { flowId = 'foreign'; fetch.stateChanged() } }
}
it('rejects private/non-HTTPS/credentialed/query/fragment/port targets and reserved IPv4 before dialing', () => {
  for (const url of ['http://example.com', 'file:///private', 'https://127.1/x', 'https://0x7f000001/x', 'https://[::1]/', 'https://example.com:444/', 'https://user:pass@example.com/', 'https://example.com/?q=private', 'https://example.com/#private', 'https://example.com/?', 'https://service.local/', 'https://localhost/']) expect(() => publicFetchUrl(url)).toThrow()
  expect(publicFetchUrl('https://Example.com/notes')).toBe('https://example.com/notes')
  for (const ip of ['0.0.0.0', '10.1.2.3', '127.0.0.1', '169.254.169.254', '172.16.0.1', '172.31.255.255', '192.168.1.1', '100.64.0.1', '198.18.0.1', '198.19.0.1', '192.0.2.1', '198.51.100.1', '203.0.113.1', '224.0.0.1', '255.255.255.255', '::ffff:127.0.0.1']) expect(publicIPv4(ip)).toBe(false)
  expect(publicIPv4('8.8.8.8')).toBe(true); expect(publicIPv4('1.1.1.1')).toBe(true)
})
it('requires a unique explicit decision, redacts before returning work data and keeps receipt metadata free of prose', async () => {
  const f = fixture(); const result = f.request(); expect(f.fetch.view()).toMatchObject({ status: 'waiting-approval', requestsUsed: 1 }); expect(f.read).not.toHaveBeenCalled()
  const id = f.fetch.view().pending!.id; f.decide(true); expect((await result).visible).toMatchObject({ text: 'PUBLIC_WORK_TEXT [redacted]', trust: 'untrusted-public-work-data' }); expect(f.read).toHaveBeenCalledOnce()
  expect(f.fetch.dispatch({ type: 'flow.fetch.approve', approvalId: id, allow: true } as AppCommand)).toBe('invalid-command'); expect(f.fetch.view().last).toMatchObject({ status: 'fetched', receivedBytes: 34 })
  expect(JSON.stringify(f.store.records())).not.toContain('PUBLIC_WORK_TEXT'); expect(JSON.stringify(f.fetch.view())).not.toContain('PUBLIC_WORK_TEXT'); expect(f.store.projection().context).toEqual([])
  const restart = createFlowFetch(f.options); expect(restart.view().pending).toBeUndefined(); expect(restart.view().requestsUsed).toBe(1); restart.cancel()
})
it('projects an attached real flow through its direct owner id without recursive full snapshots', async () => {
  const f = fixture(); const flow = createHeartFlow({ store: f.store, clock: f.clock, desk: createDesk(join(f.root, 'desk')), booth: false, busy: () => false, changed: () => {}, prepare: async () => ({ messages: [], eligibleIndexes: [] }), emit: () => {}, run: async () => 'unused' })
  const webFetch = createFlowFetch({ ...f.options, flowId: flow.id }); flow.attachWebFetch(webFetch); flow.dispatch({ type: 'flow.enter' } as AppCommand); await vi.waitFor(() => expect(flow.active()).toBe(true)); expect(flow.view().webFetch).toMatchObject({ requestsUsed: 0, status: 'idle' }); flow.close()
})
it.each(['denied', 'abort', 'blocked', 'foreign', 'approval-timeout'] as const)('does not start DNS/network after %s', async (reason) => {
  const f = fixture(); const abort = new AbortController(); const result = f.request(abort.signal)
  if (reason === 'denied') f.decide(false); if (reason === 'abort') abort.abort(); if (reason === 'blocked') f.block(); if (reason === 'foreign') f.foreign(); if (reason === 'approval-timeout') f.clock.advanceBy(30000)
  expect((await result).ok).toBe(false); expect(f.read).not.toHaveBeenCalled(); expect(f.fetch.view().pending).toBeUndefined()
})
it('cancels an in-flight read and discards late prose; counts denials toward the bounded flow request limit', async () => {
  let done!: (result: WebText) => void; const read = vi.fn<WebTextPort['read']>(() => new Promise<WebText>((resolve) => { done = resolve })); const f = fixture(read)
  const result = f.request(); f.decide(true); f.fetch.cancel(); expect((await result).ok).toBe(false); expect(read.mock.calls[0][1].aborted).toBe(true)
  done({ text: 'LATE_PROSE', receivedBytes: 10, contentType: 'text/plain', truncated: false }); await Promise.resolve(); expect(JSON.stringify(f.store.records())).not.toContain('LATE_PROSE')
  for (let i = 1; i < 12; i++) { const denied = f.request(); f.decide(false); await denied }; await expect(f.request()).rejects.toThrow(); expect(f.fetch.view().requestsUsed).toBe(12)
})
it('refuses any private DNS answer and cancels a hung resolution without performing a later request', async () => {
  const clock = createManualClock(); const dial = vi.fn()
  const port = createPublicWebPort(clock, async () => [{ address: '8.8.8.8', family: 4 }, { address: '127.0.0.1', family: 4 }], dial)
  await expect(port.read('https://public.synthetic.invalid/notes', new AbortController().signal)).rejects.toThrow('WEB_UNAVAILABLE'); expect(dial).not.toHaveBeenCalled()
  let resolve!: (answers: { address: string; family: number }[]) => void
  const hanging = createPublicWebPort(clock, () => new Promise((done) => { resolve = done }), dial).read('https://public.synthetic.invalid/notes', new AbortController().signal)
  clock.advanceBy(10000); await expect(hanging).rejects.toThrow('WEB_UNAVAILABLE'); resolve([{ address: '8.8.8.8', family: 4 }]); await Promise.resolve(); expect(dial).not.toHaveBeenCalled()
})
it('uses the actual Node HTTP reader with pinned TLS connection options, UTF-8 streaming, truncation and refusal of redirects/binary/encoding', async () => {
  const server = createServer((request, response) => {
    if (request.url === '/redirect') response.writeHead(302, { Location: 'https://127.0.0.1/' }).end()
    else if (request.url === '/binary') response.writeHead(200, { 'Content-Type': 'image/png' }).end('not text')
    else if (request.url === '/compressed') response.writeHead(200, { 'Content-Type': 'text/plain', 'Content-Encoding': 'gzip' }).end('not identity')
    else if (request.url === '/large') response.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' }).end('字'.repeat(30000))
    else { response.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' }); const bytes = Buffer.from('公开的合成网页'); response.write(bytes.subarray(0, 2)); response.end(bytes.subarray(2)) }
  })
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done)); cleanup.push(async () => { server.closeAllConnections(); await new Promise<void>((done) => server.close(() => done())) }); const address = server.address(); if (!address || typeof address === 'string') throw new Error('NO_PORT')
  const resolveHost = vi.fn(async () => [{ address: '8.8.8.8', family: 4 }]); let pinned = ''
  const port = createPublicWebPort(createManualClock(), resolveHost, (options, receive) => {
    expect(options.hostname).toBe('public.synthetic.invalid'); expect(options.servername).toBe('public.synthetic.invalid'); expect(options.port).toBe(443); expect(options.method).toBe('GET'); expect(options.family).toBe(4)
    const agent = options.agent as Agent; agent.options.lookup!('public.synthetic.invalid', { family: 4 }, (_err, value) => { pinned = typeof value === 'string' ? value : value[0].address })
    const headers = options.headers as Record<string, string>; expect(Object.keys(headers).some((key) => /authorization|cookie|proxy/i.test(key))).toBe(false)
    // Only this test seam replaces the TLS dial with our owned loopback HTTP fixture.
    return httpRequest({ hostname: '127.0.0.1', port: address.port, method: 'GET', path: options.path, headers }, receive)
  })
  const result = await port.read('https://public.synthetic.invalid/small', new AbortController().signal); expect(result).toEqual({ text: '公开的合成网页', receivedBytes: Buffer.byteLength('公开的合成网页'), truncated: false, contentType: 'text/plain' }); expect(pinned).toBe('8.8.8.8'); expect(resolveHost).toHaveBeenCalledTimes(1)
  expect(await port.read('https://public.synthetic.invalid/large', new AbortController().signal)).toMatchObject({ truncated: true }); for (const path of ['/redirect', '/binary', '/compressed']) await expect(port.read('https://public.synthetic.invalid' + path, new AbortController().signal)).rejects.toThrow('WEB_UNAVAILABLE')
})
