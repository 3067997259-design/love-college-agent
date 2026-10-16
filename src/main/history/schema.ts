import { z } from 'zod'
import { binaryAssetSchema } from '../storage/assets'
export const photoReason = z.enum(['manual', 'gift', 'outing', 'work', 'day-end'])
export const historyPhotoSchema = z.strictObject({ id: z.string().uuid(), sessionId: z.string().min(1).max(128), dayKey: z.iso.date(),
  reason: photoReason, eventId: z.string().min(1).max(200), asset: binaryAssetSchema.refine((asset) => asset.format === 'png'),
  width: z.number().int().positive().max(2048), height: z.number().int().positive().max(2048) })
export const recallAnchorSchema = z.strictObject({ sessionId: z.string().min(1).max(128), messageId: z.string().min(1).max(128), start: z.number().int().nonnegative(), end: z.number().int().positive() })
  .refine((anchor) => anchor.end > anchor.start && anchor.end - anchor.start <= 1000)
