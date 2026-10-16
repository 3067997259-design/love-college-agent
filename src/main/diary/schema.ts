import { z } from 'zod'
import { binaryAssetSchema } from '../storage/assets'
export const diarySchema = z.strictObject({ id: z.string().regex(/^diary:[a-f0-9]{64}$/), dayKey: z.iso.date(), createdAtMs: z.number().int().nonnegative(), unlockAtMs: z.number().int().nonnegative(), key: z.string().regex(/^[A-F0-9]{16}$/), asset: binaryAssetSchema.refine((asset) => asset.format === 'zip'), sourceIds: z.array(z.string().max(128)).max(24), source: z.enum(['real', 'fake']) })
export const diaryOutput = z.strictObject({ entry: z.string().trim().min(1).max(2400).refine((text) => !/<\/?(?:think|analysis|reasoning)>|思维链|内部推理记录/i.test(text)) })
export interface DiaryModel { source: 'real' | 'fake'; write(input: readonly { id: string; text: string }[], signal: AbortSignal): Promise<unknown> }
