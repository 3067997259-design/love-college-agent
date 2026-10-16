import { z } from 'zod'
import { viewSchema } from '../pomodoro/schema'

export const DATABASES = ['projections.sqlite', 'campus.sqlite', 'documents.sqlite', 'memory.sqlite'] as const
export const MANAGED_NAMES = ['journals', 'artifacts', ...DATABASES, ...DATABASES.flatMap((name) => [name + '-wal', name + '-shm'])] as const
export const MAX_ARCHIVE_BYTES = 128 * 1024 * 1024
export const MAX_UNPACKED_BYTES = 512 * 1024 * 1024
export const manifestSchema = z.strictObject({ formatVersion: z.literal(1), kind: z.literal('lca-private-save'), archiveId: z.string().uuid(), savedAtMs: z.number().int().nonnegative(),
  owner: z.strictObject({ userId: z.string().min(1).max(128), characterId: z.string().min(1).max(128) }), source: z.enum(['real', 'fake']),
  activeDayKey: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), activeSessionId: z.string().min(1).max(128),
  pomodoro: viewSchema, pomodoroPause: z.enum(['manual', 'lights']).nullable(), fileFilteringEnabled: z.boolean(),
  counts: z.strictObject({ pageCount: z.number().int().nonnegative(), messageCount: z.number().int().nonnegative(), memoryCount: z.number().int().nonnegative(), deliveryCount: z.number().int().nonnegative() }),
  files: z.array(z.strictObject({ path: z.string().min(1).max(240), bytes: z.number().int().nonnegative().max(128 * 1024 * 1024), sha256: z.string().regex(/^[a-f0-9]{64}$/) })).min(1).max(2000),
})
export type SaveManifest = z.infer<typeof manifestSchema>
export class BackupFailure extends Error { constructor(readonly code: 'backup-invalid' | 'backup-scope-mismatch' | 'export-failed' | 'restore-failed' | 'file-too-large' | 'unavailable') { super('PRIVATE_SAVE_FAILED') } }
