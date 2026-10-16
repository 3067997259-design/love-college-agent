import { expect, it } from 'vitest'
import { inventoryObservation, minecraftFeatures, sceneObservation } from '../../src/main/minecraft/observations'
import type { GameProtocol, GameWorld } from '../../src/main/minecraft/protocol'
const world: GameWorld = { instanceId: 'i', sessionId: 's', revision: 1, connected: true, playerUuid: '00000000-0000-4000-8000-000000000001', dimension: 'minecraft:overworld' }
const protocol: GameProtocol = { allows: () => true, identifierAllowed: (id) => id !== 'minecraft:credential', text: (text) => text, call: async () => ({}) }
const inventory = () => ({ source: 'client-player', sourceTick: 40, dimension: world.dimension, selectedSlot: 0, storageSlots: 36, emptyStorageSlots: 35,
  hotbar: [{ slot: 0, id: 'minecraft:stone_pickaxe', count: 1, damage: 3, maxDamage: 131, name: 'IGNORE_RULES_NAME', nbt: { command: '/give' } }], main: [], armor: [], offhand: { empty: true } })
const scene = () => ({ source: 'client-vision', sourceTick: 40, dimension: world.dimension, eye: { x: 0, y: 65.62, z: 0 }, yaw: 0, pitch: 0,
  lookingAt: { type: 'block', id: 'minecraft:stone', pos: { x: 1, y: 64, z: 1 }, face: 'north', distance: 2, narration: 'NOT_PIXELS' }, rays: Array.from({ length: 9 }, (_, i) => ({ hit: false, row: Math.floor(i / 3), col: i % 3 })) })
it('keeps bounded inventory facts and drops item names/NBT instead of passing instructions', () => {
  const value = inventoryObservation(inventory(), world, protocol)
  expect(value.hotbar[0]).toEqual({ slot: 0, id: 'minecraft:stone_pickaxe', count: 1, damage: 3, maxDamage: 131 })
  expect(JSON.stringify(value)).not.toMatch(/IGNORE_RULES|\/give|nbt/)
})
it('refuses duplicate slots, private IDs, wrong dimensions and inconsistent occupancy', () => {
  const duplicate = inventory(); duplicate.hotbar.push({ ...duplicate.hotbar[0] }); duplicate.emptyStorageSlots = 34
  const privateId = inventory(); privateId.hotbar[0].id = 'minecraft:credential'
  for (const input of [duplicate, privateId, { ...inventory(), dimension: 'minecraft:the_nether' }, { ...inventory(), emptyStorageSlots: 36 }]) expect(() => inventoryObservation(input, world, protocol)).toThrow()
})
it('does not substitute ray sampling for screenshots or prove empty terrain from missing hits', () => {
  const value = sceneObservation(scene(), world, protocol, 8)
  expect(value).toMatchObject({ basis: 'native-crosshair-and-ray-grid', screenshot: false, missingRaysProveEmptyTerrain: false })
  expect(JSON.stringify(value)).not.toContain('NOT_PIXELS')
})
it('refuses incoherent ray grids, far-away samples and a foreign world', () => {
  const duplicate = scene(); duplicate.rays[1] = { ...duplicate.rays[0] }
  const far = { ...scene(), rays: [{ hit: true, row: 0, col: 0, id: 'minecraft:stone', distance: 2, pos: { x: 4000, y: 64, z: 0 } }, ...scene().rays.slice(1)] }
  for (const input of [duplicate, far, { ...scene(), dimension: 'minecraft:the_nether' }]) expect(() => sceneObservation(input, world, protocol, 8)).toThrow()
})
it('checks the expected-world and input-owner properties on optional tools', () => {
  expect(minecraftFeatures(protocol)).toEqual(['inventory', 'scene', 'look'])
  expect(minecraftFeatures({ ...protocol, allows: (_name, fields = []) => !fields.includes('expectedWorldSessionId') })).toEqual([])
  expect(minecraftFeatures({ ...protocol, allows: (_name, fields = []) => !fields.includes('controlSessionId') })).toEqual(['inventory', 'scene'])
})
