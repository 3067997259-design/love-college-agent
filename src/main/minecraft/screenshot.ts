import { z } from 'zod'
import type { GameProtocol, GameWorld } from './protocol'
import { checkedStamp } from './protocol'
import { imageSize } from '../model/image-size'

export function checkedScreenshot(value: { metadata: Record<string, unknown>; data: string; mimeType: 'image/png' }, world: GameWorld, protocol: GameProtocol) {
  checkedStamp(value.metadata, world, protocol)
  const metadata = z.object({ format: z.literal('png'), source: z.literal('client-framebuffer'),
    width: z.number().int().min(1).max(4096), height: z.number().int().min(1).max(2304), bytes: z.number().int().min(33).max(6_291_456),
    sourceTickStart: z.number().int().nonnegative(), sourceTick: z.number().int().nonnegative(), playerUuid: z.literal(world.playerUuid), dimension: z.literal(world.dimension) }).parse(value.metadata)
  if (metadata.sourceTick < metadata.sourceTickStart || metadata.sourceTick - metadata.sourceTickStart > 100 || value.data.length > 8_388_608 || value.data.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value.data)) throw new Error('GAME_INVALID_SCREENSHOT')
  const png = Buffer.from(value.data, 'base64'); const size = imageSize(png, 'png')
  if (png.toString('base64') !== value.data || png.length !== metadata.bytes || size.width !== metadata.width || size.height !== metadata.height || metadata.width * metadata.height > 9_437_184) throw new Error('GAME_INVALID_SCREENSHOT')
  return { png, metadata }
}
