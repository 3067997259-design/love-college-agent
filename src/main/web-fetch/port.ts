import { lookup } from 'node:dns/promises'
import { Agent, request, type RequestOptions } from 'node:https'
import { isIPv4 } from 'node:net'
import { networkInterfaces } from 'node:os'
import type { IncomingMessage, ClientRequest } from 'node:http'
import type { Clock } from '../clock'
export interface WebText { text: string; receivedBytes: number; truncated: boolean; contentType: string }
export interface WebTextPort { source: 'real' | 'fake'; read(url: string, signal: AbortSignal): Promise<WebText> }
export function publicFetchUrl(input: string) {
  const url = new URL(input)
  if (input.length > 2048 || url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || /[?#]/.test(input) || url.port || !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z][a-z0-9-]{1,62}$/i.test(url.hostname) || /\.(?:localhost|local|internal|intranet|onion)$/i.test(url.hostname)) throw new Error('WEB_TARGET_UNAVAILABLE')
  return url.href
}
export function publicIPv4(address: string) {
  if (!isIPv4(address)) return false
  const [a, b, c] = address.split('.').map(Number)
  return !(a === 0 || a === 10 || a === 127 || a >= 224 || a === 100 && b >= 64 && b <= 127 || a === 169 && b === 254 || a === 172 && b >= 16 && b <= 31 || a === 192 && (b === 168 || b === 0 && (c === 0 || c === 2) || b === 88 && c === 99) || a === 198 && (b === 18 || b === 19 || b === 51 && c === 100) || a === 203 && b === 0 && c === 113)
}
function abortable<T>(promise: Promise<T>, signal: AbortSignal) {
  return new Promise<T>((done, fail) => { const abort = () => fail(new Error('WEB_UNAVAILABLE')); signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort(); promise.then(done, fail).finally(() => signal.removeEventListener('abort', abort)) })
}
type Dial = (options: RequestOptions, response: (incoming: IncomingMessage) => void) => ClientRequest
/** Pins one previously checked public IPv4 inside a fresh TLS agent; no second resolver/proxy/redirect. */
export function createPublicWebPort(clock: Clock, resolve = (host: string) => lookup(host, { family: 4, all: true }), dial: Dial = request): WebTextPort {
  return { source: 'real', read: async (input, signal) => {
    const url = new URL(publicFetchUrl(input)); const local = new AbortController(); const combined = AbortSignal.any([signal, local.signal]); const cancel = clock.after(10000, () => local.abort()); let agent: Agent | undefined
    try {
      const addresses = await abortable(resolve(url.hostname), combined); combined.throwIfAborted()
      const localAddresses = new Set(Object.values(networkInterfaces()).flatMap((items) => items?.map((item) => item.address) ?? []))
      if (!addresses.length || addresses.length > 16 || addresses.some((item) => item.family !== 4 || !publicIPv4(item.address) || localAddresses.has(item.address))) throw new Error('WEB_UNAVAILABLE')
      const address = addresses[0].address
      agent = new Agent({ keepAlive: false, maxSockets: 1, lookup: (_host, _options, done) => done(null, address, 4) })
      return await new Promise<WebText>((done, fail) => {
        let settled = false; const connection: { req?: ClientRequest } = {}; let receivedBytes = 0; let text = ''; const decoder = new TextDecoder('utf-8', { fatal: true })
        const finish = (result?: WebText) => { if (settled) return; settled = true; combined.removeEventListener('abort', abort); connection.req?.destroy(); if (result) done(result); else fail(new Error('WEB_UNAVAILABLE')) }
        const abort = () => finish(); combined.addEventListener('abort', abort, { once: true })
        if (combined.aborted) { abort(); return }
        const req = dial({ hostname: url.hostname, servername: url.hostname, port: 443, method: 'GET', path: url.pathname, family: 4, agent,
          headers: { Host: url.hostname, Accept: 'text/plain, text/html, application/json', 'Accept-Encoding': 'identity', 'User-Agent': 'LoveCollegeAgent/0.1' } }, (response) => {
          const type = String(response.headers['content-type'] ?? '').toLowerCase(); const contentType = type.split(';')[0].trim(); const charset = /charset\s*=\s*"?([^";\s]+)/.exec(type)?.[1]
          if (response.statusCode !== 200 || !['text/plain', 'text/html', 'application/json'].includes(contentType) || charset && !['utf-8', 'utf8', 'us-ascii'].includes(charset) || response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity') { response.destroy(); finish(); return }
          const success = (truncated: boolean) => { const bounded = text.slice(0, 12000).replace(/[\uD800-\uDBFF]$/, ''); finish({ text: bounded, receivedBytes, truncated: truncated || text.length > bounded.length, contentType }) }
          response.on('data', (part: Buffer) => { if (settled) return; try { const remaining = 65536 - receivedBytes; receivedBytes += part.length; text += decoder.decode(part.subarray(0, Math.max(0, remaining)), { stream: true }); if (receivedBytes >= 65536) { success(true); response.destroy() } } catch { response.destroy(); finish() } })
          response.on('end', () => { if (settled) return; try { text += decoder.decode(); success(false) } catch { finish() } }); response.on('error', () => finish()); response.on('aborted', () => finish())
        })
        connection.req = req; req.on('error', () => finish()); req.end()
      })
    } catch { throw new Error('WEB_UNAVAILABLE') } finally { cancel(); local.abort(); agent?.destroy() }
  } }
}
