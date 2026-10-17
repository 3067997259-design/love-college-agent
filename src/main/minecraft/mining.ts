import { z } from 'zod'
import type { GameProtocol, GameWorld } from './protocol'

// The booth round authorizes small nearby play, not arbitrary dismantling or containers.
export const mineableBlocks = ['minecraft:dirt', 'minecraft:grass_block', 'minecraft:stone', 'minecraft:cobblestone'] as const
export const miningTarget = z.strictObject({ x: z.number().int(), y: z.number().int(), z: z.number().int(), expectedBlockId: z.enum(mineableBlocks) })
export function harvestObservation(value: unknown, target: z.infer<typeof miningTarget>, world: GameWorld, protocol: GameProtocol) {
  const result = z.object({ x: z.literal(target.x), y: z.literal(target.y), z: z.literal(target.z), dimension: z.literal(world.dimension), playerUuid: z.literal(world.playerUuid),
    blockStateId: z.string().regex(/^[a-z0-9_.-]+:[a-z0-9_./-]+$/).max(128), air: z.boolean(), harvestEligible: z.boolean(), estimateQuality: z.enum(['exact', 'approximate', 'unknown']),
    estimatedTicks: z.number().int().positive().max(100000).optional(), hazards: z.array(z.enum(['falling-sand', 'ceiling-collapse', 'fluids', 'nearby-danger', 'self-support'])).max(5),
    unmet: z.array(z.enum(['no_tool', 'tool_level_too_low', 'unbreakable', 'inventory_full', 'data_unavailable'])).max(5) }).parse(value)
  if (!protocol.identifierAllowed(result.blockStateId) || protocol.text(result.blockStateId) !== result.blockStateId || result.air !== (result.blockStateId === 'minecraft:air')) throw new Error('GAME_INVALID_HARVEST')
  return result
}
