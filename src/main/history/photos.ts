import { randomUUID } from 'node:crypto'
import type { HistoryPhotoView, HistoryView, PublicErrorCode } from '../../shared'
import type { Clock } from '../clock'
import type { SessionStore } from '../store/session'
import { assetUrl, type BinaryAssets } from '../storage/assets'
import { sessionDayKey } from '../journal/file'

type Reason = HistoryPhotoView['reason']
const priority: Record<Reason, number> = { 'day-end': 1, work: 2, outing: 3, gift: 4, manual: 5 }
export function createHistoryPhotos(options: { store: SessionStore; clock: Clock; assets: BinaryAssets; changed(): void; canCapture(): boolean;
  capture(sessionId: string): Promise<{ png: Buffer; width: number; height: number }> }) {
  const { store, assets, clock } = options; const rows = () => store.history?.() ?? store.records()
  let worker: Promise<void> | undefined; let disposed = false; let captureStatus: HistoryView['captureStatus'] = 'idle'
  const photos = (): HistoryPhotoView[] => {
    const chosen = new Map<string, HistoryPhotoView>()
    for (const row of rows()) if (row.type === 'history/photo' && assets.has(row.photo.asset)) {
      const photo = { ...row.photo, capturedAtMs: row.atMs, imageUrl: assetUrl(row.photo.asset) }; const old = chosen.get(photo.sessionId)
      if (!old || priority[photo.reason] >= priority[old.reason]) chosen.set(photo.sessionId, photo)
    }
    return [...chosen.values()].map(({ id, sessionId, dayKey, capturedAtMs, reason, imageUrl, width, height }) => ({ id, sessionId, dayKey, capturedAtMs, reason, imageUrl, width, height }))
  }
  const capture = (reason: Reason = 'manual', eventId: string = randomUUID()): PublicErrorCode | undefined => {
    if (disposed || worker || !options.canCapture()) return 'unavailable'
    const sessionId = store.scope.sessionId; const attempts = rows().filter((row) => row.type === 'history/photo-attempt' && row.sessionId === sessionId && row.eventId === eventId && row.status === 'started')
    if (attempts.length >= 3 || rows().some((row) => row.type === 'history/photo' && row.photo.eventId === eventId && row.photo.sessionId === sessionId)) return 'unavailable'
    store.append({ type: 'history/photo-attempt', sessionId, eventId, status: 'started' }); captureStatus = 'capturing'; options.changed()
    worker = Promise.resolve().then(async () => {
      try {
        const image = await options.capture(sessionId)
        if (disposed || store.scope.sessionId !== sessionId || !options.canCapture()) throw new Error('PHOTO_STALE')
        const asset = assets.write(image.png, 'png')
        store.append({ type: 'asset/stored', asset })
        store.append({ type: 'history/photo', photo: { id: randomUUID(), sessionId, dayKey: store.dayKey?.() ?? sessionDayKey(clock), reason, eventId, asset, width: image.width, height: image.height } })
        captureStatus = 'idle'
      } catch { captureStatus = 'failed'; if (!disposed) store.append({ type: 'history/photo-attempt', sessionId, eventId, status: 'failed' }) }
      finally { worker = undefined; options.changed() }
    })
    return undefined
  }
  return {
    capture, photos, photo: (sessionId: string) => photos().find((photo) => photo.sessionId === sessionId),
    view: () => ({ photos: photos().slice(-30), captureStatus, ...(captureStatus === 'failed' ? { captureError: { code: 'unavailable' as const, retryable: true } } : {}) }),
    reconcile: () => {
      if (worker || disposed || !options.canCapture()) return
      const candidates: { reason: Reason; eventId: string }[] = []
      for (const row of store.records()) {
        if (row.type === 'gift/state' && row.gift.status === 'given') candidates.push({ reason: 'gift', eventId: 'gift:' + row.gift.id })
        if (row.type === 'life/state') for (const outing of row.view.outings) if (outing.status === 'returned' && !outing.offline && outing.settledAtMs !== null && sessionDayKey(clock, outing.settledAtMs) === (store.dayKey?.() ?? sessionDayKey(clock))) candidates.push({ reason: 'outing', eventId: outing.id })
        if (row.type === 'campus/exported' || row.type === 'document/completed') candidates.push({ reason: 'work', eventId: 'work:' + store.scope.sessionId + ':' + row.seq })
      }
      const current = photos().find((photo) => photo.sessionId === store.scope.sessionId)
      const selected = candidates.filter((item) => !current || priority[item.reason] > priority[current.reason]).sort((a, b) => priority[b.reason] - priority[a.reason])[0]
      if (selected) capture(selected.reason, selected.eventId)
    },
    idle: async () => { await worker },
    close: async () => { disposed = true; await worker },
  }
}
export type HistoryPhotos = ReturnType<typeof createHistoryPhotos>
