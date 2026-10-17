import { expect, it } from 'vitest'
import { checkedScreenshot } from '../../src/main/minecraft/screenshot'
import { syntheticGamePng } from '../../src/main/minecraft/fixture-image'
import { imageSize } from '../../src/main/model/image-size'
import type { GameProtocol, GameWorld } from '../../src/main/minecraft/protocol'

const world: GameWorld = { instanceId: 'i', sessionId: 's', revision: 1, connected: true, playerUuid: '00000000-0000-4000-8000-000000000001', dimension: 'minecraft:overworld' }
const protocol: GameProtocol = { allows: () => true, identifierAllowed: () => true, text: (text) => text, call: async () => ({}) }
const fixture = () => { const png = syntheticGamePng(); return { data: png.toString('base64'), mimeType: 'image/png' as const, metadata: { worldSession: { ...world }, format: 'png', source: 'client-framebuffer', sourceTickStart: 20, sourceTick: 21, playerUuid: world.playerUuid, dimension: world.dimension, width: 16, height: 12, bytes: png.length, prose: 'NOT_A_VISUAL_SUBSTITUTE' } } }
it('keeps only closed framebuffer metadata and checks the actual PNG before decoding', () => {
  const frame = checkedScreenshot(fixture(), world, protocol)
  expect(imageSize(frame.png, 'png')).toEqual({ width: 16, height: 12 })
  expect(JSON.stringify(frame.metadata)).not.toContain('NOT_A_VISUAL_SUBSTITUTE')
})
it.each(['world', 'player', 'dimension', 'source', 'time', 'size', 'bytes', 'base64', 'pixel-bomb'] as const)('refuses %s screenshot mismatches before any decoder', (kind) => {
  const frame = fixture()
  if (kind === 'world') frame.metadata.worldSession.revision++
  if (kind === 'player') frame.metadata.playerUuid = '00000000-0000-4000-8000-000000000002'
  if (kind === 'dimension') frame.metadata.dimension = 'minecraft:the_nether'
  if (kind === 'source') frame.metadata.source = 'server-scene-description'
  if (kind === 'time') frame.metadata.sourceTickStart = 22
  if (kind === 'size') frame.metadata.width++
  if (kind === 'bytes') frame.metadata.bytes++
  if (kind === 'base64') frame.data = frame.data.slice(0, -2) + '==='
  if (kind === 'pixel-bomb') { const bytes = Buffer.from(frame.data, 'base64'); bytes.writeUInt32BE(0xffffffff, 16); frame.data = bytes.toString('base64') }
  expect(() => checkedScreenshot(frame, world, protocol)).toThrow()
})
it('parses bounded JPEG dimensions and refuses malformed marker lengths or non-images', () => {
  const jpeg = Buffer.from('ffd8ffe000040000ffc0000808000c001003ffd9', 'hex')
  expect(imageSize(jpeg, 'jpeg')).toEqual({ width: 16, height: 12 })
  for (const bytes of [Buffer.alloc(10), jpeg.subarray(0, 10), Buffer.from('ffd8ffe0ffff0000ffd9', 'hex')]) expect(() => imageSize(bytes, 'jpeg')).toThrow()
})
