import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { createManualClock } from '../../src/main/clock'
import { openJournal } from '../../src/main/journal/file'
import { projectJournal } from '../../src/main/journal/projection'
import { createBinaryAssets } from '../../src/main/storage/assets'
import { createHistoryPhotos } from '../../src/main/history/photos'
import type { SessionStore } from '../../src/main/store/session'
const cleanup: (() => void)[] = []
afterEach(() => cleanup.splice(0).reverse().forEach((fn) => fn()))
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7ioAAAAASUVORK5CYII=', 'base64')
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'lca-photos-')); cleanup.push(() => { if (!resolve(root).startsWith(join(resolve(tmpdir()), 'lca-photos-'))) throw new Error('UNSAFE'); rmSync(root, { recursive: true, force: true }) })
  const clock = createManualClock(1000); const journal = openJournal(root, { userId: 'u', characterId: 'c' }, clock); cleanup.push(journal.close)
  const store: SessionStore = { scope: journal.scope, records: journal.records, append: journal.append, projection: () => projectJournal(journal.records()), close: journal.close }
  const assets = createBinaryAssets(root, store); const capture = vi.fn(async () => ({ png, width: 1, height: 1 }))
  const options = { store, clock, assets, capture, canCapture: () => true, changed: () => {} }; const photos = createHistoryPhotos(options)
  return { root, store, clock, assets, capture, options, photos }
}
it('stores immutable scoped PNG assets and restores the chosen photo from the journal', async () => {
  const f = fixture(); expect(f.photos.capture('work', 'done')).toBeUndefined(); await f.photos.idle()
  const photo = f.photos.photo(f.store.scope.sessionId)!; expect(photo.reason).toBe('work'); expect(photo.imageUrl).toMatch(/^lca-media:\/\/asset\/[a-f0-9]{64}$/)
  expect(f.photos.capture('work', 'done')).toBe('unavailable')
  f.clock.advanceBy(100); f.photos.capture('day-end', 'sleep'); await f.photos.idle(); expect(f.photos.photo(f.store.scope.sessionId)).toEqual(photo)
  expect(createHistoryPhotos(f.options).photos()).toEqual([photo]); expect(f.store.records().filter((row) => row.type === 'asset/stored')).toHaveLength(2)
  expect(JSON.stringify(f.photos.view())).not.toContain('eventId')
})
it('bounds failures and can recover from a synchronous capture failure', async () => {
  const f = fixture(); f.capture.mockImplementation(() => { throw new Error('SYNTHETIC_CAPTURE_FAILURE') })
  for (let index = 0; index < 3; index++) { expect(f.photos.capture('work', 'failed')).toBeUndefined(); await f.photos.idle() }
  expect(f.photos.capture('work', 'failed')).toBe('unavailable'); expect(f.photos.view().captureStatus).toBe('failed'); expect(f.photos.photos()).toEqual([])
  expect(JSON.stringify(f.photos.view())).not.toContain('SYNTHETIC_CAPTURE_FAILURE')
  f.capture.mockResolvedValue({ png, width: 1, height: 1 }); f.photos.capture(); await f.photos.idle(); expect(f.photos.photos()).toHaveLength(1)
})
it('drops a capture that finishes after shutdown', async () => {
  const f = fixture(); let release!: (value: { png: typeof png; width: number; height: number }) => void
  f.capture.mockImplementation(() => new Promise((resolve) => { release = resolve }))
  f.photos.capture(); await Promise.resolve(); const closing = f.photos.close(); release({ png, width: 1, height: 1 }); await closing
  expect(f.photos.photos()).toEqual([]); expect(f.store.records().some((row) => row.type === 'asset/stored')).toBe(false)
})
