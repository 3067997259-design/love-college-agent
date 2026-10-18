import { z } from 'zod'
import { GIFT_OBJECT_IDS, PUBLIC_ERROR_CODES } from '../../shared'

export const giftSpecSchema = z.strictObject({ sourceMemoryId: z.string().min(1).max(128), objectId: z.enum(GIFT_OBJECT_IDS), motif: z.enum(['plain', 'sakura', 'stars']) })
export const giftSchema = giftSpecSchema.extend({ id: z.string().uuid(), status: z.enum(['proposed', 'making', 'ready', 'given', 'failed', 'cancelled']), source: z.enum(['real', 'fake']),
  acceptedAtMs: z.number().int().nonnegative().optional(),
  createdAtMs: z.number().int().nonnegative(), readyAtMs: z.number().int().nonnegative().nullable(), givenAtMs: z.number().int().nonnegative().nullable(),
  assetRef: z.string().regex(/^asset:[a-f0-9]{64}$/).optional(), assetUrl: z.string().regex(/^lca-media:\/\/asset\/[a-f0-9]{64}$/).optional(),
  error: z.strictObject({ code: z.enum(PUBLIC_ERROR_CODES), retryable: z.boolean() }).optional() })
