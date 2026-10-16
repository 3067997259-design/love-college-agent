import { z } from 'zod'
import { binaryAssetSchema } from '../storage/assets'
export const opticalTier = z.enum(['large', 'base', 'small', 'tiny'])
export const opticalDigest = z.string().regex(/^[a-f0-9]{64}$/)
const id = z.string().min(1).max(128)
export const opticalSource = z.strictObject({ messageId: id, frameSeq: z.number().int().positive(), index: z.number().int().nonnegative(), start: z.number().int().nonnegative(), end: z.number().int().positive(), sha256: opticalDigest }).refine((source) => source.end > source.start)
export const opticalFrame = z.strictObject({ id: opticalDigest, sessionId: id, createdAtMs: z.number().int().nonnegative(), pageIndex: z.number().int().min(0).max(63), pageCount: z.number().int().min(1).max(64), sources: z.array(opticalSource).min(1).max(24), asset: binaryAssetSchema.refine((asset) => asset.format === 'png'), width: z.literal(1280), height: z.literal(1280) }).refine((frame) => frame.pageIndex < frame.pageCount)
export const opticalFragment = z.strictObject({ text: z.string().min(4).max(2000), messageId: id, start: z.number().int().nonnegative(), end: z.number().int().positive() }).refine((fragment) => fragment.end - fragment.start === fragment.text.length)
export const opticalImpression = z.strictObject({ frameId: opticalDigest, tier: opticalTier, source: z.enum(['real', 'fake']), createdAtMs: z.number().int().nonnegative(), fragments: z.array(opticalFragment).max(24), rejectedLineCount: z.number().int().nonnegative().max(64001) })
export type OpticalFrame = z.infer<typeof opticalFrame>
export type OpticalImpression = z.infer<typeof opticalImpression>
export interface OpticalPort { source: 'real' | 'fake'; decode(png: Buffer, tier: z.infer<typeof opticalTier>, signal: AbortSignal): Promise<string> }
