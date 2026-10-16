import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createManualClock, systemClock } from '../../src/main/clock'
import { startMcpFixture } from '../../src/main/mcp/fixture'
import { createMcpConnection } from '../../src/main/mcp/connection'
import { createMcpService } from '../../src/main/mcp/service'
import { boundedMcp } from '../../src/main/mcp/bounded'
import { mcpConfigSchema, readMcpConfig, saveMcpConfig } from '../../src/main/mcp/config'
import { createFakePrivacyModel } from '../../src/main/privacy/filter'
import type { ToolContext } from '../../src/main/harness/tools'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
async function setup(privacy = true) {
  const fixture = await startMcpFixture(systemClock); cleanups.push(fixture.close)
  const connection = createMcpConnection({ id: 'synthetic', config: fixture.config.mcpServers['synthetic-private'], source: 'fake', clock: systemClock, privacyModel: privacy ? createFakePrivacyModel() : null, changed: () => {} })
  cleanups.push(connection.disconnect); await connection.connect()
  const context = (signal = new AbortController().signal) => ({ clock: systemClock, signal, turnId: 't' } as ToolContext)
  return { fixture, connection, context }
}
describe('MCP configuration, transport and private result boundaries', () => {
  it('requires native target consent and cannot accept a late approval after disconnect', async () => {
    const fixture = await startMcpFixture(systemClock); cleanups.push(fixture.close)
    let answer: (value: boolean) => void = () => {}; const confirm = vi.fn(() => new Promise<boolean>((resolve) => { answer = resolve }))
    const service = createMcpService({ clock: systemClock, configPath: 'unused', source: 'fake', privacyModel: createFakePrivacyModel(), developmentConfig: fixture.config,
      chooseConfig: async () => null, confirmConnection: confirm, changed: () => {}, canConfigure: () => true })
    cleanups.push(service.close)
    const server = service.view().servers[0]
    const connect = () => service.dispatch({ protocolVersion: 1, epoch: 'test', requestId: 'connect', type: 'mcp.connect', serverId: server.id, fingerprint: server.fingerprint })
    expect(connect()).toBeUndefined(); expect(confirm).toHaveBeenCalledWith(server.id, fixture.config.mcpServers[server.id])
    expect(service.view().servers[0].status).toBe('disconnected'); answer(false); await service.idle()
    expect(service.tools()).toHaveLength(0)
    connect(); service.dispatch({ protocolVersion: 1, epoch: 'test', requestId: 'disconnect', type: 'mcp.disconnect', serverId: server.id }); answer(true); await service.idle()
    expect(service.view().servers[0].status).toBe('disconnected')
    connect(); answer(true); await service.idle(); expect(service.view().servers[0].status).toBe('ready')
    expect(JSON.stringify(service.view())).not.toContain('http://127.0.0.1:')
  })
  it('reads standard stdio/http configurations privately with explicit tool selection', () => {
    const root = mkdtempSync(join(tmpdir(), 'lca-mcp-'))
    const cleanup = () => { if (!resolve(root).startsWith(join(resolve(tmpdir()), 'lca-mcp-'))) throw new Error('Unsafe cleanup'); rmSync(root, { recursive: true, force: true }) }
    try {
      const file = join(root, 'connections', 'mcp.json')
      saveMcpConfig(file, mcpConfigSchema.parse({ mcpServers: { local: { command: 'python', args: ['-m', 'synthetic'], env: { PRIVATE_KEY: 'SYNTHETIC_CONFIG_VALUE' } } } }))
      expect(readMcpConfig(file).mcpServers.local.allowTools).toEqual([])
      expect(readFileSync(file, 'utf8')).toContain('SYNTHETIC_CONFIG_VALUE')
      expect(() => mcpConfigSchema.parse({ mcpServers: { unsafe: { url: 'http://remote.invalid/mcp' } } })).toThrow()
    } finally { cleanup() }
  })
  it('does an actual HTTP handshake, validates schema and keeps private remote content out of journal results', async () => {
    const f = await setup(); expect(f.connection.view().status).toBe('ready'); expect(f.connection.tools()).toHaveLength(3)
    const tool = f.connection.tools().find((item) => item.definition.description.includes('/synthetic_read'))!
    expect(tool.validate({ title: 'fixture' })).toBe(true); expect(tool.validate({ title: 10 })).toBe(false)
    const result = await tool.run({}, f.context())
    expect(result.ok).toBe(true); expect(result.visible).toMatchObject({ kind: 'notice', trust: 'untrusted' })
    expect(JSON.stringify([result, f.connection.view()])).not.toMatch(/RAW_ONLY_|sk-synthetic|127\.0\.0\.1|Bearer/)
  })
  it('refuses private calls before invoking an external tool when the isolated dependency is missing', async () => {
    const f = await setup(false); const before = f.fixture.calls()
    const result = await f.connection.tools()[0].run({}, f.context())
    expect(result.visible).toMatchObject({ error: 'privacy-unavailable' }); expect(f.fixture.calls()).toBe(before)
  })
  it('rejects unsupported remote media and stops a pending call on disconnect', async () => {
    const f = await setup()
    const invalid = f.connection.tools().find((item) => item.definition.description.includes('/synthetic_invalid'))!
    expect((await invalid.run({}, f.context())).visible).toMatchObject({ error: 'mcp-invalid-result' })
    const wait = f.connection.tools().find((item) => item.definition.description.includes('/synthetic_wait'))!
    const before = f.fixture.calls(); const pending = wait.run({}, f.context())
    await vi.waitFor(() => expect(f.fixture.calls()).toBe(before + 1)); await f.connection.disconnect()
    expect((await pending).ok).toBe(false); expect(f.connection.tools()).toHaveLength(0)
  })
  it('uses the injected clock for bounded failure and supports parent cancellation', async () => {
    const clock = createManualClock(); const parent = new AbortController()
    const timeout = boundedMcp(clock, parent.signal, () => new Promise(() => {}), 1000)
    const rejected = expect(timeout).rejects.toMatchObject({ code: 'connection-failed' }); clock.advanceBy(1000); await rejected
    const pending = boundedMcp(clock, parent.signal, () => new Promise(() => {})); const cancelled = expect(pending).rejects.toMatchObject({ code: 'operation-cancelled' }); parent.abort(); await cancelled
  })
})
