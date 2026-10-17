import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { createManualClock, systemClock } from '../../src/main/clock'
import { startMcpFixture } from '../../src/main/mcp/fixture'
import { createMcpConnection } from '../../src/main/mcp/connection'
import { createMcpService } from '../../src/main/mcp/service'
import { boundedMcp } from '../../src/main/mcp/bounded'
import { mcpConfigSchema, readMcpConfig, saveMcpConfig } from '../../src/main/mcp/config'
import { createFakePrivacyModel } from '../../src/main/privacy/filter'
import type { ToolContext } from '../../src/main/harness/tools'
import { createMinecraft } from '../../src/main/minecraft/service'
import { createScheduler } from '../../src/main/scheduler'
import type { AppCommand } from '../../src/shared'

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
  it.each([false, true])('releases game ownership before intentional disconnect and preserves uncertainty on failure (%s, #22)', async (releaseFails) => {
    const fixture = await startMcpFixture(systemClock); cleanups.push(fixture.close); const scheduler = createScheduler(systemClock); const order: string[] = []
    const service = createMcpService({ clock: systemClock, configPath: 'unused', source: 'fake', privacyModel: null, developmentConfig: fixture.config, chooseConfig: async () => null, confirmConnection: async () => true, canConfigure: () => true, changed: () => {},
      beforeDisconnect: async (id) => { if (id !== 'synthetic-game') return; order.push('release-start'); expect(service.protocol(id)).toBeDefined(); await game.stop(); order.push('release-finished'); expect(service.protocol(id)).toBeDefined() } })
    const game = createMinecraft({ clock: systemClock, scheduler, source: () => 'fake', protocol: (id) => {
      const protocol = service.protocol(id); if (!protocol) return
      return { ...protocol, call: (name, input, signal) => name === 'release_control_session' && releaseFails ? Promise.reject(new Error('SYNTHETIC_RELEASE_FAILURE')) : protocol.call(name, input, signal) }
    }, blocked: () => false, changed: () => {} })
    cleanups.push(async () => { await game.close(); scheduler.dispose(); await service.close() })
    const send = (type: 'mcp.connect' | 'mcp.disconnect', serverId: string) => service.dispatch({ protocolVersion: 1, epoch: 'test', requestId: randomUUID(), type, serverId, fingerprint: service.view().servers.find((server) => server.id === serverId)!.fingerprint } as AppCommand)
    send('mcp.connect', 'synthetic-game'); send('mcp.connect', 'synthetic-public'); await service.idle()
    game.dispatch({ type: 'minecraft.check', serverId: 'synthetic-game' } as AppCommand); await game.idle(); const uuid = game.view().pilot!.uuid
    game.dispatch({ type: 'minecraft.start', serverId: 'synthetic-game', expectedPlayerUuid: uuid, scope: { radiusBlocks: 8, durationMs: 60000, allowChat: false } } as AppCommand); await game.idle()
    await game.tool('minecraft_navigate', { x: 2, y: 64, z: 0 }, new AbortController().signal)
    send('mcp.disconnect', 'synthetic-public'); await service.idle(); expect(game.view().status).toBe('playing')
    send('mcp.disconnect', 'synthetic-game'); expect(game.view().status).toBe('stopping'); await service.idle()
    expect(order).toEqual(['release-start', 'release-finished']); expect(service.protocol('synthetic-game')).toBeUndefined()
    expect(game.view()).toMatchObject({ status: releaseFails ? 'failed' : 'idle', stopVerified: !releaseFails })
  })
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
  it('keeps structured protocol IDs main-only while preserving tool allowlists, schema checks and private-mode refusal', async () => {
    const fixture = await startMcpFixture(systemClock); cleanups.push(fixture.close)
    const config = { ...fixture.config.mcpServers['synthetic-private'], privacy: 'none' as const }
    const connection = createMcpConnection({ id: 'protocol', config, clock: systemClock, source: 'fake', privacyModel: null, changed: () => {} }); cleanups.push(connection.disconnect); await connection.connect()
    expect(connection.protocol.allows('synthetic_read', ['title'])).toBe(true)
    expect(connection.protocol.allows('synthetic_read', ['expectedWorldSessionId'])).toBe(false)
    expect(connection.protocol.allows('synthetic_public')).toBe(false)
    const before = fixture.calls(); await expect(connection.protocol.call('synthetic_public', {}, new AbortController().signal)).rejects.toMatchObject({ code: 'permission-denied' }); expect(fixture.calls()).toBe(before)
    await expect(connection.protocol.call('synthetic_read', { title: 123 }, new AbortController().signal)).rejects.toMatchObject({ code: 'permission-denied' })
    expect(await connection.protocol.call('synthetic_read', {}, new AbortController().signal)).toMatchObject({ marker: 'SYNTHETIC_MCP_OK', value: 7 })
    const token = 'headers' in config ? config.headers.Authorization.slice(7) : ''; expect(connection.protocol.identifierAllowed(token)).toBe(false); expect(connection.protocol.identifierAllowed(randomUUID())).toBe(true)
    const visible = await connection.tools()[0].run({}, { signal: new AbortController().signal } as ToolContext); expect(JSON.stringify(visible)).not.toContain('sk-syntheticmcpcredential')
    const privateConnection = createMcpConnection({ id: 'private', config: fixture.config.mcpServers['synthetic-private'], clock: systemClock, source: 'fake', privacyModel: createFakePrivacyModel(), changed: () => {} }); cleanups.push(privateConnection.disconnect); await privateConnection.connect()
    expect(privateConnection.protocol.allows('synthetic_read')).toBe(false); await expect(privateConnection.protocol.call('synthetic_read', {}, new AbortController().signal)).rejects.toMatchObject({ code: 'permission-denied' })
    await connection.disconnect(); expect(connection.protocol.allows('synthetic_read')).toBe(false)
    await expect(connection.protocol.call('synthetic_read', {}, new AbortController().signal)).rejects.toMatchObject({ code: 'permission-denied' })
  })
  it('accepts screenshots only through the fixed main-only image outlet with explicit public allowlist', async () => {
    const fixture = await startMcpFixture(systemClock); cleanups.push(fixture.close)
    const config = fixture.config.mcpServers['synthetic-game']
    const connection = createMcpConnection({ id: 'game', config, clock: systemClock, source: 'fake', privacyModel: null, changed: () => {} }); cleanups.push(connection.disconnect); await connection.connect()
    const world = await connection.protocol.call('get_world_session', {}, new AbortController().signal) as { sessionId: string }
    const args = { expectedWorldSessionId: world.sessionId }; const image = await connection.protocol.image(args, new AbortController().signal)
    expect(image.mimeType).toBe('image/png'); expect(image.metadata).toMatchObject({ source: 'client-framebuffer', width: 16, height: 12 })
    // The generic text protocol and harness alias do not receive image/base64 data.
    await expect(connection.protocol.call('screenshot', args, new AbortController().signal)).rejects.toMatchObject({ code: 'mcp-invalid-result' })
    const alias = connection.tools().find((tool) => tool.definition.description.includes('/screenshot.'))!
    const ordinary = await alias.run(args, { signal: new AbortController().signal } as ToolContext)
    expect(ordinary.ok).toBe(false); expect(JSON.stringify(ordinary)).not.toContain(image.data)
    const privateConnection = createMcpConnection({ id: 'private-game', config: { ...config, privacy: 'always' }, clock: systemClock, source: 'fake', privacyModel: null, changed: () => {} }); cleanups.push(privateConnection.disconnect); await privateConnection.connect()
    await expect(privateConnection.protocol.image(args, new AbortController().signal)).rejects.toMatchObject({ code: 'permission-denied' })
    const denied = createMcpConnection({ id: 'no-shots', config: { ...config, allowTools: config.allowTools.filter((name) => name !== 'screenshot') }, clock: systemClock, source: 'fake', privacyModel: null, changed: () => {} }); cleanups.push(denied.disconnect); await denied.connect()
    await expect(denied.protocol.image(args, new AbortController().signal)).rejects.toMatchObject({ code: 'permission-denied' })
    await connection.disconnect(); await expect(connection.protocol.image(args, new AbortController().signal)).rejects.toMatchObject({ code: 'permission-denied' })
  })
})
