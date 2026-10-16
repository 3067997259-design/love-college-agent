import { z } from 'zod'

const id = z.string().min(1).max(128)
const text = z.string().max(200_000)
const publicError = z.strictObject({
  code: z.enum(['invalid-command', 'stale-epoch', 'unavailable', 'not-configured', 'permission-denied', 'connection-failed', 'privacy-unavailable', 'internal']),
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
  z.strictObject({ type: z.literal('companion/mode'), mode: z.enum(['work', 'quiet', 'rest']), requestId: id, commandHash: id }),
  z.strictObject({ type: z.literal('companion/lights'), lightsOut: z.boolean(), requestId: id, commandHash: id }),
  z.strictObject({ type: z.literal('user/message'), id, text: z.string().min(1).max(20_000), requestId: id, commandHash: id }),
  z.strictObject({ type: z.literal('turn/start'), turnId: id, trigger: z.enum(['user', 'pomodoro', 'mail', 'autonomous']) }),
  z.strictObject({ type: z.literal('turn/end'), turnId: id, reason: z.enum(['completed', 'aborted', 'max-steps', 'loop', 'budget', 'error']), error: publicError.optional() }),
  z.strictObject({ type: z.literal('assistant/message'), id, turnId: id, text, status: z.enum(['complete', 'interrupted']), toolCalls: z.array(toolCall).max(16).optional() }),
  z.strictObject({ type: z.literal('tool/call'), turnId: id, callId: id, name: toolCall.shape.name, arguments: z.record(z.string(), z.json()), templateId: id }),
  z.strictObject({ type: z.literal('tool/result'), turnId: id, callId: id, ok: z.boolean(), raw: z.json(), visible: z.json(), elapsedMs: z.number().nonnegative(),
    fields: z.record(z.string().max(40), z.union([z.string().max(100), z.number().finite(), z.boolean()])).optional() }),
  z.strictObject({ type: z.literal('plan/update'), turnId: id, steps: z.array(step).max(30) }),
  z.strictObject({ type: z.literal('context/inject'), source: z.enum(['policy', 'memory', 'scheduler']), text }),
  z.strictObject({ type: z.literal('context/compact'), fromSeq: z.number().int().positive(), toSeq: z.number().int().positive(), summary: text }),
  z.strictObject({ type: z.literal('model/attempt'), turnId: id, slot: z.enum(['chat', 'background', 'chat_google', 'chat_claude', 'privacy']), attempt: z.number().int().positive(),
    status: z.enum(['success', 'failed', 'retry']), waitMs: z.number().nonnegative(), httpStatus: z.number().int().optional(),
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
