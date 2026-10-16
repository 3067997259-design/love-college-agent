import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { AppCommand, MinecraftView, PublicErrorCode } from '../../shared'
import type { Clock } from '../clock'
import type { Scheduler } from '../scheduler'
import { checkedPermissions, checkedPlayer, checkedStamp, checkedWorld, checkToolset, sameWorld, type GameProtocol, type GameWorld, type GamePlayer } from './protocol'

export const minecraftScopeSchema = z.strictObject({ radiusBlocks: z.number().int().min(1).max(16), durationMs: z.number().int().min(1000).max(600_000), allowChat: z.boolean() })
const targetSchema = z.strictObject({ x: z.number().int(), y: z.number().int(), z: z.number().int() })
const chatSchema = z.strictObject({ message: z.string().trim().min(1).max(160).refine((text) => !/^[／/]/.test(text.normalize('NFKC')) && !/[\p{Cc}\p{Cf}]/u.test(text)) })
const empty = z.strictObject({})
// Closed states observed in the pinned mcpfabric source; unknown protocol text never reaches a journal.
const navigationState = z.enum(['idle', 'navigating', 'reached', 'deadline', 'path_exhausted', 'cancelled', 'reflex_preempted', 'disconnected', 'world_exit', 'death', 'bridge_timeout', 'world_session_changed'])
const distance = (a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)
type Lease = { serverId: string; controlSessionId: string }
export interface GameReceipt { roundId: string; serverId: string; controlSessionId: string; status: 'started' | 'stopped'; stopVerified: boolean }
/** Main-only bounded game controller. No generic MCP, user files, school context or credential fields
 * enter its output. A cancelled RPC is not proof that native input has been released.
 */
export function createMinecraft(options: { clock: Clock; scheduler: Scheduler; protocol(serverId: string): GameProtocol | undefined;
  source(serverId: string): 'real' | 'fake' | 'none'; blocked(): boolean; changed(): void;
  available?(): boolean; stopping?(): void;
  record?(receipt: GameReceipt): void; interrupted?: GameReceipt; events?(messages: readonly { id: number; text: string; sender: string }[]): void }) {
  const { clock, scheduler } = options
  const state: MinecraftView = { status: options.interrupted && !options.interrupted.stopVerified ? 'paused' : 'idle', source: 'none', serverId: options.interrupted?.serverId ?? null, roundId: options.interrupted?.roundId ?? null, endsAtMs: null, actionsUsed: 0, maxActions: 24, chatSeen: 0, stopVerified: !options.interrupted || options.interrupted.stopVerified }
  let bound: GameWorld | undefined; let player: GamePlayer | undefined; let anchor: GamePlayer | undefined
  let lease: Lease | undefined = options.interrupted && !options.interrupted.stopVerified ? { serverId: options.interrupted.serverId, controlSessionId: options.interrupted.controlSessionId } : undefined
  let sequence = 0; let reads = 0; let polls = 0; let stream: string | undefined; let cursor: number | undefined; let target: z.infer<typeof targetSchema> | undefined
  let generation = 0; let active: AbortController | undefined; let worker: Promise<void> | undefined; let polling = false; let closed = false
  let stopJob: Promise<void> | undefined
  let toolRunning = false
  const publish = () => options.changed()
  const fail = (code: PublicErrorCode = 'unavailable') => { state.status = 'failed'; state.error = { code, retryable: true }; publish() }
  const port = (serverId = state.serverId) => { const protocol = serverId ? options.protocol(serverId) : undefined; if (!protocol) throw new Error('GAME_UNAVAILABLE'); return protocol }
  const pilot = () => player ? { uuid: player.uuid, name: player.name, dimension: player.dimension, position: { x: player.x, y: player.y, z: player.z } } : undefined
  const live = (ticket: number) => { if (closed || generation !== ticket || state.status !== 'playing' || options.blocked() || clock.nowMs() >= (state.endsAtMs ?? 0)) throw new Error('GAME_STOPPED') }
  const rpc = async (name: string, input: Record<string, unknown>, signal: AbortSignal, ticket: number) => {
    live(ticket); signal.throwIfAborted(); if (++reads > 360) throw new Error('GAME_READ_BUDGET')
    const protocol = port(); const value = await protocol.call(name, { ...input, expectedWorldSessionId: bound!.sessionId }, signal)
    live(ticket); signal.throwIfAborted(); checkedStamp(value, bound!, protocol); return value
  }
  const verifyPlayer = async (signal: AbortSignal, ticket: number) => {
    const current = checkedPlayer(await rpc('get_self', {}, signal, ticket), bound!, port())
    if (!anchor || distance(current, anchor) > state.scope!.radiusBlocks) throw new Error('GAME_OUT_OF_SCOPE')
    player = current; state.pilot = pilot(); return current
  }
  const permissions = async (signal: AbortSignal, ticket: number) => {
    live(ticket); if ((reads += 2) > 360) throw new Error('GAME_READ_BUDGET')
    await checkedPermissions(port(), signal); live(ticket); signal.throwIfAborted()
  }
  const release = async () => {
    if (!lease) return true
    const cleanup = new AbortController(); const cancel = clock.after(10_000, () => cleanup.abort())
    try {
      const protocol = port(lease.serverId); const world = checkedWorld(await protocol.call('get_world_session', {}, cleanup.signal), protocol)
      const args = { controlSessionId: lease.controlSessionId, expectedWorldSessionId: world.sessionId }
      const released = await protocol.call('release_control_session', args, cleanup.signal); cleanup.signal.throwIfAborted(); checkedStamp(released, world, protocol)
      z.object({ released: z.boolean(), controlSessionId: z.literal(lease.controlSessionId) }).parse(released)
      const process = await protocol.call('get_process_state', args, cleanup.signal); cleanup.signal.throwIfAborted(); checkedStamp(process, world, protocol)
      z.object({ owned: z.literal(false), controlSessionId: z.literal(lease.controlSessionId), source: z.literal('client-process') }).parse(process)
      lease = undefined; return true
    } catch { return false } finally { cancel() }
  }
  const stop = () => {
    if (stopJob) return stopJob
    if (!lease && state.status !== 'playing' && state.status !== 'checking') return Promise.resolve()
    generation++; active?.abort(); options.stopping?.(); scheduler.cancel('minecraft.poll'); scheduler.cancel('minecraft.expire')
    const id = state.roundId; const oldLease = lease; state.status = 'stopping'; publish()
    stopJob = (async () => {
      state.stopVerified = await release(); state.status = state.stopVerified ? 'idle' : 'failed'; state.endsAtMs = null
      if (state.lastAction?.status === 'running') state.lastAction = { ...state.lastAction, status: state.stopVerified ? 'cancelled' : 'unknown' }
      if (!state.stopVerified) state.error = { code: 'unavailable', retryable: true }
      if (id && oldLease) options.record?.({ roundId: id, ...oldLease, status: 'stopped', stopVerified: state.stopVerified })
      publish()
    })().finally(() => { stopJob = undefined }); return stopJob
  }
  const inspect = async (serverId: string, signal: AbortSignal) => {
    const protocol = port(serverId); checkToolset(protocol); await checkedPermissions(protocol, signal)
    const world = checkedWorld(await protocol.call('get_world_session', {}, signal), protocol)
    const self = await protocol.call('get_self', { expectedWorldSessionId: world.sessionId }, signal); checkedStamp(self, world, protocol)
    const current = checkedPlayer(self, world, protocol)
    const again = checkedWorld(await protocol.call('get_world_session', {}, signal), protocol)
    if (!sameWorld(again, world)) throw new Error('GAME_WORLD_CHANGED')
    return { world, current }
  }
  const poll = async (tail = false) => {
    if (polling || state.status !== 'playing') return
    const ticket = generation; const signal = active!.signal; polling = true
    try {
      if (++polls > 120) throw new Error('GAME_POLL_BUDGET')
      await verifyPlayer(signal, ticket)
      await permissions(signal, ticket)
      const result = await rpc('poll_event_page', { ...(cursor === undefined ? {} : { sinceId: cursor }), tail: tail || cursor === undefined, limit: 16, types: ['chat'] }, signal, ticket)
      const page = z.object({ streamId: z.string().min(1).max(128), cursor: z.number().int().nonnegative(), gap: z.boolean(), events: z.array(z.object({ id: z.number().int().nonnegative(), type: z.string(), data: z.unknown() })).max(16) }).parse(result)
      if (!port().identifierAllowed(page.streamId) || cursor !== undefined && stream === page.streamId && page.cursor < cursor) throw new Error('GAME_INVALID')
      if (stream !== undefined && (stream !== page.streamId || page.gap)) { stream = page.streamId; cursor = undefined; return }
      const previous = cursor; stream = page.streamId; cursor = page.cursor
      if (tail || previous === undefined) return
      const messages = page.events.filter((event) => event.id > previous && event.id <= page.cursor && event.type === 'chat').flatMap((event) => {
        const parsed = z.object({ text: z.string().min(1).max(500), sender: z.string().max(32), uuid: z.string().uuid() }).safeParse(event.data)
        if (!parsed.success || parsed.data.uuid === player!.uuid || !port().identifierAllowed(parsed.data.uuid)) return []
        return [{ id: event.id, text: port().text(parsed.data.text), sender: port().text(parsed.data.sender) }]
      })
      const unique = [...new Map(messages.map((item) => [item.id, item])).values()]
      state.chatSeen += unique.length; if (unique.length) options.events?.(unique); publish()
    } catch { if (generation === ticket) { await stop(); fail() } } finally { polling = false }
  }
  const begin = (command: Extract<AppCommand, { type: 'minecraft.check' | 'minecraft.start' }>) => {
    if (closed || worker || stopJob || state.status === 'playing' || options.blocked() || options.available?.() === false) return 'unavailable' as const
    if (lease && lease.serverId !== command.serverId) return 'unavailable' as const
    const ticket = ++generation; const abort = new AbortController(); active = abort; state.status = 'checking'; state.serverId = command.serverId; delete state.error; publish()
    worker = (async () => {
      const cancel = clock.after(30_000, () => abort.abort())
      try {
        if (lease) {
          const prior = lease; const priorId = state.roundId
          if (!await release()) throw new Error('GAME_RELEASE_UNKNOWN')
          if (priorId) options.record?.({ roundId: priorId, ...prior, status: 'stopped', stopVerified: true })
        }
        const inspected = await inspect(command.serverId, abort.signal); abort.signal.throwIfAborted()
        if (generation !== ticket || options.blocked() || closed) throw new Error('GAME_STOPPED')
        bound = inspected.world; player = inspected.current; state.source = options.source(command.serverId); state.pilot = pilot(); state.stopVerified = true
        state.checks = { commandsDisabled: true, worldWriteDisabled: true, worldBound: true }
        if (command.type === 'minecraft.check') { state.status = 'ready'; state.roundId = null; state.endsAtMs = null; delete state.scope; publish(); return }
        const scope = minecraftScopeSchema.parse(command.scope)
        if (command.expectedPlayerUuid !== player.uuid || scope.allowChat && !port().allows('send_chat', ['expectedWorldSessionId'])) throw new Error('GAME_PILOT_CHANGED')
        anchor = player; sequence = 0; reads = 0; polls = 0; stream = undefined; cursor = undefined; target = undefined
        state.scope = scope; state.roundId = randomUUID(); state.endsAtMs = clock.nowMs() + scope.durationMs; state.actionsUsed = 0; state.chatSeen = 0; delete state.lastAction
        lease = { serverId: command.serverId, controlSessionId: randomUUID() }; state.stopVerified = false
        options.record?.({ roundId: state.roundId, ...lease, status: 'started', stopVerified: false })
        state.status = 'playing'; publish(); scheduler.schedule('minecraft.expire', state.endsAtMs, () => { void stop() })
        await poll(true); if (generation === ticket && state.status === 'playing') scheduler.schedule('minecraft.poll', clock.nowMs() + 5000, () => { void poll() }, { everyMs: 5000 })
      } catch { if (generation === ticket) { await stop(); fail('permission-denied') } } finally { cancel() }
    })().finally(() => { worker = undefined; publish() }); return undefined
  }
  const tool = async (name: string, input: Record<string, unknown>, parent: AbortSignal): Promise<Record<string, unknown>> => {
    if (toolRunning) throw new Error('MINECRAFT_TOOL_BUSY')
    const ticket = generation; live(ticket); const signal = AbortSignal.any([parent, active!.signal]); const abort = new AbortController(); const combined = AbortSignal.any([signal, abort.signal]); const cancel = clock.after(12_000, () => abort.abort())
    toolRunning = true
    try {
      if (name === 'minecraft_observe') { empty.parse(input); const current = await verifyPlayer(combined, ticket); return { pilot: { uuid: current.uuid, name: current.name, dimension: current.dimension, position: { x: current.x, y: current.y, z: current.z } }, scope: state.scope!, actionsRemaining: state.maxActions - state.actionsUsed, endsAtMs: state.endsAtMs } }
      if (name === 'minecraft_navigation_status') {
        empty.parse(input)
        if (target) z.object({ owned: z.literal(true), controlSessionId: z.literal(lease!.controlSessionId), source: z.literal('client-process') }).parse(await rpc('get_process_state', { controlSessionId: lease!.controlSessionId }, combined, ticket))
        const result = z.object({ active: z.boolean(), state: navigationState }).parse(await rpc('navigation_status', {}, combined, ticket))
        if (port().text(result.state) !== result.state) throw new Error('GAME_INVALID')
        const current = await verifyPlayer(combined, ticket)
        const arrived = !!target && !result.active && distance(current, target) <= 1.5
        if (target) state.lastAction = { kind: 'navigate', status: result.active ? 'running' : arrived ? 'succeeded' : 'failed', atMs: clock.nowMs() }; publish()
        return { active: result.active, arrived, status: result.state, position: { x: current.x, y: current.y, z: current.z } }
      }
      if (name !== 'minecraft_navigate' && name !== 'minecraft_chat') throw new Error('GAME_UNKNOWN_TOOL')
      if (state.actionsUsed >= state.maxActions) throw new Error('GAME_ACTION_BUDGET')
      const destination = name === 'minecraft_navigate' ? targetSchema.parse(input) : undefined
      const chat = name === 'minecraft_chat' ? chatSchema.parse(input) : undefined
      if (destination && (!anchor || distance(destination, anchor) > state.scope!.radiusBlocks || Math.abs(destination.y - anchor.y) > 4) || chat && (!state.scope!.allowChat || port().text(chat.message) !== chat.message)) throw new Error('GAME_OUT_OF_SCOPE')
      await verifyPlayer(combined, ticket); await permissions(combined, ticket)
      state.actionsUsed++; const kind = destination ? 'navigate' : 'chat'; state.lastAction = { kind, status: 'running', atMs: clock.nowMs() }; publish()
      if (destination) {
        target = destination
        const result = await rpc('navigate_to', { ...destination, reachRadius: 1, sprint: false, timeoutSeconds: 8, commandId: randomUUID(), controlSessionId: lease!.controlSessionId, sequence: ++sequence }, combined, ticket)
        z.object({ started: z.literal(true) }).parse(result); return { started: true, arrived: false }
      }
      const result = await rpc('send_chat', { message: chat!.message }, combined, ticket)
      z.object({ sent: z.literal(true) }).parse(result); state.lastAction = { kind: 'chat', status: 'succeeded', atMs: clock.nowMs() }; publish(); return { sent: true }
    } catch { if (generation === ticket) { if (state.lastAction?.status === 'running') state.lastAction.status = 'unknown'; await stop(); fail() }; throw new Error('MINECRAFT_TOOL_FAILED') }
    finally { toolRunning = false; cancel() }
  }
  return { view: () => structuredClone(state), active: () => state.status === 'playing' || state.status === 'checking' || state.status === 'stopping', tool,
    poll, stop, stateChanged: () => { if ((state.status === 'playing' || state.status === 'checking') && options.blocked()) void stop() },
    dispatch: (command: AppCommand): PublicErrorCode | undefined => {
      if (command.type === 'minecraft.stop') { void stop(); return }
      if (command.type === 'minecraft.check' || command.type === 'minecraft.start') return begin(command)
      return 'invalid-command'
    },
    idle: async () => { await worker; await stopJob },
    close: async () => { closed = true; await stop(); await worker },
  }
}
export type MinecraftService = ReturnType<typeof createMinecraft>
