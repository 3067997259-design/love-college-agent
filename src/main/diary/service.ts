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
export function createDiary(options: { clock: Clock; scheduler: Scheduler; store: SessionStore; assets: BinaryAssets; model: DiaryModel | null; busy(): boolean; changed(): void; projected(): void }) {
  const { store, clock } = options; const rows = () => store.history?.() ?? store.records(); const entries = () => rows().flatMap((row) => row.type === 'diary/written' ? [row.diary] : [])
  let active: AbortController | undefined; let worker: Promise<void> | undefined; let failed = false
  const unfinishedAttempt = () => rows().some((row) => row.type === 'diary/attempt' && !entries().some((entry) => entry.dayKey === row.dayKey) && row.dayKey >= sessionDayKey(clock, clock.nowMs() - 3 * 86400000))
  const canWrite = (): PublicErrorCode | undefined => {
    if (!options.model) return 'not-configured'
    if (worker || options.busy() || store.projection().lightsOut) return 'unavailable'
    if (rows().filter((row) => row.type === 'diary/attempt' && sessionDayKey(clock, row.atMs) === sessionDayKey(clock)).length >= 3) return 'budget-exceeded'
  }
  const write = (manual = false) => {
    if (worker || !options.model || options.busy() || store.projection().lightsOut) return worker ?? Promise.resolve()
    const pages = new Map(store.pages?.().map((page) => [page.sessionId, page.dayKey]) ?? [])
    const sourceDay = (source: { sessionId: string; atMs: number }) => pages.get(source.sessionId) ?? sessionDayKey(clock, source.atMs)
    const today = store.dayKey?.() ?? sessionDayKey(clock)
    const fragments = seenFragments(rows()).filter((source) => sourceDay(source) < today && sourceDay(source) >= sessionDayKey(clock, clock.nowMs() - 3 * 86400000))
    const day = fragments.map(sourceDay).filter((day) => !entries().some((entry) => entry.dayKey === day)).sort().at(-1)
    if (!day || !manual && rows().some((row) => row.type === 'diary/attempt' && row.dayKey === day)) return Promise.resolve()
    const attempts = rows().filter((row) => row.type === 'diary/attempt' && sessionDayKey(clock, row.atMs) === sessionDayKey(clock)).length
    if (attempts >= 3) { failed = true; options.changed(); return Promise.resolve() }
    const input = fragments.filter((fragment) => sourceDay(fragment) === day).slice(-12).map(({ id, text }) => ({ id, text }))
    const abort = new AbortController(); active = abort; failed = false; store.append({ type: 'diary/attempt', dayKey: day }); options.changed()
    worker = (async () => {
      const stop = clock.after(30000, () => abort.abort()); let remove = () => {}
      try {
        const output = await Promise.race([options.model!.write(input, abort.signal), new Promise<never>((_resolve, reject) => { const listener = () => reject(new Error('DIARY_STOPPED')); abort.signal.addEventListener('abort', listener, { once: true }); remove = () => abort.signal.removeEventListener('abort', listener); if (abort.signal.aborted) listener() })])
        abort.signal.throwIfAborted(); const parsed = diaryOutput.parse(output); const text = redactFixed(parsed.entry); const key = randomBytes(8).toString('hex').toUpperCase()
        const asset = options.assets.write(encryptDiaryZip(text, key, day), 'zip'); store.append({ type: 'asset/stored', asset })
        const id = 'diary:' + createHash('sha256').update(JSON.stringify([store.scope.userId, store.scope.characterId, day])).digest('hex')
        const diary = diarySchema.parse({ id, dayKey: day, createdAtMs: clock.nowMs(), unlockAtMs: clock.parse(sessionDayKey(clock) + 'T04:00:00+08:00') + 86400000, key, asset, sourceIds: input.map((source) => source.id), source: options.model!.source })
        store.append({ type: 'diary/written', diary }); options.projected()
      } catch { if (!abort.signal.aborted) failed = true }
      finally { remove(); stop(); active = undefined; worker = undefined; options.changed() }
    })(); return worker
  }
  options.scheduler.schedule('diary.daily', clock.nowMs() + 10000, () => { void write() }, { everyMs: 60000 })
  return { write, canWrite,
    view: (): DiaryView => ({ status: worker ? 'writing' : !options.model ? 'unconfigured' : failed || unfinishedAttempt() ? 'failed' : 'idle', source: options.model?.source ?? 'none', entries: entries().slice(-100).map((entry) => ({ id: entry.id, dayKey: entry.dayKey, createdAtMs: entry.createdAtMs, unlocked: clock.nowMs() >= entry.unlockAtMs, clue: 'next-bookmark', source: entry.source })) }),
    read: (id: string): DiaryRead => { const entry = entries().find((diary) => diary.id === id); if (!entry || clock.nowMs() < entry.unlockAtMs) throw new Error('DIARY_LOCKED'); return { id: entry.id, dayKey: entry.dayKey, key: entry.key, text: decryptDiaryZip(options.assets.read(entry.asset), entry.key), subjective: true } },
    foreground: () => active?.abort(), close: async () => { active?.abort(); options.scheduler.cancel('diary.daily'); await worker }, idle: async () => { await worker },
  }
}
export type DiaryService = ReturnType<typeof createDiary>
