import { expect, it } from 'vitest'
import { chatEndpoint, classifyConnectionIssue, directProbe, dshProbe, engineUnavailable, publicCodeOf, withoutKeys } from '../../src/main/config/connection-issue'
import { ModelFailure } from '../../src/main/model/types'

it.each([
  [{ httpStatus: 401, message: 'Incorrect API key provided' }, 'key-rejected'],
  [{ code: 'AUTH', message: '401 Authentication Fails, Your api key is invalid' }, 'key-rejected'],
  [{ httpStatus: 403, message: 'Your region is not supported' }, 'forbidden'],
  [{ httpStatus: 404, message: 'The model `gpt-9` does not exist or you do not have access to it.' }, 'model-not-found'],
  [{ code: 'UNKNOWN_MODEL', message: 'unknown model' }, 'model-not-found'],
  [{ httpStatus: 404, message: '<html>Not Found</html>' }, 'endpoint-not-found'],
  [{ httpStatus: 400, message: "This model's maximum context length is 8192 tokens." }, 'bad-request'],
  [{ httpStatus: 400, message: "Invalid 'messages[0].content': empty" }, 'bad-request'],
  [{ httpStatus: 429, message: 'You exceeded your current quota, please check your plan and billing details.' }, 'quota'],
  [{ httpStatus: 402, message: 'Insufficient Balance' }, 'quota'],
  [{ httpStatus: 429, message: 'Rate limit reached' }, 'rate-limited'],
  [{ httpStatus: 503, message: 'Service Unavailable' }, 'server-error'],
  [{ code: 'ENOTFOUND', message: 'getaddrinfo ENOTFOUND api.example.invalid' }, 'dns'],
  [{ code: 'ECONNREFUSED', message: 'connect ECONNREFUSED 127.0.0.1:11434' }, 'refused'],
  [{ code: 'CERT_HAS_EXPIRED', message: 'certificate has expired' }, 'tls'],
  [{ code: 'TIMEOUT', message: 'No reply within 30 s' }, 'timeout'],
  [{ code: 'TRANSPORT', message: 'Connection error.' }, 'refused'],
  [{ code: 'EMPTY_RESPONSE', message: 'empty' }, 'bad-response'],
  [{ code: 'PI_AI_ERROR', message: 'something new' }, 'unknown'],
] as const)('classifies %j as %s', (input, kind) => {
  expect(classifyConnectionIssue(input)).toBe(kind)
})

it('reads a status pi-ai wrote into its message', () => {
  expect(classifyConnectionIssue({ code: 'PI_AI_ERROR', message: '401 status code (no body)' })).toBe('key-rejected')
  expect(classifyConnectionIssue({ code: 'INVALID_REQUEST', message: '404 Not Found' })).toBe('endpoint-not-found')
})

it('keeps each failure on a code the rest of the app already knows', () => {
  expect(publicCodeOf('key-rejected')).toBe('configuration-failed')
  expect(publicCodeOf('quota')).toBe('quota-exhausted')
  expect(publicCodeOf('timeout')).toBe('connection-failed')
  expect(publicCodeOf('engine-unavailable')).toBe('unavailable')
})

it('masks configured keys and bearer tokens but keeps the address and model', () => {
  const text = 'Incorrect API key provided: sk-synthetic-secret-123. Authorization: Bearer abcdefghijklmnop at https://api.example.invalid/v1 for model demo'
  const masked = withoutKeys(text, ['sk-synthetic-secret-123'])
  expect(masked).not.toContain('sk-synthetic-secret-123')
  expect(masked).not.toContain('abcdefghijklmnop')
  expect(masked).toContain('https://api.example.invalid/v1')
  expect(masked).toContain('model demo')
})

it('builds the URL LCA posts to', () => {
  expect(chatEndpoint('https://api.example.invalid/v1/')).toBe('https://api.example.invalid/v1/chat/completions')
  expect(chatEndpoint('https://api.example.invalid/v1/chat/completions')).toBe('https://api.example.invalid/v1/chat/completions')
})

it('splits a direct-client failure: reason and codes for the snapshot, address and provider words for the details', () => {
  const key = 'sk-synthetic-direct-key'
  const failure = new ModelFailure('configuration', '', 401, undefined, { code: 'invalid_api_key', message: `Incorrect API key provided: ${key}`, body: `{"error":{"message":"Incorrect API key provided: ${key}"}}` })
  const outcome = directProbe({ model: 'demo', endpoint: 'https://api.example.invalid/v1/chat/completions', durationMs: 812, failure, keys: [key] })
  expect(outcome.detail).toEqual({ path: 'direct', durationMs: 812, issue: { kind: 'key-rejected', httpStatus: 401, code: 'invalid_api_key' } })
  expect(outcome.read).toMatchObject({ model: 'demo', endpoint: 'https://api.example.invalid/v1/chat/completions', message: 'Incorrect API key provided: [密钥已遮盖]' })
  expect(JSON.stringify(outcome)).not.toContain(key)
  expect(JSON.stringify(outcome.detail)).not.toMatch(/example\.invalid|Incorrect API key/)
  expect(directProbe({ model: 'demo', endpoint: 'x', durationMs: 5, keys: [] }).detail.issue).toBeUndefined()
  expect(directProbe({ model: 'demo', endpoint: 'x', durationMs: 5, keys: [], failure: new ModelFailure('invalid-output', '', 200, undefined, { message: 'Expected a model event stream, got an HTML page' }) }).detail.issue?.kind).toBe('bad-response')
})

it('describes a DSH failure by its route and keeps the request id for the details', () => {
  const outcome = dshProbe({ model: 'deepseek-flash', keys: ['sk-dsh-synthetic'], result: { ok: false, durationMs: 430, route: { provider: 'deepseek-official', model: 'deepseek-flash' },
    failure: { code: 'AUTH', message: 'Authentication Fails, Your api key: sk-dsh-synthetic is invalid', status: 401, requestId: 'req-123' } } })
  expect(outcome.detail).toEqual({ path: 'dsh', adapter: 'deepseek-official', durationMs: 430, issue: { kind: 'key-rejected', httpStatus: 401, code: 'AUTH' } })
  expect(outcome.read).toEqual({ model: 'deepseek-flash', message: 'Authentication Fails, Your api key: [密钥已遮盖] is invalid', requestId: 'req-123' })
  expect(JSON.stringify(outcome)).not.toContain('sk-dsh-synthetic')
  expect(dshProbe({ model: 'm', keys: [], result: { ok: true, durationMs: 300, route: { provider: 'lca-chat', model: 'm' } }, endpoint: 'http://127.0.0.1:1/v1/chat/completions' }))
    .toEqual({ detail: { path: 'dsh', adapter: 'lca-chat', durationMs: 300 }, read: { model: 'm', endpoint: 'http://127.0.0.1:1/v1/chat/completions' } })
  expect(dshProbe({ model: 'm', keys: [], result: { ok: false, durationMs: 0, route: { provider: '', model: '' }, failure: { code: 'NO_ROUTE', message: 'no route' } } }).detail.issue?.kind).toBe('engine-unavailable')
  expect(engineUnavailable({ model: 'm', reason: new Error('DSH starts once a chat model is saved'), durationMs: 2, keys: [] }))
    .toEqual({ detail: { path: 'dsh', durationMs: 2, issue: { kind: 'engine-unavailable' } }, read: { model: 'm', message: 'DSH starts once a chat model is saved' } })
})

it('lifts the provider sentence out of a pi-ai "401: {json}" failure', () => {
  const raw = '401: {"message":"Incorrect API key provided: mock-key-tail.","type":"invalid_request_error","code":"invalid_api_key"}'
  const outcome = dshProbe({ model: 'm', keys: [], result: { ok: false, durationMs: 14, route: { provider: 'lca-chat', model: 'm' }, failure: { code: 'AUTH', message: raw } } })
  expect(outcome.detail.issue).toEqual({ kind: 'key-rejected', httpStatus: 401, code: 'AUTH · invalid_api_key' })
  expect(outcome.read).toEqual({ model: 'm', message: 'Incorrect API key provided: mock-key-tail.', body: raw })
  const missing = dshProbe({ model: 'm', keys: [], result: { ok: false, durationMs: 9, route: { provider: 'lca-chat', model: 'm' },
    failure: { code: 'INVALID_REQUEST', message: '404: {"error":{"message":"The model `m` does not exist","code":"model_not_found"}}' } } })
  expect(missing.detail.issue).toMatchObject({ kind: 'model-not-found', httpStatus: 404 })
  expect(missing.read.message).toBe('The model `m` does not exist')
  // Plain text stays as it is, with no raw copy.
  const plain = dshProbe({ model: 'm', keys: [], result: { ok: false, durationMs: 1, route: { provider: 'p', model: 'm' }, failure: { code: 'TRANSPORT', message: 'Connection error.' } } })
  expect(plain.detail.issue).toEqual({ kind: 'refused', code: 'TRANSPORT' }); expect(plain.read).toEqual({ model: 'm', message: 'Connection error.' })
})
