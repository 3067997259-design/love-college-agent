import { z } from 'zod'
import { MAIL_SCENARIO_IDS, PUBLIC_ERROR_CODES } from '../../shared'

export const opaqueId = z.string().regex(/^[A-Za-z0-9_.:-]{1,128}$/)
export const iso = z.iso.datetime({ offset: true })
const short = (length: number) => z.string().min(1).max(length).refine((value) => [...value].every((char) => char.charCodeAt(0) > 31 && char.charCodeAt(0) !== 127))
export const candidateSchema = z.strictObject({ id: opaqueId, revision: z.number().int().positive(), source: z.enum(['real', 'fake']), createdAtMs: z.number().int().nonnegative(),
  kind: z.enum(['deadline', 'event']), title: short(20), deadlineIso: iso.nullable(), plannedCompletionIso: iso.nullable(),
  status: z.enum(['candidate', 'confirmed', 'changed', 'ignored']), eventStartIso: iso.optional(), eventEndIso: iso.optional(), locationText: short(40).optional(), sourceLabel: short(60), evidenceRef: opaqueId,
  change: z.strictObject({ previousDeadlineIso: iso.nullable(), previousEventStartIso: iso.optional(), previousEvidenceRef: opaqueId }).optional(),
})
export const deliverySchema = z.strictObject({ id: opaqueId, createdAtMs: z.number().int().nonnegative(), artifactId: opaqueId, displayName: short(120),
  kind: z.enum(['calendar', 'markdown', 'document', 'gift']), status: z.enum(['ready', 'failed']), sourceRefs: z.array(opaqueId).max(100), source: z.enum(['real', 'fake']) })
export const artifactSchema = z.strictObject({ view: deliverySchema, relativePath: z.string().regex(/^artifacts\/[a-f0-9]{64}\.(?:ics|md)$/), sha256: z.string().regex(/^[a-f0-9]{64}$/) })
export const mailboxSchema = z.strictObject({ status: z.enum(['blocked', 'idle', 'scanning', 'ready', 'failed', 'disabled']), source: z.enum(['real', 'fake']), folderLabel: z.literal('桃子'),
  unseenCount: z.number().int().nonnegative().nullable(), lastAttemptAtMs: z.number().int().nonnegative().nullable(), lastSuccessAtMs: z.number().int().nonnegative().nullable(),
  processedCount: z.number().int().nonnegative(), pendingReviewCount: z.number().int().nonnegative(), scenarioId: z.enum(MAIL_SCENARIO_IDS).optional(),
  error: z.strictObject({ code: z.enum(PUBLIC_ERROR_CODES), retryable: z.boolean() }).optional(),
})
export const mailFactsSchema = z.strictObject({ candidateId: opaqueId, revision: z.number().int().positive(), title: short(20), kind: z.enum(['deadline', 'event']),
  deadlineIso: iso.nullable(), eventStartIso: iso.optional(), eventEndIso: iso.optional(), locationText: short(40).optional(), sourceLabel: short(60), source: z.enum(['real', 'fake']), trust: z.literal('untrusted') })
export type CampusCandidate = z.infer<typeof candidateSchema>
export type CampusArtifact = z.infer<typeof artifactSchema>
