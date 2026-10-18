import { z } from 'zod'
import { PUBLIC_ERROR_CODES } from '../../shared'
import { artifactSchema, opaqueId } from '../campus/schema'

export const documentFormat = z.enum(['pdf', 'text', 'markdown'])
export const documentViewSchema = z.strictObject({ id: opaqueId, createdAtMs: z.number().int().nonnegative(), updatedAtMs: z.number().int().nonnegative(),
  displayName: z.string().regex(/^资料-[a-f0-9]{8}\.(?:pdf|txt|md)$/), origin: z.enum(['mail-attachment', 'drop']), format: documentFormat,
  byteLength: z.number().int().positive().max(10 * 1024 * 1024), source: z.enum(['real', 'fake']), status: z.enum(['staged', 'queued', 'processing', 'ready', 'failed', 'cancelled']),
  pageCount: z.number().int().min(1).max(60).nullable(), deadlineIso: z.iso.datetime({ offset: true }).nullable(),
  error: z.strictObject({ code: z.enum(PUBLIC_ERROR_CODES), retryable: z.boolean() }).optional() })
export const documentJobSchema = z.strictObject({ sharedWithMain: z.boolean().optional(), view: documentViewSchema, sourceRef: z.string().regex(/^f:[a-f0-9]{64}$/).nullable(), attachmentId: opaqueId.optional(), attempt: z.number().int().nonnegative() })
export const attachmentSchema = z.strictObject({ id: opaqueId, candidateId: opaqueId.optional(), displayName: z.string().regex(/^附件-[a-f0-9]{8}\.(?:pdf|txt|md)$/),
  byteLength: z.number().int().positive().max(10 * 1024 * 1024), format: documentFormat, source: z.enum(['real', 'fake']) })
export const attachmentRecordSchema = z.strictObject({ view: attachmentSchema, uidValidity: z.string().regex(/^\d{1,20}$/), uid: z.number().int().positive(), partId: z.string().regex(/^\d+(?:\.\d+)*$/).max(40),
  /** Stable non-secret mailbox identity (host/port/user/folder hash); absent on legacy records and conservatively refused on re-fetch. */
  mailboxId: z.string().regex(/^[a-f0-9]{64}$/).optional() })
export const documentFactsSchema = z.strictObject({ documentId: opaqueId, fileName: z.string().regex(/^整理-[a-f0-9]{8}\.md$/), format: documentFormat,
  pageCount: z.number().int().min(1).max(60).nullable(), deadlineIso: z.iso.datetime({ offset: true }).nullable(), source: z.enum(['real', 'fake']), trust: z.literal('untrusted') })
export const documentCompletedSchema = z.strictObject({ sharedWithMain: z.boolean().optional(), documentId: opaqueId, attempt: z.number().int().positive(), artifact: artifactSchema, facts: documentFactsSchema })
export type DocumentJob = z.infer<typeof documentJobSchema>
export type AttachmentRecord = z.infer<typeof attachmentRecordSchema>
