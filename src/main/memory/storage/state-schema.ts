import { z } from 'zod'
import { isSameMemoryScope, parseMemorySourceContext, type MemoryScope } from '../airi/core'

const text = z.string().max(20_000)
const id = z.string().min(1).max(256)
const time = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const scopeSchema = z.strictObject({ userId: z.string().min(1).max(128), characterId: z.string().min(1).max(128) })
const presentation = { title: z.string().max(64).optional(), summary: z.string().max(150).optional(), revision: z.number().int().positive().optional(),
  summaryRevision: z.number().int().nonnegative().optional(), pinned: z.boolean().optional(), pinOrder: z.number().int().nonnegative().optional() }
const embedding = z.array(z.number().finite()).refine(value => [768, 1024, 1536].includes(value.length))
const metadata = z.strictObject({ embeddingProvider: z.string().max(256), embeddingModel: z.string().max(256), embeddingDimensions: z.union([z.literal(768), z.literal(1024), z.literal(1536)]),
  embeddingInputType: z.enum(['query', 'document']), embeddingSourceFingerprint: z.string().max(8192), embeddedAt: time, embeddingStatus: z.enum(['active', 'stale']) })
const absolute = { ...presentation, content: text.optional(), category: z.string().max(128).optional(), importance: z.number().finite().optional(),
  reviewStatus: z.enum(['pending', 'approved', 'rejected']).optional(), factStatus: z.enum(['active', 'superseded', 'disputed']).optional(),
  supersedesId: id.optional(), conflictGroup: id.optional(), embedding: embedding.optional(), embeddingMetadata: metadata.optional() }
const outboxItem = z.strictObject({ ...absolute, kind: z.enum(['insert', 'update', 'delete']).optional(), originId: id, operationId: id.optional(), reconcile: z.boolean().optional(),
  memoryType: z.enum(['short_term', 'long_term', 'muscle']).optional(), valence: z.number().finite().optional(), arousal: z.number().finite().optional(), halfLifeHours: z.number().finite().positive().optional(),
  sessionId: id.optional(), scope: scopeSchema.optional(), sourceContext: z.custom(value => parseMemorySourceContext(value) !== undefined).optional(), patch: z.strictObject(absolute).optional(),
  attempts: z.number().int().nonnegative(), nextAttemptAt: time, lastError: text.optional(), createdAt: time })
const prefix = 'settings/memory/'
const booleans = ['enabled', 'capture-enabled', 'directory-enabled', 'tools-enabled', 'intrusion-enabled', 'dreaming-enabled', 'automatic-dreaming-enabled', 'long-term-sync-enabled']
const numbers = ['short-term-half-life-hours', 'long-term-half-life-hours', 'promotion-access-count', 'promotion-session-count', 'weight-similarity', 'weight-time-relevance',
  'weight-arousal', 'weight-access-count', 'weight-mood-congruence', 'intrusion-base-rate', 'intrusion-cooldown-ms', 'dreaming-interval-hours', 'dreaming-daily-budget',
  'dreaming-min-new-memory-count', 'last-dream-at', 'dreaming-budget-used', 'last-long-term-sync-at']
const strings = ['dreaming-budget-date-key', 'embedding-fingerprint', 'last-long-term-sync-error']
const shape: Record<string, z.ZodType> = Object.fromEntries([
  ...booleans.map(key => [prefix + key, z.boolean().optional()]),
  ...numbers.map(key => [prefix + key, z.number().finite().nonnegative().max(Number.MAX_SAFE_INTEGER).optional()]),
  ...strings.map(key => [prefix + key, text.optional()]),
])
shape[prefix + 'long-term-sync-outbox'] = z.array(outboxItem).max(100_000).optional()
shape[prefix + 'embedding-migration'] = z.strictObject({ sourceFingerprint: z.string().max(8192), ids: z.array(id).max(100_000), nextIndex: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(), state: z.enum(['idle', 'running', 'complete', 'error']), updatedAt: time, lastError: text.optional() }).refine(value => value.total === value.ids.length && value.nextIndex <= value.total).optional()
const runtimeSchema = z.strictObject(shape)
const captureSchema = z.strictObject({ 'captured-sources': z.record(z.string().regex(/^[a-f0-9]{64}$/), time).optional(), 'last-extracted-at': time.nullable().optional() })

/** Archive validation never fills in credentials, evaluates expressions, or
 * changes scope. Every restored queue entry remains in the original outbox. */
export function validateMemoryState(bytes: Uint8Array, kind: 'runtime' | 'capture', scope: MemoryScope) {
  if (bytes.byteLength > 64 * 1024 * 1024) throw new Error('MEMORY_STATE_TOO_LARGE')
  const value: unknown = JSON.parse(Buffer.from(bytes).toString('utf8'))
  if (kind === 'capture') { captureSchema.parse(value); return }
  const parsed = runtimeSchema.parse(value)
  const queue = parsed[prefix + 'long-term-sync-outbox'] as z.infer<typeof outboxItem>[] | undefined
  if (queue?.some(item => item.scope && !isSameMemoryScope(item.scope, scope) || (!item.kind || item.kind === 'insert') && !item.scope)) throw new Error('MEMORY_STATE_SCOPE_MISMATCH')
}
