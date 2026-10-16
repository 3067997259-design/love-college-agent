import { z } from 'zod'

const fieldsSchema = z.strictObject({
  kind: z.enum(['assignment', 'event', 'notice']),
  deadlineIso: z.iso.datetime({ offset: true }).nullable(),
  task: z.string().min(1).max(20).refine((value) => [...value].every((character) => {
    const code = character.charCodeAt(0)
    return code > 31 && code !== 127
  })),
})
export type PrivacyFields = z.infer<typeof fieldsSchema>
export interface PrivacyModel { readonly source: 'real' | 'fake'; extract(text: string, signal?: AbortSignal): Promise<unknown> }
export type PrivacyResult = { ok: true; source: 'real' | 'fake'; trust: 'untrusted'; fields: PrivacyFields } | { ok: false; error: 'privacy-unavailable' | 'privacy-invalid-output' }

export function createPrivacyFilter(model: PrivacyModel | null) {
  return async (text: string, signal?: AbortSignal): Promise<PrivacyResult> => {
    if (!model) return { ok: false, error: 'privacy-unavailable' }
    try {
      const parsed = fieldsSchema.safeParse(await model.extract(text, signal))
      return parsed.success ? { ok: true, source: model.source, trust: 'untrusted', fields: parsed.data } : { ok: false, error: 'privacy-invalid-output' }
    } catch { return { ok: false, error: 'privacy-unavailable' } }
  }
}

/** Explicit dependency for synthetic development fixtures, never a failure fallback. */
export function createFakePrivacyModel(output: unknown = { kind: 'notice', deadlineIso: null, task: '虚构通知' }): PrivacyModel {
  return { source: 'fake', extract: async () => output }
}
