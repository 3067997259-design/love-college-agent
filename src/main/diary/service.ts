import { createHash, randomBytes } from 'node:crypto'
import type { DiaryRead, DiaryView, PublicErrorCode } from '../../shared'
import type { Clock } from '../clock'
import type { Scheduler } from '../scheduler'
import type { SessionStore } from '../store/session'
import type { BinaryAssets } from '../storage/assets'
import { seenFragments } from '../memory/seen'
import { sessionDayKey } from '../journal/file'
import { redactFixed } from '../privacy/redact'
import { diaryOutput, diarySchema, type DiaryModel } from './schema'
import { decryptDiaryZip, encryptDiaryZip } from './zipcrypto'
/** Streaming replies often pass thirty seconds; match the model client's total bound. */
const DIARY_WRITE_TIMEOUT_MS = 120_000
/** Writing on her own waits for a pause in the conversation, so a chat rarely interrupts it. */
const DIARY_IDLE_MS = 3 * 60_000
/** An interrupted or failed day stays unwritten, not settled: try it again after this gap. */
const DIARY_RETRY_GAP_MS = 10 * 60_000
const DIARY_DAILY_ATTEMPTS = 3
/** A written diary is readable at once. A page she folded waits for its own evening; older entries carry their own past unlock time. */
const FOLDED_PAGE_HOLD_MS = 18 * 3600_000
const readableAt = (entry: { createdAtMs: number; unlockAtMs: number }) => entry.unlockAtMs
export function createDiary(options: { clock: Clock; scheduler: Scheduler; store: SessionStore; assets: BinaryAssets; model: DiaryModel | null; busy(): boolean; changed(): void; projected(): void }) {
  const { store, clock } = options; const rows = () => store.history?.() ?? store.records(); const entries = () => rows().flatMap((row) => row.type === 'diary/written' ? [row.diary] : [])
  let active: AbortController | undefined; let worker: Promise<void> | undefined; let failed = false
  const unfinishedAttempt = () => rows().some((row) => row.type === 'diary/attempt' && !entries().some((entry) => entry.dayKey === row.dayKey) && row.dayKey >= sessionDayKey(clock, clock.nowMs() - 3 * 86400000))
  const canWrite = (): PublicErrorCode | undefined => {
    if (!options.model) return 'not-configured'
    if (worker || options.busy() || store.projection().lightsOut) return 'unavailable'
    if (rows().filter((row) => row.type === 'diary/attempt' && sessionDayKey(clock, row.atMs) === sessionDayKey(clock)).length >= DIARY_DAILY_ATTEMPTS) return 'budget-exceeded'
  }
  const write = (manual = false) => {
    if (worker || !options.model || options.busy() || store.projection().lightsOut) return worker ?? Promise.resolve()
    const now = clock.nowMs(); const history = rows()
    const lastUser = history.findLast((row) => row.type === 'user/message')?.atMs
    if (!manual && lastUser !== undefined && now - lastUser < DIARY_IDLE_MS) return Promise.resolve()
    const pages = new Map(store.pages?.().map((page) => [page.sessionId, page.dayKey]) ?? [])
    const sourceDay = (source: { sessionId: string; atMs: number }) => pages.get(source.sessionId) ?? sessionDayKey(clock, source.atMs)
    const today = store.dayKey?.() ?? sessionDayKey(clock)
    const fragments = seenFragments(history).filter((source) => sourceDay(source) < today && sourceDay(source) >= sessionDayKey(clock, now - 3 * 86400000))
    const day = fragments.map(sourceDay).filter((day) => !entries().some((entry) => entry.dayKey === day)).sort().at(-1)
    if (!day) return Promise.resolve()
    const lastAttempt = history.findLast((row) => row.type === 'diary/attempt' && row.dayKey === day)?.atMs
    if (!manual && lastAttempt !== undefined && now - lastAttempt < DIARY_RETRY_GAP_MS) return Promise.resolve()
    const attempts = history.filter((row) => row.type === 'diary/attempt' && sessionDayKey(clock, row.atMs) === sessionDayKey(clock)).length
    if (attempts >= DIARY_DAILY_ATTEMPTS) { failed = true; options.changed(); return Promise.resolve() }
    const input = fragments.filter((fragment) => sourceDay(fragment) === day).slice(-12).map(({ id, text }) => ({ id, text }))
    const abort = new AbortController(); active = abort; failed = false; store.append({ type: 'diary/attempt', dayKey: day }); options.changed()
    worker = (async () => {
      const stop = clock.after(DIARY_WRITE_TIMEOUT_MS, () => abort.abort()); let remove = () => {}
      try {
        const output = await Promise.race([options.model!.write(input, abort.signal), new Promise<never>((_resolve, reject) => { const listener = () => reject(new Error('DIARY_STOPPED')); abort.signal.addEventListener('abort', listener, { once: true }); remove = () => abort.signal.removeEventListener('abort', listener); if (abort.signal.aborted) listener() })])
        abort.signal.throwIfAborted(); const parsed = diaryOutput.parse(output); const text = redactFixed(parsed.entry); const key = randomBytes(8).toString('hex').toUpperCase()
        const asset = options.assets.write(encryptDiaryZip(text, key, day), 'zip'); store.append({ type: 'asset/stored', asset })
        const id = 'diary:' + createHash('sha256').update(JSON.stringify([store.scope.userId, store.scope.characterId, day])).digest('hex')
        const writtenAt = clock.nowMs()
        // She folded this page for a night: the key stays in the ribbon until the next evening. A
        // manual "write it now" is the user asking to read it, so it opens at once.
        const unlockAtMs = !manual && parsed.shy === true ? writtenAt + FOLDED_PAGE_HOLD_MS : writtenAt
        const diary = diarySchema.parse({ id, dayKey: day, createdAtMs: writtenAt, unlockAtMs, key, asset, sourceIds: input.map((source) => source.id), source: options.model!.source })
        store.append({ type: 'diary/written', diary }); options.projected()
      } catch { if (!abort.signal.aborted) failed = true }
      finally { remove(); stop(); active = undefined; worker = undefined; options.changed() }
    })(); return worker
  }
  options.scheduler.schedule('diary.daily', clock.nowMs() + 10000, () => { void write() }, { everyMs: 60000 })
  return { write, canWrite,
    view: (): DiaryView => ({ status: worker ? 'writing' : !options.model ? 'unconfigured' : failed || unfinishedAttempt() ? 'failed' : 'idle', source: options.model?.source ?? 'none', entries: entries().slice(-100).map((entry) => ({ id: entry.id, dayKey: entry.dayKey, createdAtMs: entry.createdAtMs, unlocked: clock.nowMs() >= readableAt(entry), clue: 'next-bookmark', source: entry.source })) }),
    read: (id: string): DiaryRead => { const entry = entries().find((diary) => diary.id === id); if (!entry || clock.nowMs() < readableAt(entry)) throw new Error('DIARY_LOCKED'); return { id: entry.id, dayKey: entry.dayKey, key: entry.key, text: decryptDiaryZip(options.assets.read(entry.asset), entry.key), subjective: true } },
    foreground: () => active?.abort(), close: async () => { active?.abort(); options.scheduler.cancel('diary.daily'); await worker }, idle: async () => { await worker },
  }
}
export type DiaryService = ReturnType<typeof createDiary>
