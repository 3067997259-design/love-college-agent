import { z } from 'zod'
import type { McpConnection } from '../mcp/connection'
export type GameProtocol = Omit<McpConnection['protocol'], 'image'> & Partial<Pick<McpConnection['protocol'], 'image'>>
const id = z.string().min(1).max(128)
export const worldSchema = z.object({ instanceId: id, sessionId: id, revision: z.number().int().nonnegative(), connected: z.literal(true),
  playerUuid: z.string().uuid(), dimension: z.string().regex(/^[a-z0-9_.-]+:[a-z0-9_./-]+$/i) })
export type GameWorld = z.infer<typeof worldSchema>
const position = { x: z.number().finite().min(-30_000_000).max(30_000_000), y: z.number().finite().min(-4096).max(4096), z: z.number().finite().min(-30_000_000).max(30_000_000) }
export const playerSchema = z.object({ uuid: z.string().uuid(), name: z.string().min(1).max(32), dimension: worldSchema.shape.dimension, ...position, alive: z.literal(true),
  yaw: z.number().finite().min(-3600000).max(3600000).optional(), pitch: z.number().finite().min(-90).max(90).optional() })
export type GamePlayer = z.infer<typeof playerSchema>
export const sameWorld = (a: GameWorld, b: GameWorld) => a.instanceId === b.instanceId && a.sessionId === b.sessionId && a.revision === b.revision && a.playerUuid === b.playerUuid && a.dimension === b.dimension
export function checkedWorld(value: unknown, protocol: GameProtocol) {
  const world = worldSchema.parse(value)
  if (![world.instanceId, world.sessionId, world.playerUuid, world.dimension].every(protocol.identifierAllowed)) throw new Error('GAME_INVALID')
  return world
}
export function checkedPlayer(value: unknown, world: GameWorld, protocol: GameProtocol) {
  const player = playerSchema.parse(value)
  if (player.uuid !== world.playerUuid || player.dimension !== world.dimension || !protocol.identifierAllowed(player.uuid) || protocol.text(player.name) !== player.name || /[\r\n\0]/.test(player.name)) throw new Error('GAME_INVALID')
  return player
}
export function checkedStamp(value: unknown, world: GameWorld, protocol: GameProtocol) {
  const stamp = checkedWorld(z.object({ worldSession: z.unknown() }).parse(value).worldSession, protocol)
  if (!sameWorld(stamp, world)) throw new Error('GAME_WORLD_CHANGED')
}
export function checkToolset(protocol: GameProtocol) {
  const required: [string, string[]][] = [
    ['get_status', []], ['list_capabilities', []], ['get_world_session', []], ['get_self', ['expectedWorldSessionId']],
    ['navigate_to', ['expectedWorldSessionId', 'controlSessionId', 'sequence', 'commandId', 'timeoutSeconds']],
    ['navigation_status', ['expectedWorldSessionId']], ['release_control_session', ['expectedWorldSessionId', 'controlSessionId']],
    ['get_process_state', ['expectedWorldSessionId', 'controlSessionId']], ['poll_event_page', ['expectedWorldSessionId', 'tail', 'sinceId', 'limit', 'types']],
  ]
  if (required.some(([name, fields]) => !protocol.allows(name, fields))) throw new Error('GAME_UNSUPPORTED')
}
export async function checkedPermissions(protocol: GameProtocol, signal: AbortSignal) {
  const status = z.object({ mod: z.literal('mcpfabric'), side: z.literal('client'), serverPresent: z.boolean(), integratedServer: z.boolean() }).parse(await protocol.call('get_status', {}, signal))
  if (!status.serverPresent && !status.integratedServer) throw new Error('GAME_UNSUPPORTED')
  z.object({ groups: z.object({ command: z.literal(false), world_write: z.literal(false), control: z.literal(true), navigation: z.literal(true) }) }).parse(await protocol.call('list_capabilities', {}, signal))
}
