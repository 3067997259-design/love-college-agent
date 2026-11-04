import { subscribe, unsubscribe } from 'node:diagnostics_channel'
import { createHash } from 'node:crypto'

// Observe Node fetch without changing its transport or retaining URLs, headers or bodies.
export function observeProbeTransport(endpoint: string, now: () => number) {
  const target = new URL(endpoint), began = now(), requests = new Set<unknown>()
  const events: { stage: string; elapsedMs: number; code?: string }[] = []
  const headers: Record<string, string> = {}, peer: Record<string, unknown> = {}
  const safeCode = (error: unknown): string | undefined => {
    if (!error || typeof error !== 'object') return undefined
    const code = (error as { code?: unknown }).code
    return typeof code === 'string' && /^[A-Z][A-Z0-9_]{1,63}$/.test(code) ? code : undefined
  }
  const listeners = new Map<string, (message: unknown) => void>()
  for (const [name, stage] of [
    ['request:create', 'request-created'], ['client:beforeConnect', 'connect-started'],
    ['client:connected', 'connected'], ['client:connectError', 'connect-error'],
    ['client:sendHeaders', 'headers-sent'], ['request:bodySent', 'body-sent'],
    ['request:headers', 'response-headers'], ['request:error', 'request-error'],
    ['request:trailers', 'response-complete'],
  ]) {
    const listener = (message: unknown) => {
      if (!message || typeof message !== 'object') return
      const data = message as { request?: { origin?: string; path?: string; method?: string }; connectParams?: { hostname?: string; host?: string }; error?: unknown; headers?: string; socket?: { remoteAddress?: string; remoteFamily?: string; alpnProtocol?: string | false } }
      if (name === 'request:create' && data.request?.origin === target.origin && data.request.path === target.pathname + target.search && data.request.method === 'POST') requests.add(data.request)
      const relevant = data.request ? requests.has(data.request) : requests.size > 0 && (data.connectParams?.hostname === target.hostname || data.connectParams?.host === target.host)
      if (relevant && events.length < 64) events.push({ stage, elapsedMs: now() - began, ...(safeCode(data.error) ? { code: safeCode(data.error) } : {}) })
      if (relevant && name === 'client:sendHeaders') {
        for (const line of typeof data.headers === 'string' ? data.headers.split('\r\n') : []) {
          const colon = line.indexOf(':'), key = line.slice(0, colon).toLowerCase()
          if (['user-agent', 'accept', 'accept-encoding', 'accept-language', 'connection', 'content-length', 'sec-fetch-mode'].includes(key)) headers[key] = line.slice(colon + 1).trim()
        }
        if (data.socket?.remoteAddress) peer.addressHash = createHash('sha256').update(data.socket.remoteAddress).digest('hex')
        peer.family = data.socket?.remoteFamily; peer.alpn = data.socket?.alpnProtocol ?? null
      }
    }
    listeners.set('undici:' + name, listener); subscribe('undici:' + name, listener)
  }
  return {
    diagnostics: { transport: 'node-fetch', events, headers, peer },
    close: () => { for (const [name, listener] of listeners) unsubscribe(name, listener) },
  }
}
