import { createHash, randomUUID } from 'node:crypto'
import { closeSync, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, writeSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { z } from 'zod'
import type { Clock } from '../clock'
import type { JournalRecord } from '../journal/schema'
import type { PublicErrorCode, ResourceBudgetView } from '../../shared'

export class ResourceFailure extends Error { constructor(readonly code: PublicErrorCode) { super('RESOURCE_UNAVAILABLE') } }
export const resourceLimits = z.strictObject({ dailyTotalUnits: z.number().int().min(10000).max(5_000_000), dailyAutonomousUnits: z.number().int().nonnegative().max(5_000_000) }).refine((value) => value.dailyAutonomousUnits <= value.dailyTotalUnits)
const defaults = { dailyTotalUnits: 500_000, dailyAutonomousUnits: 100_000 }
const envelope = { version: z.literal(1), seq: z.number().int().positive(), atMs: z.number().int().nonnegative() }
const recordId = z.string().regex(/^(?:[a-f0-9-]{36}|legacy:[a-f0-9]{64})$/)
const event = z.discriminatedUnion('kind', [
  z.strictObject({ ...envelope, kind: z.literal('header'), id: z.string().uuid() }),
  z.strictObject({ ...envelope, kind: z.literal('model'), id: recordId, units: z.number().int().positive().max(20_000_000), bucket: z.enum(['work', 'autonomous']), legacy: z.boolean().optional() }),
  z.strictObject({ ...envelope, kind: z.literal('speech'), id: recordId, chars: z.number().int().min(1).max(1200), legacy: z.boolean().optional() }),
  z.strictObject({ ...envelope, kind: z.literal('bootstrap'), profile: z.string().regex(/^[a-f0-9]{64}$/) }),
  z.strictObject({ ...envelope, kind: z.literal('limits'), dailyTotalUnits: z.number().int().min(10000).max(5_000_000), dailyAutonomousUnits: z.number().int().nonnegative().max(5_000_000) }),
])
type Row = z.infer<typeof event>
type Input = Row extends infer R ? R extends Row ? Omit<R, 'version' | 'seq'> : never : never
export type ResourceAdmissions = { reserveModel(units: number, bucket: 'work' | 'autonomous'): string; reserveSpeech(chars: number): string }
type Atomic = <T>(body: () => T) => T
const maxBytes = 64 * 1024 * 1024

/** Metadata-only append-only authority, intentionally outside all private-book restore targets.
 * The supplied native mutex protects read/admit/fsync across application processes. */
export function openResourceLedger(options: { root: string; clock: Clock; atomic: Atomic; configurable: boolean }) {
  const root = resolve(options.root); const path = join(root, 'usage.jsonl'); const identity = join(root, 'identity.json'); const { clock } = options
  let cached: { size: number; mtime: number; rows: Row[] } | undefined
  const checkRoot = () => { mkdirSync(root, { recursive: true }); if (lstatSync(root).isSymbolicLink() || realpathSync(root) !== root) throw new ResourceFailure('unavailable') }
  const regular = (file: string, limit: number) => { checkRoot(); const stat = lstatSync(file); if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > limit || realpathSync(file) !== file) throw new ResourceFailure('unavailable'); return stat }
  const protectedCall = <T>(body: () => T): T => { try { return options.atomic(body) } catch (error) { if (error instanceof ResourceFailure) throw error; throw new ResourceFailure('unavailable') } }
  const modelDay = (at = clock.nowMs()) => clock.iso(at + 4 * 3600000).slice(0, 10)
  const speechDay = (at = clock.nowMs()) => clock.iso(at + 8 * 3600000).slice(0, 10)
  const read = () => {
    const stat = regular(path, maxBytes); regular(identity, 128); const marker = z.strictObject({ id: z.string().uuid() }).parse(JSON.parse(readFileSync(identity, 'utf8')))
    if (cached?.size === stat.size && cached.mtime === stat.mtimeMs) { if (cached.rows[0]?.kind !== 'header' || cached.rows[0].id !== marker.id) throw new ResourceFailure('unavailable'); return cached.rows }
    const content = readFileSync(path, 'utf8'); if (!content.endsWith('\n')) throw new ResourceFailure('unavailable')
    const rows = content.slice(0, -1).split('\n').map((line) => event.parse(JSON.parse(line)))
    if (rows[0]?.kind !== 'header' || marker.id !== rows[0].id || rows.some((row, i) => row.seq !== i + 1 || i > 0 && row.kind === 'header')) throw new ResourceFailure('unavailable')
    const ids = rows.flatMap((row) => 'id' in row ? [row.id] : []); if (new Set(ids).size !== ids.length) throw new ResourceFailure('unavailable')
    for (const row of rows) if (row.kind === 'limits') resourceLimits.parse({ dailyTotalUnits: row.dailyTotalUnits, dailyAutonomousUnits: row.dailyAutonomousUnits })
    cached = { size: stat.size, mtime: stat.mtimeMs, rows }; return rows
  }
  const append = (inputs: readonly Input[]) => {
    const rows = read(); const added = inputs.map((input, i) => event.parse({ ...input, version: 1, seq: rows.length + i + 1 }))
    if (!added.length) return
    const bytes = Buffer.from(added.map((row) => JSON.stringify(row)).join('\n') + '\n'); if (regular(path, maxBytes).size + bytes.length > maxBytes) throw new ResourceFailure('unavailable')
    const descriptor = openSync(path, 'a', 0o600)
    try { const disk = fstatSync(descriptor); const expected = regular(path, maxBytes); if (disk.ino !== expected.ino || disk.dev !== expected.dev || disk.nlink !== 1) throw new ResourceFailure('unavailable'); let written = 0; while (written < bytes.length) { const count = writeSync(descriptor, bytes, written); if (!count) throw new ResourceFailure('unavailable'); written += count }; fsyncSync(descriptor) }
    finally { closeSync(descriptor) }
    cached = undefined
  }
  const limits = (rows: readonly Row[]) => { const policy = rows.findLast((row) => row.kind === 'limits'); return policy?.kind === 'limits' ? { dailyTotalUnits: policy.dailyTotalUnits, dailyAutonomousUnits: policy.dailyAutonomousUnits } : defaults }
  const modelRows = (rows: readonly Row[]) => rows.filter((row): row is Extract<Row, { kind: 'model' }> => row.kind === 'model' && modelDay(row.atMs) === modelDay())
  const speechRows = (rows: readonly Row[]) => rows.filter((row): row is Extract<Row, { kind: 'speech' }> => row.kind === 'speech' && speechDay(row.atMs) === speechDay())
  protectedCall(() => {
    checkRoot()
    if (!existsSync(path) && !existsSync(identity)) {
      const id = randomUUID(); const descriptor = openSync(path, 'wx', 0o600)
      try { writeSync(descriptor, JSON.stringify({ version: 1, seq: 1, atMs: clock.nowMs(), kind: 'header', id }) + '\n'); fsyncSync(descriptor) } finally { closeSync(descriptor) }
      const marker = openSync(identity, 'wx', 0o600); try { writeSync(marker, JSON.stringify({ id })); fsyncSync(marker) } finally { closeSync(marker) }
    }
    read() // A partial/corrupt/deleted ledger fails closed, never recreates a zero balance.
  })
  return {
    reserveModel: (units: number, bucket: 'work' | 'autonomous') => protectedCall(() => {
      if (!Number.isSafeInteger(units) || units <= 0 || units > 20_000_000 || !['work', 'autonomous'].includes(bucket)) throw new ResourceFailure('invalid-command')
      const rows = read(); const cap = limits(rows); const today = modelRows(rows)
      if (today.reduce((sum, row) => sum + row.units, 0) + units > cap.dailyTotalUnits || bucket === 'autonomous' && today.filter((row) => row.bucket === 'autonomous').reduce((sum, row) => sum + row.units, 0) + units > cap.dailyAutonomousUnits) throw new ResourceFailure('budget-exceeded')
      const id = randomUUID(); append([{ kind: 'model', id, units, bucket, atMs: clock.nowMs() }]); return id
    }),
    /** Someone set the caps on purpose (a booth operator): they then bind every turn, in any mode. */
    limitsConfigured: () => protectedCall(() => read().some((row) => row.kind === 'limits')),
    /** Spending you started yourself is recorded, not refused, while no caps were set on purpose (DSH turns you sent). */
    recordModel: (units: number, bucket: 'work' | 'autonomous') => protectedCall(() => {
      if (!Number.isSafeInteger(units) || units <= 0 || units > 20_000_000 || !['work', 'autonomous'].includes(bucket)) throw new ResourceFailure('invalid-command')
      const id = randomUUID(); append([{ kind: 'model', id, units, bucket, atMs: clock.nowMs() }]); return id
    }),
    reserveSpeech: (chars: number) => protectedCall(() => {
      if (!Number.isSafeInteger(chars) || chars < 1 || chars > 1200) throw new ResourceFailure('invalid-command')
      const today = speechRows(read()); if (today.length >= 30 || today.reduce((sum, row) => sum + row.chars, 0) + chars > 12000) throw new ResourceFailure('quota-exhausted')
      const id = randomUUID(); append([{ kind: 'speech', id, chars, atMs: clock.nowMs() }]); return id
    }),
    configure: (input: unknown) => protectedCall(() => {
      if (!options.configurable) throw new ResourceFailure('permission-denied')
      const parsed = resourceLimits.safeParse(input); if (!parsed.success) throw new ResourceFailure('invalid-command')
      append([{ kind: 'limits', ...parsed.data, atMs: clock.nowMs() }])
    }),
    bootstrap: (profile: string, history: readonly JournalRecord[]) => protectedCall(() => {
      const profileHash = createHash('sha256').update(profile).digest('hex'); const current = read()
      if (current.some((row) => row.kind === 'bootstrap' && row.profile === profileHash)) return
      const known = new Set(current.flatMap((row) => 'id' in row ? [row.id] : [])); const additions: Input[] = []; let session = ''
      for (const row of history) {
        if (row.type === 'session/header') { session = JSON.stringify([row.userId, row.characterId, row.sessionId]); continue }
        if (!session || row.type !== 'model/attempt' && row.type !== 'voice/attempt' || row.resourceReservationId) continue
        const id = 'legacy:' + createHash('sha256').update(session + ':' + row.seq).digest('hex'); if (known.has(id)) continue
        if (row.type === 'model/attempt' && row.status === 'started' && row.reservedTokens && modelDay(row.atMs) === modelDay()) additions.push({ kind: 'model', id, units: row.reservedTokens, bucket: row.bucket ?? 'work', atMs: row.atMs, legacy: true })
        if (row.type === 'voice/attempt' && speechDay(row.atMs) === speechDay()) additions.push({ kind: 'speech', id, chars: row.charCount, atMs: row.atMs, legacy: true })
        known.add(id)
      }
      append([...additions, { kind: 'bootstrap', profile: profileHash, atMs: clock.nowMs() }])
    }),
    view: (): ResourceBudgetView => {
      const base = { status: 'unavailable' as 'ready' | 'unavailable', accounting: 'reserved-units' as const, configurable: options.configurable,
        model: { dayKey: modelDay(), totalReservedUnits: null as number | null, autonomousReservedUnits: null as number | null, totalLimitUnits: defaults.dailyTotalUnits, autonomousLimitUnits: defaults.dailyAutonomousUnits, attemptCount: null as number | null, legacyReservedUnits: null as number | null },
        speech: { dayKey: speechDay(), reservedChars: null as number | null, charLimit: 12000, attemptCount: null as number | null, attemptLimit: 30 } }
      try { return protectedCall(() => { const rows = read(); const cap = limits(rows); const model = modelRows(rows); const speech = speechRows(rows)
        return { ...base, status: 'ready', model: { dayKey: modelDay(), totalReservedUnits: model.reduce((sum, row) => sum + row.units, 0), autonomousReservedUnits: model.filter((row) => row.bucket === 'autonomous').reduce((sum, row) => sum + row.units, 0), totalLimitUnits: cap.dailyTotalUnits, autonomousLimitUnits: cap.dailyAutonomousUnits, attemptCount: model.length, legacyReservedUnits: model.filter((row) => row.legacy).reduce((sum, row) => sum + row.units, 0) }, speech: { ...base.speech, reservedChars: speech.reduce((sum, row) => sum + row.chars, 0), attemptCount: speech.length } }
      }) } catch { return base }
    },
  }
}
export type ResourceLedger = ReturnType<typeof openResourceLedger>
