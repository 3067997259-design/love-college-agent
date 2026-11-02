import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { expect, it } from 'vitest'
import { connectMemoryRepository, ensureMemorySchema } from '../../../../src/main/memory/airi/pgvector/repository'

const container = process.env.LCA_TEST_PG_CONTAINER
const enabled = process.env.LCA_MEMORY_TEST_POSTGRES === '1' && /^lca-continuity-pg-[a-f0-9-]+$/.test(container ?? '') && !!process.env.LCA_TEST_DOCKER_CONFIG
const trace = (stage: string) => { if (process.env.LCA_TEST_PG_TRACE === '1') console.info('LCA_PG_STAGE', stage) }
it.skipIf(!enabled)('reconnects after private DB outage without resurrecting a deleted origin', { timeout: 120_000 }, async () => {
  const url = process.env.LCA_MEMORY_TEST_DATABASE_URL!, namespace = 'lca_memory_' + randomUUID().replaceAll('-', '')
  const docker = (...args: string[]) => spawnSync('docker', ['--config', process.env.LCA_TEST_DOCKER_CONFIG!, ...args], { encoding: 'utf8', windowsHide: true, timeout: 30_000 })
  expect(docker('inspect', container!, '--format', '{{index .Config.Labels "lca.continuity-test"}}').stdout.trim()).toBe('true')
  await ensureMemorySchema(url, namespace)
  trace('schema-ready')
  const first = connectMemoryRepository(url, undefined, namespace)
  const input = { originId: 'forgotten', content: 'synthetic recovery fact', category: 'chat', memoryType: 'long_term' as const, importance: 5, valence: 0, arousal: 0, tags: [], embedding: Array.from({ length: 768 }, (_, i) => i === 0 ? 1 : 0) }
  try {
    await first.repository.insert(input); await first.repository.removeByOriginId(input.originId)
    trace('tombstone-committed')
    expect(docker('stop', container!).status).toBe(0)
    trace('database-stopped')
    await expect(first.repository.list({ limit: 10 })).rejects.toBeDefined()
    trace('outage-rejected')
  } finally { trace('closing'); await first.close(); trace('closed'); expect(docker('start', container!).status).toBe(0); trace('database-started') }
  let ready = false
  for (let i = 0; i < 60; i++) { if (docker('exec', container!, 'pg_isready', '-U', 'postgres', '-d', 'lca_acceptance').status === 0) { ready = true; break }; await new Promise(done => setTimeout(done, 500)) }
  expect(ready).toBe(true)
  expect(docker('port', container!, '5432/tcp').stdout.trim()).toBe(`127.0.0.1:${new URL(url).port}`)
  const resumed = connectMemoryRepository(url, undefined, namespace)
  try { await resumed.repository.insert(input); expect(await resumed.repository.list({ limit: 10 })).toEqual([]) }
  finally { await resumed.close() }
})
