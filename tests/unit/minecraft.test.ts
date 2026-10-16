import { afterEach, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import type { AppCommand } from '../../src/shared'
import { createManualClock } from '../../src/main/clock'
import { createScheduler } from '../../src/main/scheduler'
import { createMinecraft, type GameReceipt } from '../../src/main/minecraft/service'
import type { GameProtocol } from '../../src/main/minecraft/protocol'
const cleanup: (() => Promise<void>)[] = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })
function fixture(interrupted?: GameReceipt) {
  const clock = createManualClock(1000); const scheduler = createScheduler(clock)
  const world = { instanceId: randomUUID(), sessionId: randomUUID(), revision: 1, connected: true, playerUuid: randomUUID(), dimension: 'minecraft:overworld' }
  const player = { uuid: world.playerUuid, name: 'SyntheticPilot', dimension: world.dimension, x: 0, y: 64, z: 0, alive: true, yaw: 0, pitch: 0 }
  let blocked = false; let unsafe = false; let releaseFails = false; let connected = true; let active = false; let streamId = randomUUID(); let cursor = 20
  let owner: string | undefined; let events: unknown[] = []; let hang: Promise<unknown> | undefined; let applyLook = true; const calls: { name: string; input: Record<string, unknown> }[] = []; const receipts: GameReceipt[] = []; const seen: unknown[] = []
  const protocol: GameProtocol = { allows: () => true, identifierAllowed: (value) => value !== 'credential', text: (value) => value.replaceAll('PRIVATE', '[redacted]'), call: async (name, input) => {
    calls.push({ name, input }); const stamp = (value: Record<string, unknown>) => ({ ...value, worldSession: { ...world } })
    if (name === 'get_status') return stamp({ mod: 'mcpfabric', side: 'client', serverPresent: true, integratedServer: true })
    if (name === 'list_capabilities') return stamp({ groups: { command: unsafe, world_write: false, control: true, navigation: true } })
    if (name === 'get_world_session') return { ...world }
    if (input.expectedWorldSessionId !== world.sessionId) throw new Error('SYNTHETIC_STALE_WORLD')
    if (name === 'get_self') return stamp({ ...player })
    if (name === 'look') { owner = String(input.controlSessionId); if (applyLook) { player.yaw = Number(input.yaw); player.pitch = Number(input.pitch) }; return stamp({ yaw: input.yaw, pitch: input.pitch }) }
    if (name === 'poll_event_page') return stamp({ streamId, cursor, gap: false, events: input.tail ? [] : events })
    if (name === 'navigate_to') { owner = String(input.controlSessionId); active = true; if (hang) return hang; return stamp({ started: true }) }
    if (name === 'navigation_status') return stamp({ active, state: active ? 'navigating' : 'reached' })
    if (name === 'send_chat') return stamp({ sent: true, asCommand: false })
    if (name === 'release_control_session') { if (releaseFails) throw new Error('SYNTHETIC_RELEASE_FAILED'); owner = undefined; active = false; return stamp({ released: true, controlSessionId: input.controlSessionId }) }
    if (name === 'get_process_state') return stamp({ owned: owner === input.controlSessionId, source: 'client-process', controlSessionId: input.controlSessionId })
    throw new Error('SYNTHETIC_UNEXPECTED_TOOL')
  } }
  const game = createMinecraft({ clock, scheduler, protocol: () => connected ? protocol : undefined, source: () => 'fake', blocked: () => blocked, changed: () => {}, record: (receipt) => receipts.push(receipt), interrupted, events: (messages) => seen.push(...messages) })
  cleanup.push(async () => { connected = true; releaseFails = false; await game.close(); scheduler.dispose() })
  const send = (command: Record<string, unknown>) => game.dispatch({ ...command, protocolVersion: 1, epoch: 'test', requestId: randomUUID() } as AppCommand)
  const start = async (scope: Extract<AppCommand, { type: 'minecraft.start' }>['scope'] = { radiusBlocks: 8, durationMs: 60000, allowChat: true }) => { expect(send({ type: 'minecraft.start', serverId: 'game', expectedPlayerUuid: player.uuid, scope })).toBeUndefined(); await game.idle() }
  return { game, clock, scheduler, world, player, protocol, calls, receipts, seen, send, start, finish: () => { active = false }, setLookApplied: (value: boolean) => { applyLook = value }, setBlocked: (value: boolean) => { blocked = value; game.stateChanged() }, setUnsafe: () => { unsafe = true }, setReleaseFailure: (value: boolean) => { releaseFails = value }, disconnect: () => { connected = false }, setEvents: (value: unknown[], latest: number) => { events = value; cursor = latest }, newStream: () => { streamId = randomUUID(); cursor = 0 }, setHang: (value: Promise<unknown>) => { hang = value } }
}
const signal = () => new AbortController().signal
it('requires the observed pilot, read-only host flags and world-bound schemas before a round', async () => {
  const f = fixture(); f.send({ type: 'minecraft.check', serverId: 'game' }); await f.game.idle(); expect(f.game.view()).toMatchObject({ status: 'ready', source: 'fake', pilot: { uuid: f.player.uuid }, checks: { commandsDisabled: true } })
  f.send({ type: 'minecraft.start', serverId: 'game', expectedPlayerUuid: randomUUID(), scope: { radiusBlocks: 8, durationMs: 60000, allowChat: true } }); await f.game.idle(); expect(f.game.view().status).toBe('failed'); expect(f.receipts).toHaveLength(0)
  f.setUnsafe(); await f.start(); expect(f.game.view().status).toBe('failed'); expect(f.calls.some((call) => call.name === 'navigate_to')).toBe(false)
})
it('uses a qualified input owner for look and verifies fresh player angles before success', async () => {
  const f = fixture(); await f.start()
  expect(await f.game.tool('minecraft_look', { yaw: -90, pitch: 20 }, signal())).toMatchObject({ observed: true, yaw: -90, pitch: 20 })
  expect(f.calls.find((call) => call.name === 'look')!.input).toMatchObject({ expectedWorldSessionId: f.world.sessionId, controlSessionId: f.receipts[0].controlSessionId, sequence: 1 })
  expect(f.game.view().lastAction).toMatchObject({ kind: 'look', status: 'succeeded' }); expect(f.game.view().actionsUsed).toBe(1)
})
it('does not claim a turn from an echo acknowledgement or fight active navigation', async () => {
  const f = fixture(); await f.start(); f.setLookApplied(false)
  await expect(f.game.tool('minecraft_look', { yaw: -90, pitch: 20 }, signal())).rejects.toThrow()
  expect(f.game.view()).toMatchObject({ status: 'failed', stopVerified: true, lastAction: { kind: 'look', status: 'unknown' } })
  const moving = fixture(); await moving.start(); await moving.game.tool('minecraft_navigate', { x: 3, y: 64, z: 0 }, signal())
  await expect(moving.game.tool('minecraft_look', { yaw: 90, pitch: 0 }, signal())).rejects.toThrow()
  expect(moving.calls.some((call) => call.name === 'look')).toBe(false)
})
it('hides optional capabilities unless the approved endpoint has qualified schemas', async () => {
  const f = fixture(); f.protocol.allows = (name) => !['get_inventory', 'describe_scene', 'look'].includes(name); await f.start()
  expect(f.game.view().features).toEqual([])
  await expect(f.game.tool('minecraft_inventory', {}, signal())).rejects.toThrow()
  expect(f.calls.some((call) => call.name === 'get_inventory')).toBe(false)
})
it('accepts explicit false consent fields and refuses features that are not implemented yet', async () => {
  const f = fixture(); await f.start({ radiusBlocks: 8, durationMs: 60000, allowChat: true, allowScreenshots: false, allowMining: false })
  expect(f.game.view().status).toBe('playing')
  for (const field of ['allowScreenshots', 'allowMining']) {
    const other = fixture(); await other.start({ radiusBlocks: 8, durationMs: 60000, allowChat: true, [field]: true })
    expect(other.game.view().status).toBe('failed'); expect(other.receipts).toHaveLength(0)
  }
})
it('rejects an older inventory sample even if its world stamp is still valid', async () => {
  const f = fixture(); const original = f.protocol.call; let tick = 50
  f.protocol.call = async (name, input, signal) => name === 'get_inventory'
    ? { source: 'client-player', sourceTick: tick, dimension: f.world.dimension, selectedSlot: 0, storageSlots: 36, emptyStorageSlots: 36, hotbar: [], main: [], armor: [], offhand: { empty: true }, worldSession: { ...f.world } }
    : original(name, input, signal)
  await f.start(); expect(await f.game.tool('minecraft_inventory', {}, signal())).toMatchObject({ sourceTick: 50 })
  tick = 49; await expect(f.game.tool('minecraft_inventory', {}, signal())).rejects.toThrow(); expect(f.game.view().stopVerified).toBe(true)
})
it('uses owned short navigation and never calls started an arrival', async () => {
  const f = fixture(); await f.start(); expect(f.game.view().status).toBe('playing')
  expect(await f.game.tool('minecraft_navigate', { x: 3, y: 64, z: 0 }, signal())).toEqual({ started: true, arrived: false })
  expect(f.calls.find((call) => call.name === 'navigate_to')!.input).toMatchObject({ expectedWorldSessionId: f.world.sessionId, controlSessionId: f.receipts[0].controlSessionId, sequence: 1, timeoutSeconds: 8, sprint: false })
  expect(await f.game.tool('minecraft_navigation_status', {}, signal())).toMatchObject({ active: true, arrived: false })
  f.finish(); expect(await f.game.tool('minecraft_navigation_status', {}, signal())).toMatchObject({ arrived: false }); f.player.x = 3
  expect(await f.game.tool('minecraft_navigation_status', {}, signal())).toMatchObject({ arrived: true }); expect(f.game.view().lastAction?.status).toBe('succeeded')
  f.setBlocked(true); await f.game.idle(); expect(f.game.view()).toMatchObject({ status: 'idle', stopVerified: true }); expect(f.calls.some((call) => call.name.startsWith('stop_'))).toBe(false)
  expect(f.calls.findLast((call) => call.name === 'release_control_session')?.input.controlSessionId).toBe(f.receipts[0].controlSessionId)
})
it('refuses out-of-radius navigation and command-shaped or private chat without effects', async () => {
  for (const [name, input] of [['minecraft_navigate', { x: 9, y: 64, z: 0 }], ...['/give @s diamond', '／tp 1 2 3', '\u200b/help', 'hello\nworld', 'PRIVATE'].map((message) => ['minecraft_chat', { message }])] as [string, Record<string, unknown>][]) {
    const f = fixture(); await f.start(); await expect(f.game.tool(name, input, signal())).rejects.toThrow('MINECRAFT_TOOL_FAILED'); expect(f.calls.some((call) => call.name === 'navigate_to' || call.name === 'send_chat')).toBe(false); expect(f.game.view().stopVerified).toBe(true)
  }
})
it('starts from the event tail, deduplicates IDs/own echo, and reseeds a new event stream', async () => {
  const f = fixture(); await f.start(); const other = randomUUID()
  f.setEvents([{ id: 21, type: 'chat', data: { uuid: f.player.uuid, sender: 'self', text: 'echo' } }, { id: 22, type: 'chat', data: { uuid: other, sender: 'friend', text: 'PRIVATE hello' } }, { id: 22, type: 'chat', data: { uuid: other, sender: 'friend', text: 'PRIVATE hello' } }], 22)
  await f.game.poll(); await f.game.poll(); expect(f.seen).toEqual([{ id: 22, sender: 'friend', text: '[redacted] hello' }]); expect(f.game.view().chatSeen).toBe(1)
  f.newStream(); await f.game.poll(); await f.game.poll(); expect(f.calls.findLast((call) => call.name === 'poll_event_page')?.input.tail).toBe(true); expect(f.seen).toHaveLength(1)
})
it('invalidates late effects and requires an observed release before further rounds', async () => {
  const f = fixture(); await f.start(); let resolve!: (value: unknown) => void; f.setHang(new Promise((done) => { resolve = done }))
  const pending = f.game.tool('minecraft_navigate', { x: 1, y: 64, z: 0 }, signal()); const failed = expect(pending).rejects.toThrow()
  for (let index = 0; index < 20 && !f.calls.some((call) => call.name === 'navigate_to'); index++) await Promise.resolve()
  f.setReleaseFailure(true); await f.game.stop(); expect(f.game.view().stopVerified).toBe(false)
  resolve({ started: true, worldSession: f.world }); await failed; await f.start(); expect(f.game.view().status).toBe('failed')
  f.setReleaseFailure(false); f.send({ type: 'minecraft.check', serverId: 'game' }); await f.game.idle(); expect(f.game.view()).toMatchObject({ status: 'ready', stopVerified: true })
})
it('expires on unified clock and never reconnects or resumes an interrupted saved round', async () => {
  const f = fixture(); await f.start({ radiusBlocks: 8, durationMs: 1000, allowChat: false }); f.clock.advanceBy(1000); await f.game.idle(); expect(f.game.view()).toMatchObject({ status: 'idle', stopVerified: true })
  const saved = { ...f.receipts[0], status: 'started' as const, stopVerified: false }; const resumed = fixture(saved)
  expect(resumed.game.view()).toMatchObject({ status: 'paused', stopVerified: false }); expect(resumed.calls).toHaveLength(0)
  resumed.send({ type: 'minecraft.check', serverId: saved.serverId }); await resumed.game.idle(); expect(resumed.game.view()).toMatchObject({ status: 'ready', stopVerified: true })
})
it('bounds action attempts and stops when the world or observed radius changes', async () => {
  const f = fixture(); await f.start()
  for (let index = 0; index < 24; index++) expect(await f.game.tool('minecraft_chat', { message: 'synthetic ' + index }, signal())).toEqual({ sent: true })
  await expect(f.game.tool('minecraft_chat', { message: 'over budget' }, signal())).rejects.toThrow(); expect(f.calls.filter((call) => call.name === 'send_chat')).toHaveLength(24)
  const changed = fixture(); await changed.start(); changed.world.sessionId = randomUUID(); changed.world.revision++
  await expect(changed.game.tool('minecraft_observe', {}, signal())).rejects.toThrow(); expect(changed.game.view().stopVerified).toBe(true)
  const moved = fixture(); await moved.start(); moved.player.x = 9; await moved.game.poll(); expect(moved.game.view()).toMatchObject({ status: 'failed', stopVerified: true })
})
it('rejects missing world-binding schemas and public identifiers that overlap configuration secrets', async () => {
  const missing = fixture(); missing.protocol.allows = (_name, required) => !required?.includes('expectedWorldSessionId'); await missing.start(); expect(missing.game.view().status).toBe('failed'); expect(missing.receipts).toHaveLength(0)
  const privateId = fixture(); privateId.protocol.identifierAllowed = (value) => value !== privateId.player.uuid; await privateId.start(); expect(privateId.game.view().pilot).toBeUndefined(); expect(privateId.receipts).toHaveLength(0)
})
it('rejects private or unknown navigation states before any tool result can escape (#21)', async () => {
  for (const state of ['PRIVATE', 'Bearer synthetic-private', 'unsupported-state']) {
    const f = fixture(); const call = f.protocol.call
    f.protocol.call = async (name, input, signal) => name === 'navigation_status' ? { active: false, state, worldSession: f.world } : call(name, input, signal)
    await f.start(); await expect(f.game.tool('minecraft_navigation_status', {}, signal())).rejects.toThrow('MINECRAFT_TOOL_FAILED')
    expect(JSON.stringify(f.game.view())).not.toContain(state); expect(f.game.view().stopVerified).toBe(true)
  }
})
