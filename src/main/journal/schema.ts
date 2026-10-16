import { z } from 'zod'
import { PUBLIC_ERROR_CODES } from '../../shared'
import { viewSchema } from '../pomodoro/schema'
import { artifactSchema, candidateSchema, deliverySchema, mailboxSchema, mailFactsSchema, opaqueId } from '../campus/schema'

const id = z.string().min(1).max(128)
const text = z.string().max(200_000)
const publicError = z.strictObject({
  code: z.enum(PUBLIC_ERROR_CODES),
  retryable: z.boolean(), detailsId: id.optional(),
})
const step = z.strictObject({ id, text: z.string().max(500), status: z.enum(['pending', 'active', 'done', 'failed']) })
const toolCall = z.strictObject({ id, name: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/), arguments: z.string().max(64_000) })
export type ContextMessage = {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  toolCallId?: string
  toolCalls?: { id: string; name: string; arguments: string }[]
}

export const inputSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('session/header'), userId: id, characterId: id, sessionId: id }),
  z.strictObject({ type: z.literal('session/carry'), sourceSessionId: id, sourceSeq: z.number().int().positive(),
    mode: z.enum(['work', 'quiet', 'rest']), lightsOut: z.boolean(), pomodoro: viewSchema, pomodoroPause: z.enum(['manual', 'lights']).nullable(),
    pomodoroEvents: z.array(z.strictObject({ id, text: z.string().max(2000) })).max(1000) }),
  z.strictObject({ type: z.literal('companion/mode'), mode: z.enum(['work', 'quiet', 'rest']), requestId: id, commandHash: id }),
  z.strictObject({ type: z.literal('companion/lights'), lightsOut: z.boolean(), requestId: id, commandHash: id }),
  z.strictObject({ type: z.literal('mail/state'), view: mailboxSchema }),
  z.strictObject({ type: z.literal('mail/processed'), sourceKey: opaqueId, contentHash: z.string().regex(/^[a-f0-9]{64}$/), evidenceRef: opaqueId, result: z.enum(['candidate', 'notice']), candidateId: opaqueId.optional(), facts: mailFactsSchema.optional() }),
  z.strictObject({ type: z.literal('campus/proposed'), candidate: candidateSchema, calendarUid: opaqueId }),
  z.strictObject({ type: z.literal('campus/confirmed'), candidateId: opaqueId, revision: z.number().int().positive(), plannedCompletionIso: z.iso.datetime({ offset: true }).nullable(), requestId: id, commandHash: id }),
  z.strictObject({ type: z.literal('campus/ignored'), candidateId: opaqueId, revision: z.number().int().positive(), requestId: id, commandHash: id }),
  z.strictObject({ type: z.literal('campus/exported'), candidateId: opaqueId, revision: z.number().int().positive(), sequence: z.number().int().nonnegative(), artifacts: z.array(artifactSchema).length(2) }),
  z.strictObject({ type: z.literal('campus/export-failed'), candidateId: opaqueId, revision: z.number().int().positive(), deliveries: z.array(deliverySchema.extend({ status: z.literal('failed') })).length(2) }),
  z.strictObject({ type: z.literal('pomodoro/state'), view: viewSchema, pauseReason: z.enum(['manual', 'lights']).nullable(),
    cause: z.enum(['plan', 'confirmed', 'started', 'paused', 'resumed', 'stopped', 'elapsed', 'interrupted']),
    mode: z.enum(['work', 'quiet', 'rest']).optional(), event: z.strictObject({ id, text: z.string().max(2000) }).optional() }),
  z.strictObject({ type: z.literal('user/message'), id, text: z.string().min(1).max(20_000), requestId: id, commandHash: id }),
  z.strictObject({ type: z.literal('inbox/event'), id, source: z.enum(['pomodoro', 'mail', 'autonomous']), text: z.string().max(2000) }),
  z.strictObject({ type: z.literal('inbox/drain'), ids: z.array(id).max(32) }),
  z.strictObject({ type: z.literal('inbox/drop'), ids: z.array(id).max(32) }),
  z.strictObject({ type: z.literal('turn/start'), turnId: id, trigger: z.enum(['user', 'pomodoro', 'mail', 'autonomous']) }),
  z.strictObject({ type: z.literal('turn/cancelling'), turnId: id }),
  z.strictObject({ type: z.literal('turn/paused'), turnId: id }),
  z.strictObject({ type: z.literal('turn/resumed'), turnId: id }),
  z.strictObject({ type: z.literal('turn/end'), turnId: id, reason: z.enum(['completed', 'aborted', 'max-steps', 'loop', 'budget', 'error']), error: publicError.optional() }),
  z.strictObject({ type: z.literal('assistant/message'), id, turnId: id, text, status: z.enum(['complete', 'interrupted']), delivery: z.enum(['immediate', 'rest']).optional(), toolCalls: z.array(toolCall).max(16).optional() }),
  z.strictObject({ type: z.literal('tool/call'), turnId: id, callId: id, name: toolCall.shape.name, arguments: z.record(z.string(), z.json()), templateId: id }),
  z.strictObject({ type: z.literal('tool/result'), turnId: id, callId: id, ok: z.boolean(), raw: z.json(), visible: z.json(), elapsedMs: z.number().nonnegative(),
    fields: z.record(z.string().max(40), z.union([z.string().max(100), z.number().finite(), z.boolean()])).optional() }),
  z.strictObject({ type: z.literal('plan/update'), turnId: id, steps: z.array(step).max(30) }),
  z.strictObject({ type: z.literal('context/inject'), source: z.enum(['policy', 'memory', 'scheduler']), text }),
  z.strictObject({ type: z.literal('context/compact'), fromSeq: z.number().int().positive(), toSeq: z.number().int().positive(), summary: text }),
  z.strictObject({ type: z.literal('model/attempt'), turnId: id, slot: z.enum(['chat', 'background', 'chat_google', 'chat_claude', 'privacy']), attempt: z.number().int().positive(),
    status: z.enum(['started', 'success', 'failed', 'retry']), waitMs: z.number().nonnegative(), httpStatus: z.number().int().optional(),
    reservedTokens: z.number().int().nonnegative().optional(), bucket: z.enum(['work', 'autonomous']).optional(),
    error: z.enum(['configuration', 'network', 'timeout', 'upstream', 'quota', 'cancelled', 'invalid-output', 'interrupted']).optional(),
    inputTokens: z.number().int().nonnegative().optional(), outputTokens: z.number().int().nonnegative().optional() }),
])
export type JournalInput = z.infer<typeof inputSchema>
export type JournalRecord = JournalInput & { version: 1; seq: number; atMs: number }

export function parseRecord(value: unknown): JournalRecord {
  const envelope = z.object({ version: z.literal(1), seq: z.number().int().positive(), atMs: z.number().int().nonnegative() }).parse(value)
  const { version: _version, seq: _seq, atMs: _atMs, ...input } = value as Record<string, unknown>
  void _version; void _seq; void _atMs
  return { ...inputSchema.parse(input), ...envelope }
}
