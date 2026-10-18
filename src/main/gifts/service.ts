import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { AppCommand, GeneratedGiftView, GiftsView, PublicErrorCode } from '../../shared'
import type { Clock } from '../clock'
import type { Scheduler } from '../scheduler'
import type { SessionStore } from '../store/session'
import type { MemoryRepository } from '../memory/repository'
import type { HarnessTool } from '../harness/tools'
import { GiftMcpFailure, type RodinMcp } from './mcp'
import { giftSpecSchema } from './schema'
import { assetUrl, binaryAssetSchema } from '../storage/assets'
import { sessionDayKey } from '../journal/file'

export function createGiftService(options: { clock: Clock; scheduler: Scheduler; store: SessionStore; memory: MemoryRepository; port: RodinMcp | null; source: 'real' | 'fake'; changed(): void; open(assetRef: string): void }) {
  const { clock, scheduler, store } = options; const records = () => store.history?.() ?? store.records()
  let worker: Promise<void> | undefined; let active: AbortController | undefined; let disposed = false; let enabled = true
  const read = () => { const gifts = new Map<string, GeneratedGiftView>(); for (const row of records()) if (row.type === 'gift/state') gifts.set(row.gift.id, row.gift); return [...gifts.values()] }
  const commit = (gift: GeneratedGiftView) => { store.append({ type: 'gift/state', gift }); options.changed() }
  const reserved = () => new Set(records().flatMap((row) => row.type === 'gift/state' && row.gift.status === 'making' && sessionDayKey(clock, row.atMs) === sessionDayKey(clock) ? [row.gift.id] : [])).size
  const update = (id: string) => read().find((gift) => gift.id === id)
  const perform = (gift: GeneratedGiftView, start: boolean) => {
    const abort = new AbortController(); active = abort
    worker = (async () => {
      if (start) { commit({ ...gift, status: 'making' }); await options.port!.call('begin', { id: gift.id, objectId: gift.objectId, motif: gift.motif }, abort.signal) }
      else {
        const began = records().find((row) => row.type === 'gift/state' && row.gift.id === gift.id && row.gift.status === 'making')?.atMs ?? gift.createdAtMs
        const result = z.object({ state: z.enum(['waiting', 'ready', 'failed']), asset: binaryAssetSchema.optional() }).parse(await options.port!.call('poll', { id: gift.id }, abort.signal))
        if (abort.signal.aborted || update(gift.id)?.status !== 'making') return
        if (result.state === 'failed' || result.state === 'waiting' && clock.nowMs() - began > 10 * 60_000) commit({ ...gift, status: 'failed', error: { code: 'unavailable', retryable: false } })
        if (result.state === 'ready') { if (!result.asset) throw new Error('GIFT_RESULT_INVALID'); store.append({ type: 'asset/stored', asset: result.asset }); commit({ ...gift, status: 'ready', readyAtMs: clock.nowMs(), assetRef: result.asset.ref, assetUrl: assetUrl(result.asset) }) }
      }
    })().catch((cause: unknown) => { if (!abort.signal.aborted && update(gift.id)?.status === 'making') commit({ ...gift, status: 'failed', error: { code: cause instanceof GiftMcpFailure ? cause.code : 'connection-failed', retryable: false } }) })
      .finally(() => { active = undefined; worker = undefined; options.changed() })
  }
  const start = (gift: GeneratedGiftView): PublicErrorCode | undefined => {
    if (!options.port) return 'not-configured'
    if (!enabled || disposed || worker || store.projection().lightsOut || store.projection().pomodoro.phase !== 'focus') return 'unavailable'
    if (gift.status !== 'proposed') return 'invalid-command'
    if (reserved() >= 1) return 'budget-exceeded'
    perform(gift, true)
  }
  const reconcile = () => {
    if (!enabled || disposed || worker || store.projection().lightsOut || !options.port) return
    const gifts = read(); const making = gifts.find((gift) => gift.status === 'making')
    if (making) { perform(making, false); return }
    const state = store.projection(); if (state.mode === 'rest' && state.pomodoro.phase !== 'focus') for (const gift of gifts.filter((gift) => gift.status === 'ready')) commit({ ...gift, status: 'given', givenAtMs: clock.nowMs() })
    if (state.pomodoro.phase === 'focus' && reserved() < 1) { const proposed = gifts.find((gift) => gift.status === 'proposed'); if (proposed) start(proposed) }
  }
  scheduler.schedule('gifts.lifecycle', clock.nowMs() + 5000, reconcile, { everyMs: 5000 })
  return {
    view: (): GiftsView => ({ configured: !!options.port && enabled, dailyLimit: 1, items: read() }), reconcile,
    dispatch: (command: AppCommand): PublicErrorCode | undefined => {
      if (disposed || !enabled) return 'unavailable'
      if (command.type === 'gift.propose') {
        if (!options.port) return 'not-configured'
        const body = giftSpecSchema.safeParse({ sourceMemoryId: command.sourceMemoryId, objectId: command.objectId, motif: command.motif })
        if (!body.success) return 'invalid-command'
        options.memory.refresh(); const memory = options.memory.view().items.find((item) => item.id === command.sourceMemoryId && item.kind === 'experience' && !item.supersededBy)
        if (!memory || !memory.sources.length) return 'evidence-unavailable'
        if (read().some((gift) => ['proposed', 'making', 'ready'].includes(gift.status))) return 'unavailable'
        commit({ ...body.data, id: randomUUID(), source: options.source, status: 'proposed', createdAtMs: clock.nowMs(), readyAtMs: null, givenAtMs: null }); return
      }
      if (!('giftId' in command)) return 'invalid-command'
      const gift = update(command.giftId); if (!gift) return 'invalid-command'
      if (command.type === 'gift.accept') {
        if (gift.status !== 'proposed' || gift.acceptedAtMs) return gift.status === 'proposed' ? undefined : 'invalid-command'
        commit({ ...gift, acceptedAtMs: clock.nowMs() }); return
      }
      if (command.type === 'gift.start') return start(gift)
      if (command.type === 'gift.cancel') { if (!['proposed', 'making'].includes(gift.status)) return 'invalid-command'; active?.abort(); commit({ ...gift, status: 'cancelled' }); return }
      if (command.type === 'gift.open') { if (!gift.assetRef || !['ready', 'given'].includes(gift.status)) return 'unavailable'; options.open(gift.assetRef); return }
      return 'invalid-command'
    },
    setEnabled: (value: boolean) => { enabled = value; if (!value) active?.abort(); options.changed() },
    stateChanged: () => { if (store.projection().lightsOut) active?.abort() },
    idle: async () => { await worker }, close: async () => { disposed = true; scheduler.cancel('gifts.lifecycle'); active?.abort(); await worker; await options.port?.close() },
  }
}
export type GiftService = ReturnType<typeof createGiftService>
export function giftTools(service: GiftService): HarnessTool[] {
  return [{ definition: { name: 'propose_gift', description: 'Propose one 3D keepsake grounded in an existing witnessed experience. No raw memory text or personal names go to generation. Actual making waits for focus; ready is not given. At most one submission per day, including failed submissions.', parameters: { type: 'object', properties: { sourceMemoryId: { type: 'string' }, objectId: { enum: ['cup', 'paper-bridge', 'leaf', 'shell', 'quill'] }, motif: { enum: ['plain', 'sakura', 'stars'] } }, required: ['sourceMemoryId', 'objectId', 'motif'], additionalProperties: false } }, templateId: 'gift.propose', validate: (input) => giftSpecSchema.safeParse(input).success,
    run: async (input, { signal }) => { signal.throwIfAborted(); const spec = giftSpecSchema.parse(input); const error = service.dispatch({ protocolVersion: 1, epoch: 'internal', requestId: randomUUID(), type: 'gift.propose', ...spec }); const value: Record<string, string | boolean> = error ? { error } : { proposed: true, submitted: false }; return { ok: !error, raw: value, visible: value } } }]
}
