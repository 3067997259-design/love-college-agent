import { createServer } from 'node:http'
import { once } from 'node:events'
import { expect, it } from 'vitest'
import { curlModelRequest } from '../../scripts/fixtures/curl-transport'

it('sends one exact curl request using escaped stdin config and returns sanitized metrics', async () => {
  const key = 'synthetic-"-\\-secret', body = { model: 'fixture', messages: [{ role: 'user', content: 'OK\n"\\' }] }
  let received = 0, auth: string | undefined, data = ''
  const server = createServer((req, res) => { received++; auth = req.headers.authorization; req.on('data', chunk => { data += chunk }); req.on('end', () => res.end(JSON.stringify({ choices: [{ message: { content: 'OK' }, finish_reason: 'stop' }] }))) })
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); const address = server.address(); if (!address || typeof address === 'string') throw Error('NO_LISTENER')
  try {
    const result = await curlModelRequest(`http://127.0.0.1:${address.port}/v1/chat/completions`, key, body)
    expect(result.ok).toBe(true); expect(received).toBe(1); expect(auth).toBe('Bearer ' + key); expect(JSON.parse(data)).toEqual(body)
    expect(result.metrics.size_upload).toBe(Buffer.byteLength(JSON.stringify(body)))
    expect(JSON.stringify(result)).not.toMatch(/synthetic-|127\.0\.0\.1/)
  } finally { server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())) }
})

it('never follows a redirect or retries a provider error', async () => {
  let received = 0
  const server = createServer((_req, res) => { received++; res.writeHead(307, { Location: '/other' }); res.end() })
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); const address = server.address(); if (!address || typeof address === 'string') throw Error('NO_LISTENER')
  try {
    const result = await curlModelRequest(`http://127.0.0.1:${address.port}/v1/chat/completions`, 'synthetic-secret', {})
    expect(result.ok).toBe(false); expect(result.httpStatus).toBe(307); expect(received).toBe(1); expect(result.metrics.num_redirects).toBe(0)
  } finally { server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())) }
})

it('preserves an already serialized UTF-8 request byte for byte', async () => {
  const raw = JSON.stringify({ messages: [{ role: 'user', content: '海边\n"' }], stream: false, max_tokens: 512 })
  const chunks: Buffer[] = []
  const server = createServer((req, res) => { req.on('data', chunk => chunks.push(chunk)); req.on('end', () => res.end('{"choices":[{"message":{"content":"OK"},"finish_reason":"stop"}]}')) })
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); const address = server.address(); if (!address || typeof address === 'string') throw Error('NO_LISTENER')
  try {
    const result = await curlModelRequest(`http://127.0.0.1:${address.port}/v1/chat/completions`, 'fixture-key', raw, 45000, { 'User-Agent': 'curl-fixture' })
    expect(result.ok).toBe(true); expect(Buffer.concat(chunks)).toEqual(Buffer.from(raw))
  } finally { server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())) }
})

it('refuses a proxy case without end-to-end HTTPS or with embedded proxy credentials', async () => {
  await expect(curlModelRequest('http://example.invalid/v1', 'fixture-key', {}, 45000, {}, 'http://127.0.0.1:7897')).rejects.toThrow('INVALID_DIAGNOSTIC_PROXY')
  await expect(curlModelRequest('https://example.invalid/v1', 'fixture-key', {}, 45000, {}, 'http://user:secret@127.0.0.1:7897')).rejects.toThrow('INVALID_DIAGNOSTIC_PROXY')
})
