import { z } from 'zod'
import type { EvidenceView, Scope } from '../../shared'

const reference = z.string().min(1).max(128).regex(/^[A-Za-z0-9_.:-]+$/)
const evidence = z.strictObject({
  subject: z.string().max(256), senderName: z.string().max(80), receivedAtMs: z.number().int().nonnegative(), excerpt: z.string().max(8000),
  highlights: z.array(z.strictObject({ start: z.number().int().nonnegative(), end: z.number().int().nonnegative(), field: z.enum(['deadlineIso', 'eventStartIso', 'locationText', 'title']) })).max(32),
}).refine((value) => value.highlights.every((highlight) => highlight.start <= highlight.end && highlight.end <= value.excerpt.length))

/** Implementations must resolve an opaque ref in this user/character scope, never as a path/URL. */
export type UserEvidenceLookup = (ref: string, scope: Scope) => Promise<unknown>

export function createUserEvidenceReader(lookup?: UserEvidenceLookup) {
  return async (ref: unknown, scope: Scope): Promise<EvidenceView> => {
    const parsedRef = reference.safeParse(ref)
    if (!parsedRef.success) throw new Error('EVIDENCE_INVALID_REFERENCE')
    if (!lookup) throw new Error('EVIDENCE_UNAVAILABLE')
    try {
      const result = evidence.safeParse(await lookup(parsedRef.data, scope))
      if (result.success) return result.data
    } catch { /* Do not reflect source errors or private data through IPC. */ }
    throw new Error('EVIDENCE_UNAVAILABLE')
  }
}
