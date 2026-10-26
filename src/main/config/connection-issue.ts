import type { ConnectionIssueKind, ConnectionProbeDetail, ConnectionTestRead, PublicErrorCode } from '../../shared'
import type { DshProbeResult } from '../../shared/dsh-protocol'
import { ModelFailure } from '../model/types'

const TIMEOUT = /\b(ETIMEDOUT|UND_ERR_CONNECT_TIMEOUT|UND_ERR_HEADERS_TIMEOUT|UND_ERR_BODY_TIMEOUT|LLM_STREAM_IDLE_TIMEOUT)\b/
const DNS = /\b(ENOTFOUND|EAI_AGAIN|EAI_NONAME|EAI_FAIL)\b/
const TLS = /\b(CERT_[A-Z_]+|UNABLE_TO_VERIFY_LEAF_SIGNATURE|UNABLE_TO_GET_ISSUER_CERT(?:_LOCALLY)?|SELF_SIGNED_CERT_IN_CHAIN|DEPTH_ZERO_SELF_SIGNED_CERT|ERR_TLS_[A-Z_]+|ERR_SSL_[A-Z_]+|EPROTO)\b/
const REFUSED = /\b(ECONNREFUSED|ECONNRESET|ECONNABORTED|EHOSTUNREACH|ENETUNREACH|EPIPE|UND_ERR_SOCKET)\b/
// "model … not found", "unknown model", "模型不存在": the words must sit together, or any 400 that names a model would match.
const MODEL_MISSING = /\bmodel\b[^.\n]{0,60}?\b(not.?found|does.?not.?exist|not.?exist|unknown|invalid|not available|is not supported)\b|\b(unknown|invalid|no such|unsupported)\s+model\b|模型[^。\n]{0,20}(不存在|找不到|无效)/i

/** A status the provider wrote into its message, as pi-ai often reports it ("401 Incorrect API key"). */
const statusIn = (message: string) => { const found = Number(message.match(/\b([45]\d\d)\b/)?.[1]); return Number.isInteger(found) ? found : undefined }

/** One plain reason from what is known; the raw facts stay beside it for the details. */
export function classifyConnectionIssue(input: { httpStatus?: number; code?: string; message?: string; timedOut?: boolean }): ConnectionIssueKind {
  const code = input.code ?? ''; const message = input.message ?? ''; const both = `${code} ${message}`
  const status = input.httpStatus ?? statusIn(message)
  if (input.timedOut || code === 'TIMEOUT' || TIMEOUT.test(both)) return 'timeout'
  if (DNS.test(both)) return 'dns'
  if (TLS.test(both)) return 'tls'
  if (REFUSED.test(both)) return 'refused'
  if (status === 403) return 'forbidden'
  if (status === 401 || code === 'AUTH' || code === 'INVALID_CREDENTIAL' || code === 'MISSING_CREDENTIAL' || /invalid.?api.?key|incorrect api key|authentication/i.test(message)) return 'key-rejected'
  if (status === 402 || code === 'QUOTA' || /insufficient.?(quota|balance|credit|funds)|余额|额度|quota exceeded|exceeded your current quota/i.test(message)) return 'quota'
  if (status === 429 || code === 'RATE_LIMIT') return 'rate-limited'
  if (code === 'UNKNOWN_MODEL' || code === 'model_not_found' || MODEL_MISSING.test(message)) return 'model-not-found'
  if (status === 404 || status === 405) return 'endpoint-not-found'
  if (status !== undefined && status >= 500 || code === 'SERVER') return 'server-error'
  if (status === 400 || status === 413 || status === 422 || code === 'INVALID_REQUEST' || code.startsWith('UNSUPPORTED_')) return 'bad-request'
  if (['EMPTY_RESPONSE', 'MALFORMED_RESPONSE', 'INVALID_RESPONSE', 'STREAM_CLOSED'].includes(code)) return 'bad-response'
  if (code === 'TRANSPORT') return 'refused'
  return 'unknown'
}

/** The closed public code the rest of the app already understands, for the same failure. */
export function publicCodeOf(kind: ConnectionIssueKind): PublicErrorCode {
  if (kind === 'quota') return 'quota-exhausted'
  if (kind === 'rate-limited' || kind === 'server-error') return 'upstream-busy'
  if (kind === 'dns' || kind === 'refused' || kind === 'tls' || kind === 'timeout' || kind === 'unknown') return 'connection-failed'
  if (kind === 'bad-response') return 'invalid-model-output'
  if (kind === 'engine-unavailable') return 'unavailable'
  return 'configuration-failed'
}

/** Never a key: the configured ones and anything sent as a bearer token are masked. */
export function withoutKeys(text: string, keys: readonly string[]): string {
  const masked = [...keys].filter((key) => key && key.length >= 6).sort((a, b) => b.length - a.length).reduce((value, key) => value.split(key).join('[密钥已遮盖]'), text)
  return masked.replace(/\b(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, '$1[已遮盖]')
}

/** The URL LCA's client posts to for an address; DSH's OpenAI-compatible routes use the same rule. */
export function chatEndpoint(baseUrl: string): string {
  const base = baseUrl.replace(/\/+$/, '')
  return base.endsWith('/chat/completions') ? base : `${base}/chat/completions`
}

/**
 * One test, split by where it may go: `detail` rides in the snapshot (path, route name, reason, codes);
 * `read` holds the address and the provider's words, handed to the book only when the user opens the details.
 */
export interface ProbeOutcome { detail: ConnectionProbeDetail; read: Omit<ConnectionTestRead, 'slot' | 'atMs'> }
const bounded = (text: string, keys: readonly string[], max: number) => withoutKeys(text, keys).slice(0, max)

/** A test through LCA's own client (memory, diary, privacy filter). */
export function directProbe(input: { model: string; endpoint: string; durationMs: number; failure?: unknown; keys: readonly string[] }): ProbeOutcome {
  const detail: ConnectionProbeDetail = { path: 'direct', durationMs: input.durationMs }
  const read = { model: input.model, endpoint: input.endpoint }
  if (input.failure === undefined) return { detail, read }
  const failure = input.failure instanceof ModelFailure ? input.failure : undefined
  const diagnostic = failure?.diagnostic
  const code = diagnostic?.code ?? (failure ? undefined : 'UNKNOWN')
  const message = diagnostic?.message ?? (failure ? undefined : input.failure instanceof Error ? input.failure.message : undefined)
  const kind = failure?.kind === 'invalid-output' ? 'bad-response'
    : classifyConnectionIssue({ httpStatus: failure?.httpStatus, code, message: [message, diagnostic?.body].filter(Boolean).join(' '), timedOut: failure?.kind === 'timeout' })
  return {
    detail: { ...detail, issue: { kind, ...(failure?.httpStatus !== undefined ? { httpStatus: failure.httpStatus } : {}), ...(code ? { code: bounded(code, input.keys, 80) } : {}) } },
    read: { ...read, ...(message ? { message: bounded(message, input.keys, 2000) } : {}), ...(diagnostic?.body ? { body: bounded(diagnostic.body, input.keys, 4000) } : {}) },
  }
}

/** A test through DSH: the adapter, route and failure her own turns would meet. */
export function dshProbe(input: { result: DshProbeResult; model: string; endpoint?: string; keys: readonly string[] }): ProbeOutcome {
  const { result } = input
  const detail: ConnectionProbeDetail = { path: 'dsh', ...(result.route.provider ? { adapter: result.route.provider } : {}), durationMs: result.durationMs }
  const read = { model: input.model, ...(input.endpoint ? { endpoint: input.endpoint } : {}) }
  if (result.ok || !result.failure) return { detail, read }
  const { failure } = result
  // pi-ai reports "401: {provider JSON}": lift the provider's own sentence and code out, keep the raw text beside it.
  const provider = providerWords(failure.message)
  const kind = failure.code === 'NO_ROUTE' ? 'engine-unavailable' : classifyConnectionIssue({ httpStatus: failure.status, code: provider?.code === 'model_not_found' ? provider.code : failure.code, message: failure.message })
  const status = failure.status ?? (kind === 'timeout' ? undefined : statusIn(failure.message))
  const code = [failure.code, provider?.code].filter(Boolean).join(' · ')
  const message = provider?.message ?? failure.message
  return {
    detail: { ...detail, issue: { kind, ...(status !== undefined ? { httpStatus: status } : {}), code: bounded(code, input.keys, 80) } },
    read: { ...read, ...(message ? { message: bounded(message, input.keys, 2000) } : {}), ...(provider?.message ? { body: bounded(failure.message, input.keys, 4000) } : {}),
      ...(failure.requestId ? { requestId: bounded(failure.requestId, input.keys, 200) } : {}) },
  }
}

/** `{"error":{"message","code"}}` or `{"message","code"}`, optionally after "401: ". */
function providerWords(text: string): { message?: string; code?: string } | undefined {
  const json = text.match(/^\s*(?:\d{3}\s*:?)?\s*(\{[\s\S]*\})\s*$/)?.[1]
  if (!json) return undefined
  try {
    const parsed: unknown = JSON.parse(json)
    if (!parsed || typeof parsed !== 'object') return undefined
    const outer = parsed as { error?: unknown }
    const error = (outer.error && typeof outer.error === 'object' ? outer.error : parsed) as { message?: unknown; code?: unknown; type?: unknown }
    const message = typeof error.message === 'string' ? error.message : typeof outer.error === 'string' ? outer.error : undefined
    const code = typeof error.code === 'string' ? error.code : typeof error.type === 'string' ? error.type : undefined
    return message || code ? { ...(message ? { message } : {}), ...(code ? { code } : {}) } : undefined
  } catch { return undefined }
}

/** DSH could not be reached or started with this configuration. */
export function engineUnavailable(input: { model: string; endpoint?: string; reason: unknown; durationMs: number; keys: readonly string[] }): ProbeOutcome {
  const message = input.reason instanceof Error ? input.reason.message : String(input.reason ?? '')
  return { detail: { path: 'dsh', durationMs: input.durationMs, issue: { kind: 'engine-unavailable' } },
    read: { model: input.model, ...(input.endpoint ? { endpoint: input.endpoint } : {}), ...(message ? { message: bounded(message, input.keys, 2000) } : {}) } }
}
