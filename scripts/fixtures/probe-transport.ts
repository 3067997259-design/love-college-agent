import { subscribe, unsubscribe } from 'node:diagnostics_channel'

// Observe Node fetch without changing its transport or retaining URLs, headers or bodies.
export function observeProbeTransport(endpoint: string, now: () => number) {
  const target = new URL(endpoint), began = now(), requests = new Set<unknown>()
  const events: { stage: string; elapsedMs: number; code?: string }[] = []
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
  ]) {
    const listener = (message: unknown) => {
      if (!message || typeof message !== 'object') return
      const data = message as { request?: { origin?: string; path?: string; method?: string }; connectParams?: { hostname?: string; host?: string }; error?: unknown }
      if (name === 'request:create' && data.request?.origin === target.origin && data.request.path === target.pathname + target.search && data.request.method === 'POST') requests.add(data.request)
      const relevant = data.request ? requests.has(data.request) : requests.size > 0 && (data.connectParams?.hostname === target.hostname || data.connectParams?.host === target.host)
      if (relevant && events.length < 64) events.push({ stage, elapsedMs: now() - began, ...(safeCode(data.error) ? { code: safeCode(data.error) } : {}) })
    }
    listeners.set('undici:' + name, listener); subscribe('undici:' + name, listener)
  }
  return {
    diagnostics: { transport: 'node-fetch', events },
    close: () => { for (const [name, listener] of listeners) unsubscribe(name, listener) },
  }
}
