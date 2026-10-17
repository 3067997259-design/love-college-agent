import { z } from 'zod'
import type { MinecraftFeature } from '../../shared'
import type { GameProtocol, GameWorld } from './protocol'
const number = z.number().finite()
const blockPosition = z.object({ x: number.int().min(-30000000).max(30000000), y: number.int().min(-4096).max(4096), z: number.int().min(-30000000).max(30000000) })
const vector = z.object({ x: number.min(-30000000).max(30000000), y: number.min(-4096).max(4096), z: number.min(-30000000).max(30000000) })
const registryId = z.string().max(128).regex(/^[a-z0-9_.-]+:[a-z0-9_./-]+$/)
const stack = z.object({ id: registryId, count: number.int().min(1).max(1024), damage: number.int().nonnegative().max(1000000000).optional(), maxDamage: number.int().positive().max(1000000000).optional() })
const item = z.union([z.object({ empty: z.literal(true) }), stack])
const face = z.enum(['up', 'down', 'north', 'south', 'east', 'west'])
const lookingAt = z.discriminatedUnion('type', [z.object({ type: z.literal('none') }),
  z.object({ type: z.literal('block'), id: registryId, pos: blockPosition, face, distance: number.nonnegative().max(128) }),
  z.object({ type: z.literal('entity'), id: registryId, uuid: z.string().uuid(), distance: number.nonnegative().max(128) })])
const ray = z.discriminatedUnion('hit', [z.object({ hit: z.literal(false), row: number.int().min(0).max(2), col: number.int().min(0).max(2) }),
  z.object({ hit: z.literal(true), id: registryId, pos: blockPosition, distance: number.nonnegative().max(16), row: number.int().min(0).max(2), col: number.int().min(0).max(2) })])

export function minecraftFeatures(protocol: GameProtocol): MinecraftFeature[] {
  const bound = ['expectedWorldSessionId']; const owned = [...bound, 'controlSessionId', 'sequence']
  const checks: [MinecraftFeature, string, string[]][] = [
    ['inventory', 'get_inventory', bound], ['scene', 'describe_scene', [...bound, 'maxDistance', 'rayColumns', 'rayRows']], ['look', 'look', [...owned, 'yaw', 'pitch']],
    ['screenshot', 'screenshot', bound],
  ]
  return checks.filter(([feature, name, fields]) => (feature !== 'screenshot' || !!protocol.image) && protocol.allows(name, fields)).map(([feature]) => feature)
}
/** Drop item names, lore, NBT and arbitrary strings before game model/journal access. */
export function inventoryObservation(value: unknown, world: GameWorld, protocol: GameProtocol) {
  const inventory = z.object({ source: z.literal('client-player'), sourceTick: number.int().nonnegative(), dimension: registryId,
    selectedSlot: number.int().min(0).max(8), hotbar: z.array(stack.extend({ slot: number.int().min(0).max(8) })).max(9),
    main: z.array(stack.extend({ slot: number.int().min(9).max(35) })).max(27), armor: z.array(stack.extend({ slot: z.enum(['head', 'chest', 'legs', 'feet']) })).max(4), offhand: item,
    emptyStorageSlots: number.int().min(0).max(36), storageSlots: number.int().min(1).max(36) }).parse(value)
  if (inventory.dimension !== world.dimension || inventory.emptyStorageSlots > inventory.storageSlots
    || inventory.hotbar.length + inventory.main.length !== inventory.storageSlots - inventory.emptyStorageSlots) throw new Error('GAME_INVALID_OBSERVATION')
  const rows = [...inventory.hotbar, ...inventory.main, ...inventory.armor]
  if (new Set(rows.map((row) => row.slot)).size !== rows.length || rows.some((row) => !protocol.identifierAllowed(row.id) || protocol.text(row.id) !== row.id || row.damage !== undefined && row.maxDamage !== undefined && row.damage > row.maxDamage)
    || 'id' in inventory.offhand && (!protocol.identifierAllowed(inventory.offhand.id) || protocol.text(inventory.offhand.id) !== inventory.offhand.id)) throw new Error('GAME_INVALID_OBSERVATION')
  return inventory
}
/** Native ray samples are observations, not screenshot-derived scene understanding. */
export function sceneObservation(value: unknown, world: GameWorld, protocol: GameProtocol, maxDistance: number) {
  const scene = z.object({ source: z.literal('client-vision'), sourceTick: number.int().nonnegative(), dimension: registryId,
    yaw: number.min(-3600000).max(3600000), pitch: number.min(-90).max(90), eye: vector, lookingAt, rays: z.array(ray).length(9) }).parse(value)
  if (scene.dimension !== world.dimension || new Set(scene.rays.map((item) => item.row * 3 + item.col)).size !== 9) throw new Error('GAME_INVALID_OBSERVATION')
  const hits = [scene.lookingAt, ...scene.rays].filter((hit) => 'id' in hit)
  if (hits.some((hit) => !('id' in hit) || !protocol.identifierAllowed(hit.id) || protocol.text(hit.id) !== hit.id)
    || scene.lookingAt.type === 'entity' && !protocol.identifierAllowed(scene.lookingAt.uuid)
    || scene.rays.some((hit) => hit.hit && (hit.distance > maxDistance || Math.hypot(hit.pos.x - scene.eye.x, hit.pos.y - scene.eye.y, hit.pos.z - scene.eye.z) > maxDistance + 2))) throw new Error('GAME_INVALID_OBSERVATION')
  return { ...scene, basis: 'native-crosshair-and-ray-grid' as const, screenshot: false, missingRaysProveEmptyTerrain: false }
}
