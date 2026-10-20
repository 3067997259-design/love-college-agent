import { z } from 'zod'
import { deskPathSchema, validateDeskText } from '../../legacy-flow/desk'
export const digestSchema = z.string().regex(/^[a-f0-9]{64}$/)
const time = z.number().int().nonnegative()
export const workText = z.string().trim().min(1).max(12000).superRefine((text, ctx) => {
  try { validateDeskText(text); if (Buffer.byteLength(text) > 12000) throw new Error('TOO_LONG') } catch { ctx.addIssue({ code: 'custom', message: 'Invalid work text' }) }
})
export const materialSchema = z.strictObject({ id: digestSchema, path: deskPathSchema, text: workText, sha256: digestSchema, source: z.literal('fake') })
export const workItemSchema = z.strictObject({
  id: digestSchema, dayKey: z.iso.date(), kind: z.enum(['read', 'write']), source: z.enum(['real', 'fake']), materialId: digestSchema,
  status: z.enum(['queued', 'running', 'paused', 'interrupted', 'failed', 'completed']), completedSteps: z.number().int().min(0).max(3), totalSteps: z.literal(3),
  createdAtMs: time, updatedAtMs: time, completedAtMs: time.nullable(), reason: z.enum(['user', 'interrupted', 'busy', 'lights', 'conflict', 'model', 'budget']).optional(),
  output: z.strictObject({ path: deskPathSchema, sha256: digestSchema, byteLength: z.number().int().positive().max(12000) }).optional(),
})
export const draftSchema = z.strictObject({ id: z.string().uuid(), workId: digestSchema, step: z.number().int().min(1).max(3), path: deskPathSchema, text: workText, sha256: digestSchema })
export const workOutput = z.strictObject({ markdown: workText })
export const workModelInput = z.strictObject({ kind: z.enum(['read', 'write']), step: z.number().int().min(1).max(3), totalSteps: z.literal(3),
  material: workText, previous: z.string().max(12000).superRefine((text, ctx) => { if (Buffer.byteLength(text) > 12000) ctx.addIssue({ code: 'custom', message: 'Invalid work size' }) }) })
export type WorkMaterial = z.infer<typeof materialSchema>
export type WorkDraft = z.infer<typeof draftSchema>
export interface LifeWorkModel {
  source: 'real' | 'fake'
  produce(input: { kind: 'read' | 'write'; step: number; totalSteps: number; material: string; previous: string }, signal: AbortSignal): Promise<unknown>
}
