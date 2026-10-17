import { z } from 'zod'
import { commandOutcome } from '../desk-command/schema'
import { rewindSchema } from '../heart-flow/rewind'
import { failureViewSchema } from '../harness/failure'
import { goalSchema } from '../heart-flow/goals'
import { operationSchema } from '../heart-flow/operations'
import { PUBLIC_ERROR_CODES } from '../../shared'
import { viewSchema } from '../pomodoro/schema'
import { artifactSchema, candidateSchema, deliverySchema, mailboxSchema, mailFactsSchema, opaqueId } from '../campus/schema'
import { attachmentRecordSchema, documentCompletedSchema, documentJobSchema } from '../documents/schema'
import { memoryBatchSchema, memorySourceSchema, memorySummarySchema } from '../memory/schema'
import { onboardingSchema } from '../onboarding/schema'
import { binaryAssetSchema } from '../storage/assets'
import { giftSchema } from '../gifts/schema'
import { lifeSchema } from '../life/schema'
import { materialSchema, workItemSchema, draftSchema, digestSchema } from '../life/work/schema'
import { diarySchema } from '../diary/schema'
import { notificationRule } from '../notifications/schema'
import { definitionSchema } from '../characters/package'
import { historyPhotoSchema, recallAnchorSchema } from '../history/schema'
import { delegateState, delegateOutput } from '../delegates/schema'
import { opticalFrame, opticalImpression, opticalTier } from '../optical/schema'

const id = z.string().min(1).max(128)
const text = z.string().max(200_000)
const publicError = z.strictObject({
  code: z.enum(PUBLIC_ERROR_CODES),
  retryable: z.boolean(), detailsId: id.optional(),
})
const step = z.strictObject({ id, text: z.string().max(500), status: z.enum(['pending', 'active', 'done', 'failed']) })
const toolCall = z.strictObject({ id, name: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/), arguments: z.string().max(64_000) })
export const contextMessageSchema = z.strictObject({ role: z.enum(['system', 'user', 'assistant', 'tool']), content: text,
  imageRefs: z.array(z.string().regex(/^(?:work|game)-frame:[a-f0-9]{64}$/)).max(1).optional(),
  toolCallId: id.optional(), toolCalls: z.array(toolCall).max(16).optional() })
export type ContextMessage = {
  imageRefs?: string[]
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  toolCallId?: string
  toolCalls?: { id: string; name: string; arguments: string }[]
}

export const inputSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('optical/enabled'), enabled: z.boolean() }),
  z.strictObject({ type: z.literal('optical/frame'), frame: opticalFrame }),
  z.strictObject({ type: z.literal('optical/impression'), impression: opticalImpression }),
  z.strictObject({ type: z.literal('optical/attempt'), operation: z.enum(['encode', 'decode']), targetId: z.string().min(1).max(128), tier: opticalTier.optional() }),
  z.strictObject({ type: z.literal('delegate/state'), view: delegateState }),
  z.strictObject({ type: z.literal('delegate/result'), id: z.string().uuid(), flowId: z.string().min(1).max(128), output: delegateOutput }),
  z.strictObject({ type: z.literal('life/material'), material: materialSchema }),
  z.strictObject({ type: z.literal('life/work-state'), job: workItemSchema }),
  z.strictObject({ type: z.literal('life/work-draft'), draft: draftSchema }),
  z.strictObject({ type: z.literal('life/work-commit'), workId: digestSchema, draftId: z.string().uuid() }),
  z.strictObject({ type: z.literal('life/work-attempt'), workId: digestSchema, step: z.number().int().min(1).max(3), dayKey: z.iso.date() }),
  z.strictObject({ type: z.literal('history/recall-request'), requestId: id, anchor: recallAnchorSchema, sourceCount: z.number().int().positive().max(5) }),
  z.strictObject({ type: z.literal('history/recall-used'), requestId: id, turnId: id, chars: z.number().int().positive().max(20_000) }),
  z.strictObject({ type: z.literal('history/recall-read'), requestId: id, turnId: id, chars: z.number().int().positive().max(12_000) }),
  z.strictObject({ type: z.literal('history/photo'), photo: historyPhotoSchema }),
  z.strictObject({ type: z.literal('history/photo-attempt'), eventId: z.string().max(200), sessionId: id, status: z.enum(['started', 'failed']) }),
  z.strictObject({ type: z.literal('character/definition'), definition: definitionSchema }),
  z.strictObject({ type: z.literal('notification/rule'), rule: notificationRule, enabled: z.boolean() }),
  z.strictObject({ type: z.literal('notification/proposal'), rule: notificationRule.nullable() }),
  z.strictObject({ type: z.literal('notification/sent'), kind: z.enum(['urgent-mail', 'flow-approval']), keys: z.array(z.string().max(180)).min(1).max(32) }),
  z.strictObject({ type: z.literal('diary/attempt'), dayKey: z.iso.date() }),
  z.strictObject({ type: z.literal('diary/written'), diary: diarySchema }),
  z.strictObject({ type: z.literal('life/state'), view: lifeSchema }),
  z.strictObject({ type: z.literal('minecraft/round'), roundId: z.string().uuid(), serverId: id, controlSessionId: z.string().uuid(), status: z.enum(['started', 'stopped']), stopVerified: z.boolean() }),
  z.strictObject({ type: z.literal('flow/goal'), goal: goalSchema }),
  z.strictObject({ type: z.literal('flow/operation'), operation: operationSchema }),
  z.strictObject({ type: z.literal('flow/operation-read'), operationId: z.string().uuid(), path: z.string().min(1).max(180), sha256: z.string().regex(/^[a-f0-9]{64}$/) }),
  z.strictObject({ type: z.literal('flow/goal-selected'), goalId: z.string().uuid() }),
  z.strictObject({ type: z.literal('flow/goal-linked'), goalId: z.string().uuid(), flowId: id }),
  z.strictObject({ type: z.literal('flow/open'), id, prefix: z.array(contextMessageSchema).max(200), mode: z.enum(['plan', 'execute']), resumedFrom: id.optional() }),
  z.strictObject({ type: z.literal('flow/mode'), id, mode: z.enum(['plan', 'execute']) }),
  z.strictObject({ type: z.literal('flow/close'), id, summary: z.string().max(2000) }),
  z.strictObject({ type: z.literal('flow/compact'), id, throughSeq: z.number().int().positive(), summary: z.string().max(6000), focus: z.string().max(500).optional(),
    retained: z.strictObject({ turnId: id, messages: z.array(contextMessageSchema).max(200) }).optional() }),
  z.strictObject({ type: z.literal('desk/change'), id, flowId: id, path: z.string().max(180), before: z.string().max(64000).nullable(), after: z.string().max(64000).nullable(), undoes: id.optional(), pending: z.boolean().optional(), commandId: z.string().uuid().optional(), rewindId: z.string().uuid().optional(), rewinds: z.array(id).max(500).optional() }),
  rewindSchema.extend({ type: z.literal('flow/rewind') }),
  z.strictObject({ type: z.literal('desk/settled'), id, status: z.enum(['applied', 'failed']) }),
  z.strictObject({ type: z.literal('flow/run'), id, flowId: id, status: z.enum(['requested', 'approved', 'denied', 'completed', 'failed', 'interrupted']), codeHash: z.string().regex(/^[a-f0-9]{64}$/) }),
  z.strictObject({ type: z.literal('flow/command'), id: z.string().uuid(), flowId: id, turnId: id.optional(), status: z.enum(['preparing', 'awaiting-approval', 'approved', 'denied', 'running', 'completed', 'failed', 'cancelled', 'interrupted']),
    executionHash: z.string().regex(/^[a-f0-9]{64}$/), timeoutMs: z.number().int().min(500).max(30000), fileCount: z.number().int().min(0).max(300), snapshotHash: z.string().regex(/^[a-f0-9]{64}$/).optional(), outcome: commandOutcome.optional(), requestId: id.optional(), commandHash: id.optional() }),
  z.strictObject({ type: z.literal('session/header'), userId: id, characterId: id, sessionId: id }),
  z.strictObject({ type: z.literal('asset/stored'), asset: binaryAssetSchema }),
  z.strictObject({ type: z.literal('gift/state'), gift: giftSchema }),
  z.strictObject({ type: z.literal('session/carry'), sourceSessionId: id, sourceSeq: z.number().int().positive(),
    mode: z.enum(['work', 'quiet', 'rest']), lightsOut: z.boolean(), sleeping: z.boolean().optional(), pomodoro: viewSchema, pomodoroPause: z.enum(['manual', 'lights']).nullable(),
    pomodoroEvents: z.array(z.strictObject({ id, text: z.string().max(2000) })).max(1000),
    pendingEvents: z.array(z.strictObject({ id, source: z.enum(['pomodoro', 'mail', 'document']), text: z.string().max(2000) })).max(32).optional(), onboarding: onboardingSchema.optional() }),
  z.strictObject({ type: z.literal('onboarding/state'), view: onboardingSchema, cause: z.enum(['profile', 'completed', 'reset', 'restored']), requestId: id, commandHash: id }),
  z.strictObject({ type: z.literal('companion/mode'), mode: z.enum(['work', 'quiet', 'rest']), requestId: id, commandHash: id }),
  z.strictObject({ type: z.literal('companion/lights'), lightsOut: z.boolean(), requestId: id, commandHash: id }),
  z.strictObject({ type: z.literal('companion/sleep'), sleeping: z.boolean(), cause: z.enum(['user', 'day-end', 'interaction']), requestId: id.optional(), commandHash: id.optional() }).refine((row) => !!row.requestId === !!row.commandHash),
  z.strictObject({ type: z.literal('voice/settings'), enabled: z.boolean() }),
  z.strictObject({ type: z.literal('flow/web-fetch'), flowId: id, id, urlHash: z.string().regex(/^[a-f0-9]{64}$/), status: z.enum(['requested', 'approved', 'fetched', 'denied', 'failed', 'cancelled']), source: z.enum(['real', 'fake']), receivedBytes: z.number().int().nonnegative().optional(), truncated: z.boolean().optional() }),
  z.strictObject({ type: z.literal('flow/computer-frame'), flowId: id, ref: z.string().regex(/^work-frame:[a-f0-9]{64}$/), asset: binaryAssetSchema.refine((asset) => asset.format === 'png' && asset.byteLength <= 131072), fingerprint: z.string().regex(/^[a-f0-9]{64}$/) }),
  z.strictObject({ type: z.literal('flow/computer-action'), flowId: id, approvalId: id, status: z.enum(['requested', 'denied', 'dispatched', 'failed', 'cancelled']), actionHash: z.string().regex(/^[a-f0-9]{64}$/) }),
  z.strictObject({ type: z.literal('desk/shadow'), changeId: id, status: z.enum(['committed', 'not-git', 'unavailable', 'failed']), commit: z.string().regex(/^[a-f0-9]{40}$/).optional() }).refine((row) => (row.status === 'committed') === !!row.commit),
  z.strictObject({ type: z.literal('voice/attempt'), id, dayKey: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), charCount: z.number().int().min(1).max(1200), source: z.enum(['real', 'fake']), resourceReservationId: z.string().uuid().optional() }),
  z.strictObject({ type: z.literal('mail/state'), view: mailboxSchema }),
  z.strictObject({ type: z.literal('mail/processed'), sourceKey: opaqueId, contentHash: z.string().regex(/^[a-f0-9]{64}$/), evidenceRef: opaqueId, result: z.enum(['candidate', 'notice']), candidateId: opaqueId.optional(), facts: mailFactsSchema.optional() }),
  z.strictObject({ type: z.literal('campus/proposed'), candidate: candidateSchema, calendarUid: opaqueId }),
  z.strictObject({ type: z.literal('campus/confirmed'), candidateId: opaqueId, revision: z.number().int().positive(), plannedCompletionIso: z.iso.datetime({ offset: true }).nullable(), requestId: id, commandHash: id }),
  z.strictObject({ type: z.literal('campus/ignored'), candidateId: opaqueId, revision: z.number().int().positive(), requestId: id, commandHash: id }),
  z.strictObject({ type: z.literal('campus/exported'), candidateId: opaqueId, revision: z.number().int().positive(), sequence: z.number().int().nonnegative(), artifacts: z.array(artifactSchema).length(2) }),
  z.strictObject({ type: z.literal('campus/export-failed'), candidateId: opaqueId, revision: z.number().int().positive(), deliveries: z.array(deliverySchema.extend({ status: z.literal('failed') })).length(2) }),
  z.strictObject({ type: z.literal('document/job'), job: documentJobSchema }),
  z.strictObject({ type: z.literal('document/attachment'), attachment: attachmentRecordSchema }),
  z.strictObject({ type: z.literal('document/completed'), ...documentCompletedSchema.shape }),
  z.strictObject({ type: z.literal('pomodoro/state'), view: viewSchema, pauseReason: z.enum(['manual', 'lights']).nullable(),
    cause: z.enum(['plan', 'confirmed', 'discarded', 'started', 'paused', 'resumed', 'stopped', 'elapsed', 'interrupted', 'restored']),
    mode: z.enum(['work', 'quiet', 'rest']).optional(), event: z.strictObject({ id, text: z.string().max(2000) }).optional() }),
  z.strictObject({ type: z.literal('user/message'), id, text: z.string().min(1).max(20_000), requestId: id, commandHash: id }),
  z.strictObject({ type: z.literal('inbox/event'), id, source: z.enum(['pomodoro', 'mail', 'document', 'autonomous']), text: z.string().max(2000) }),
  z.strictObject({ type: z.literal('inbox/drain'), ids: z.array(id).max(32) }),
  z.strictObject({ type: z.literal('inbox/drop'), ids: z.array(id).max(32) }),
  z.strictObject({ type: z.literal('turn/start'), turnId: id, trigger: z.enum(['user', 'pomodoro', 'mail', 'document', 'autonomous']) }),
  z.strictObject({ type: z.literal('turn/cancelling'), turnId: id }),
  z.strictObject({ type: z.literal('turn/paused'), turnId: id }),
  z.strictObject({ type: z.literal('turn/resumed'), turnId: id }),
  z.strictObject({ type: z.literal('turn/end'), turnId: id, reason: z.enum(['completed', 'aborted', 'max-steps', 'loop', 'budget', 'error']), error: publicError.optional() }),
  z.strictObject({ type: z.literal('assistant/message'), id, turnId: id, text, status: z.enum(['complete', 'interrupted']), displayOnly: z.boolean().optional(), delivery: z.enum(['immediate', 'rest']).optional(), toolCalls: z.array(toolCall).max(16).optional() }),
  z.strictObject({ type: z.literal('narrator/failure'), id, turnId: id, text: z.string().min(1).max(1000), failure: failureViewSchema, delivery: z.enum(['immediate', 'rest']).optional() }).refine((row) => row.turnId === row.failure.turnId),
  z.strictObject({ type: z.literal('question/requested'), id: z.string().uuid(), turnId: id, callId: id, flowId: id.optional(), question: z.string().min(1).max(480), choices: z.array(z.string().min(1).max(120)).max(3) }),
  z.strictObject({ type: z.literal('question/answered'), id: z.string().uuid(), turnId: id, answerMessageId: id }),
  z.strictObject({ type: z.literal('question/committed'), id: z.string().uuid(), turnId: id, answerMessageId: id }),
  z.strictObject({ type: z.literal('question/closed'), id: z.string().uuid(), turnId: id, cause: z.enum(['declined', 'cancelled', 'timeout', 'superseded', 'interrupted', 'disabled']), requestId: id.optional(), commandHash: id.optional() }),
  z.strictObject({ type: z.literal('tool/call'), turnId: id, callId: id, name: toolCall.shape.name, arguments: z.record(z.string(), z.json()), templateId: id }),
  z.strictObject({ type: z.literal('tool/result'), turnId: id, callId: id, ok: z.boolean(), raw: z.json(), visible: z.json(), elapsedMs: z.number().nonnegative(),
    imageRefs: contextMessageSchema.shape.imageRefs,
    fields: z.record(z.string().max(40), z.union([z.string().max(100), z.number().finite(), z.boolean()])).optional() }),
  z.strictObject({ type: z.literal('plan/update'), turnId: id, steps: z.array(step).max(30) }),
  z.strictObject({ type: z.literal('context/inject'), source: z.enum(['policy', 'memory', 'scheduler']), text }),
  z.strictObject({ type: z.literal('context/compact'), fromSeq: z.number().int().positive(), toSeq: z.number().int().positive(), summary: text, sources: z.array(memorySourceSchema).max(128).optional() }),
  z.strictObject({ type: z.literal('model/seen'), turnId: id, source: z.enum(['real', 'fake']), messages: z.array(contextMessageSchema).max(1024),
    eligibleIndexes: z.array(z.number().int().nonnegative()).max(1024) }).refine((value) => new Set(value.eligibleIndexes).size === value.eligibleIndexes.length && value.eligibleIndexes.every((index) => index < value.messages.length && value.messages[index].role !== 'system')),
  z.strictObject({ type: z.literal('memory/batch'), ...memoryBatchSchema.shape }),
  z.strictObject({ type: z.literal('memory/access'), ids: z.array(id).max(10), requestId: id, sessionId: id }),
  z.strictObject({ type: z.literal('memory/summary'), summary: memorySummarySchema }),
  z.strictObject({ type: z.literal('save/restored'), archiveId: z.string().uuid(), restoreId: z.string().uuid(), exportedAtMs: z.number().int().nonnegative(), restoredAtMs: z.number().int().nonnegative() }),
  z.strictObject({ type: z.literal('quill/ready'), id: opaqueId, sourceMemoryId: opaqueId, sourceEventId: opaqueId }),
  z.strictObject({ type: z.literal('quill/given'), id: opaqueId }),
  z.strictObject({ type: z.literal('memory/operation'), operationId: id, kind: z.enum(['extract', 'compact', 'day', 'week', 'month']), source: z.enum(['real', 'fake']),
    status: z.enum(['started', 'success', 'failed']), reservedChars: z.number().int().nonnegative(), error: publicError.optional() }),
  z.strictObject({ type: z.literal('model/attempt'), turnId: id, slot: z.enum(['chat', 'background', 'chat_google', 'chat_claude', 'privacy']), attempt: z.number().int().positive(),
    status: z.enum(['started', 'success', 'failed', 'retry']), waitMs: z.number().nonnegative(), httpStatus: z.number().int().optional(),
    reservedTokens: z.number().int().nonnegative().optional(), bucket: z.enum(['work', 'autonomous']).optional(), resourceReservationId: z.string().uuid().optional(),
    error: z.enum(['configuration', 'network', 'timeout', 'upstream', 'quota', 'cancelled', 'invalid-output', 'interrupted', 'content-filtered']).optional(),
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
