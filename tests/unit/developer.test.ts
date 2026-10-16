import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { openSettings } from '../../src/main/config/settings'
import { createManualClock } from '../../src/main/clock'
import { prepareRuntime } from '../../src/main/developer/runtime'
import { startDevelopmentServer } from '../../src/main/developer/server'
import { presetScene, readScene, stageScene } from '../../src/main/developer/scenes'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
function root() {
  const value = mkdtempSync(join(tmpdir(), 'lca-developer-'))
  cleanups.push(async () => { if (!resolve(value).startsWith(join(resolve(tmpdir()), 'lca-developer-'))) throw new Error('Unsafe cleanup path'); rmSync(value, { recursive: true, force: true }) })
  return value
}
describe('development isolation and authenticated MCP', () => {
  it('defaults off, isolates fake dependencies, and refuses developer mode in booth mode', () => {
    const path = root(); const clock = createManualClock(1000)
    expect(prepareRuntime(path, clock).developer).toBe(false)
    const settings = openSettings(path); settings.update((draft) => { draft.developer = true })
    const development = prepareRuntime(path, clock)
    expect(development.profile.path).not.toBe(path); expect(development.scripted?.model.source).toBe('fake')
    const booth = prepareRuntime(path, clock, true)
    expect(booth.developer).toBe(false); expect(booth.scripted).toBeUndefined(); expect(booth.profile.path).toBe(path)
    development.adjusted?.dispose()
  })
  it('stages scenes in fresh profiles without replacing any original journal', () => {
    const path = root(); const settings = openSettings(path); const scene = presetScene('clock-tool', createManualClock(1000))
    const first = stageScene(path, settings, scene); const second = stageScene(path, settings, scene)
    expect(first).not.toBe(second); expect(readScene(join(path, 'developer', first))).toEqual(scene)
    expect(settings.read().sceneId).toBe(second)
  })
  it('requires local host, no browser Origin, and bearer authentication; returns only safe projections', async () => {
    const path = root(); let enabled = true; let injected = ''; let now = 1000
    const server = await startDevelopmentServer(path, 0, {
      enabled: () => enabled, state: () => ({ mode: 'developer', api_key: 'synthetic-sensitive-value' }), context: () => [{ role: 'tool', content: 'visible only' }], diagnostics: () => ({ api_key: 'synthetic-sensitive-value' }), queue: () => [],
      clock: (input) => { now = input.nowMs ?? now; return { nowMs: now } }, inject: (input) => { injected = input.text; return { accepted: true } },
      model: () => ({ source: 'fake' }), exportScene: () => presetScene('empty', createManualClock(1000)), loadScene: () => ({ restartRequired: true }),
    })
    cleanups.push(server.close)
    const connection = JSON.parse(readFileSync(join(path, 'debug-connection.json'), 'utf8')) as { url: string; token: string }
    expect(server.port).toBeGreaterThan(0)
    expect((await fetch(connection.url, { method: 'POST' })).status).toBe(403)
    expect((await fetch(connection.url, { method: 'POST', headers: { Authorization: `Bearer ${connection.token}`, Origin: 'https://untrusted.invalid' } })).status).toBe(403)
    const client = new Client({ name: 'test', version: '1.0.0' })
    await client.connect(new StreamableHTTPClientTransport(new URL(connection.url), { requestInit: { headers: { Authorization: `Bearer ${connection.token}` } } }))
    cleanups.push(() => client.close())
    const state = await client.callTool({ name: 'get_state', arguments: {} })
    expect(JSON.stringify(state)).not.toContain('synthetic-sensitive-value'); expect(JSON.stringify(state)).toContain('REDACTED')
    expect(JSON.stringify(await client.callTool({ name: 'get_diagnostics', arguments: {} }))).not.toContain('synthetic-sensitive-value')
    await client.callTool({ name: 'set_clock', arguments: { nowMs: 5000, frozen: true } }); expect(now).toBe(5000)
    await client.callTool({ name: 'inject_event', arguments: { source: 'pomodoro', text: 'synthetic phase' } }); expect(injected).toBe('synthetic phase')
    expect(JSON.stringify(await client.callTool({ name: 'get_context', arguments: {} }))).toContain('visible only')
    enabled = false
    expect((await fetch(connection.url, { method: 'POST', headers: { Authorization: `Bearer ${connection.token}` } })).status).toBe(403)
  })
})
