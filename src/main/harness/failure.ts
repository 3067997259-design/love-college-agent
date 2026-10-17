import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { PUBLIC_ERROR_CODES, type ModelFailureView, type PublicErrorCode } from '../../shared'
import type { SessionStore } from '../store/session'
import type { JournalInput } from '../journal/schema'
import words from './narrator.zh.json'

export const failureViewSchema = z.strictObject({
  turnId: z.string().min(1).max(128), code: z.enum(PUBLIC_ERROR_CODES),
  category: z.enum(['configuration', 'network', 'upstream', 'quota', 'budget', 'content-filtered', 'interrupted', 'invalid-response', 'execution-guard', 'internal']),
  attemptCount: z.number().int().min(0).max(1000), toolsExecuted: z.boolean(), httpStatus: z.number().int().min(100).max(599).optional(), sourceMessageId: z.string().min(1).max(128).optional(),
})
function category(code: PublicErrorCode): ModelFailureView['category'] {
  if (code === 'configuration-failed' || code === 'not-configured') return 'configuration'
  if (code === 'connection-failed') return 'network'
  if (code === 'upstream-busy') return 'upstream'
  if (code === 'quota-exhausted') return 'quota'
  if (code === 'budget-exceeded') return 'budget'
  if (code === 'content-filtered') return 'content-filtered'
  if (code === 'stream-interrupted') return 'interrupted'
  if (code === 'invalid-model-output' || code === 'memory-invalid-output') return 'invalid-response'
  if (code === 'step-limit' || code === 'repeat-limit' || code === 'context-too-large') return 'execution-guard'
  return 'internal'
}
/** Builds only trusted prose and closed metadata. Never accepts an exception message or response body. */
export function failureNarration(store: SessionStore, turnId: string, code: PublicErrorCode, toolsExecuted: boolean, httpStatus?: number): Extract<JournalInput, { type: 'narrator/failure' }> {
  const rows = store.records(); const start = rows.findLastIndex((row) => row.type === 'turn/start' && row.turnId === turnId)
  const within = rows.slice(Math.max(0, start)); const consumed = new Set(within.flatMap((row) => row.type === 'inbox/drain' ? row.ids : []))
  const answers = new Set(within.flatMap((row) => row.type === 'question/answered' ? [row.answerMessageId] : []))
  const sources = rows.filter((row) => row.type === 'user/message' && consumed.has(row.id) && !answers.has(row.id))
  const attempts = within.filter((row) => row.type === 'model/attempt' && row.turnId === turnId)
  const status = httpStatus ?? attempts.flatMap((row) => row.type === 'model/attempt' && row.status === 'failed' && row.httpStatus !== undefined ? [row.httpStatus] : []).at(-1)
  const failure: ModelFailureView = { turnId, code, category: category(code), toolsExecuted, attemptCount: Math.min(1000, attempts.filter((row) => row.type === 'model/attempt' && row.status === 'started').length),
    ...(status !== undefined && Number.isInteger(status) && status >= 100 && status <= 599 ? { httpStatus: status } : {}), ...(sources.length === 1 && sources[0].type === 'user/message' ? { sourceMessageId: sources[0].id } : {}) }
  return { type: 'narrator/failure', id: randomUUID(), turnId, text: words[failure.category], failure }
}
