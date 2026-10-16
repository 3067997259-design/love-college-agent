import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

/** Owned synthetic world behind a real MCP transport. Never contacts or starts Minecraft. */
export function createMinecraftFixture() {
  const world = { instanceId: randomUUID(), sessionId: randomUUID(), revision: 1, connected: true, playerUuid: randomUUID(), dimension: 'minecraft:overworld' }
  const player = { uuid: world.playerUuid, name: 'SyntheticPilot', dimension: world.dimension, x: 0, y: 64, z: 0, alive: true }
  const streamId = randomUUID(); const other = randomUUID(); let cursor = 0; let owner: string | undefined; let target: { x: number; y: number; z: number } | undefined
  let scenario = 'ready'; const events: { id: number; type: string; data: { text: string; sender: string; uuid: string } }[] = []
  const binding = { expectedWorldSessionId: z.string().optional() }; const stamped = (value: Record<string, unknown>) => ({ ...value, worldSession: { ...world } })
  const names = ['get_status', 'list_capabilities', 'get_world_session', 'get_self', 'navigate_to', 'navigation_status', 'release_control_session', 'get_process_state', 'poll_event_page', 'send_chat']
  const install = (server: McpServer) => {
    const register = (name: string, shape: z.ZodRawShape, run: (input: Record<string, unknown>) => Record<string, unknown>) => {
      server.registerTool(name, { inputSchema: { ...binding, ...shape } }, async (input) => {
        if (input.expectedWorldSessionId !== undefined && input.expectedWorldSessionId !== world.sessionId) throw new Error('SYNTHETIC_WORLD_CHANGED')
        return { content: [{ type: 'text', text: JSON.stringify(run(input)) }] }
      })
    }
    register('get_status', {}, () => stamped({ mod: 'mcpfabric', side: 'client', serverPresent: true, integratedServer: true }))
    register('list_capabilities', {}, () => stamped({ groups: { command: scenario === 'unsafe', world_write: false, control: true, navigation: true, chat: true } }))
    register('get_world_session', {}, () => ({ ...world }))
    register('get_self', {}, () => stamped({ ...player }))
    register('navigate_to', { x: z.number(), y: z.number(), z: z.number(), reachRadius: z.number(), sprint: z.boolean(), timeoutSeconds: z.number(), commandId: z.string(), controlSessionId: z.string(), sequence: z.number() }, (input) => {
      if (scenario === 'unreachable') throw new Error('SYNTHETIC_UNREACHABLE')
      owner = String(input.controlSessionId); target = { x: Number(input.x), y: Number(input.y), z: Number(input.z) }; return stamped({ started: true })
    })
    register('navigation_status', {}, () => { if (target) { Object.assign(player, target); target = undefined }; return stamped({ active: false, state: 'done' }) })
    register('release_control_session', { controlSessionId: z.string() }, (input) => { const released = !owner || owner === input.controlSessionId; if (released) { owner = undefined; target = undefined }; return stamped({ released, controlSessionId: input.controlSessionId, reason: released ? 'released' : 'control_owner_replaced' }) })
    register('get_process_state', { controlSessionId: z.string() }, (input) => stamped({ owned: owner === input.controlSessionId, controlSessionId: input.controlSessionId, playerUuid: player.uuid, source: 'client-process' }))
    register('poll_event_page', { sinceId: z.number().optional(), tail: z.boolean(), limit: z.number().int().min(1).max(16), types: z.array(z.string()) }, (input) => stamped({ streamId, cursor, gap: false, events: input.tail ? [] : events.filter((event) => event.id > Number(input.sinceId ?? 0)).slice(0, Number(input.limit)) }))
    register('send_chat', { message: z.string() }, (input) => { if (String(input.message).startsWith('/')) throw new Error('SYNTHETIC_COMMAND_REJECTED'); events.push({ id: ++cursor, type: 'chat', data: { text: String(input.message), sender: player.name, uuid: player.uuid } }); return stamped({ sent: true, asCommand: false }) })
  }
  return { names, install, select: (value: 'ready' | 'chat' | 'world-change' | 'unsafe' | 'unreachable') => {
    scenario = value
    if (value === 'chat') events.push({ id: ++cursor, type: 'chat', data: { text: 'SYNTHETIC_GAME_CHAT_ONLY', sender: 'SyntheticFriend', uuid: other } })
    if (value === 'world-change') { world.sessionId = randomUUID(); world.revision++; world.dimension = 'minecraft:the_nether'; player.dimension = world.dimension }
  } }
}
