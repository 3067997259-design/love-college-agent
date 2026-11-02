import { createServer } from 'node:http'
import { once } from 'node:events'
import { channel } from 'node:diagnostics_channel'
import { expect, it } from 'vitest'
import { observeProbeTransport } from '../../scripts/fixtures/probe-transport'

it('observes an actual local fetch without recording URL, credentials or body', async () => {
  const server = createServer((req, res) => { req.resume(); req.on('end', () => res.end('ok')) })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const address = server.address(); if (!address || typeof address === 'string') throw Error('LISTENER_MISSING')
  const endpoint = `http://127.0.0.1:${address.port}/private-fixture-path`
  const before = channel('undici:request:create').hasSubscribers, trace = observeProbeTransport(endpoint, Date.now)
  try {
    const response = await fetch(endpoint, { method: 'POST', headers: { Authorization: 'Bearer never-log-secret' }, body: 'never-log-body' })
    expect(await response.text()).toBe('ok')
    expect(trace.diagnostics.events.map(e => e.stage)).toEqual(expect.arrayContaining(['request-created', 'connected', 'headers-sent', 'body-sent', 'response-headers']))
    expect(JSON.stringify(trace.diagnostics)).not.toMatch(/127\.0\.0\.1|private-fixture|never-log/)
  } finally { trace.close(); server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())) }
  expect(channel('undici:request:create').hasSubscribers).toBe(before)
})

it('distinguishes a local connection refusal from sending a request', async () => {
  const server = createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const address = server.address(); if (!address || typeof address === 'string') throw Error('LISTENER_MISSING')
  await new Promise<void>(done => server.close(() => done()))
  const trace = observeProbeTransport(`http://127.0.0.1:${address.port}/v1/chat/completions`, Date.now)
  try {
    await expect(fetch(`http://127.0.0.1:${address.port}/v1/chat/completions`, { method: 'POST', body: 'fixture' })).rejects.toThrow()
    expect(trace.diagnostics.events).toEqual(expect.arrayContaining([expect.objectContaining({ stage: 'connect-error', code: 'ECONNREFUSED' })]))
    expect(trace.diagnostics.events.map(e => e.stage)).not.toContain('body-sent')
  } finally { trace.close() }
})
