import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, readFileSync, existsSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { encryptDiaryZip, decryptDiaryZip } from '../../src/main/diary/zipcrypto'
import { createManualClock } from '../../src/main/clock'
import { openJournal } from '../../src/main/journal/file'
import { projectJournal } from '../../src/main/journal/projection'
import { createScheduler } from '../../src/main/scheduler'
import { createBinaryAssets } from '../../src/main/storage/assets'
import { createDiary } from '../../src/main/diary/service'
import { createRoomProjection } from '../../src/main/room/projection'
import type { SessionStore } from '../../src/main/store/session'
const cleanups: (() => void)[] = []
afterEach(() => cleanups.splice(0).reverse().forEach((cleanup) => cleanup()))
it('creates traditional encrypted ZIP independently readable by Python zipfile', () => {
  const zip = encryptDiaryZip('主观日记\nSYNTHETIC_DIARY', 'SYNTHETIC_TEST_PASSWORD', '2026-10-16')
  expect(zip.includes(Buffer.from('SYNTHETIC_DIARY'))).toBe(false); expect(decryptDiaryZip(zip, 'SYNTHETIC_TEST_PASSWORD')).toContain('SYNTHETIC_DIARY'); expect(() => decryptDiaryZip(zip, 'wrong')).toThrow()
  // Windows CI's cold Python startup took 8s. Bound the child itself and leave time for process setup;
  // retain the independent-reader/content assertions instead of replacing them with our own decoder.
  const result = execFileSync('python', ['-c', 'import sys,json,base64,io,zipfile\nx=json.load(sys.stdin)\nz=zipfile.ZipFile(io.BytesIO(base64.b64decode(x["zip"])))\nassert z.read("2026-10-16.md",pwd=b"SYNTHETIC_TEST_PASSWORD").decode("utf-8")=="主观日记\\nSYNTHETIC_DIARY"\nprint("PASS")'], { input: JSON.stringify({ zip: zip.toString('base64') }), encoding: 'utf8', windowsHide: true, timeout: 20_000 })
  expect(result.trim()).toBe('PASS')
}, 30_000)
it('writes once from seen-only materials, locks then unlocks immutable keys, rebuilds encrypted projections', async () => {
  const root = mkdtempSync(join(tmpdir(), 'lca-diary-')); cleanups.push(() => { if (!resolve(root).startsWith(join(resolve(tmpdir()), 'lca-diary-'))) throw new Error('UNSAFE'); rmSync(root, { recursive: true, force: true }) })
  const clock = createManualClock(0); clock.advanceBy(clock.parse('2026-10-16T12:00:00+08:00')); const journal = openJournal(root, { userId: 'u', characterId: 'c' }, clock)
  const store: SessionStore = { scope: journal.scope, records: journal.records, append: journal.append, projection: () => projectJournal(journal.records()), close: journal.close }
  store.append({ type: 'model/seen', turnId: 'seen', source: 'fake', messages: [{ role: 'user', content: 'ONLY_SEEN_INPUT' }], eligibleIndexes: [0] })
  store.append({ type: 'tool/result', turnId: 'seen', callId: 'private', raw: { text: 'PRIVATE_ORIGINAL' }, visible: {}, ok: true, elapsedMs: 0 })
  clock.advanceBy(13 * 3600000); const scheduler = createScheduler(clock); const assets = createBinaryAssets(root, store); const room = createRoomProjection(join(root, 'room'), store, assets, clock, 'test-owner')
  const diary = createDiary({ store, clock, scheduler, assets, model: { source: 'fake', write: async (input) => { expect(JSON.stringify(input)).toContain('ONLY_SEEN_INPUT'); expect(JSON.stringify(input)).not.toContain('PRIVATE_ORIGINAL'); return { entry: '主观日记\nSYNTHETIC_PRIVATE_PROSE' } } }, busy: () => false, changed: () => {}, projected: room.rebuild }); scheduler.cancel('diary.daily')
  try {
    await diary.write(); expect(diary.view().entries).toHaveLength(0); clock.advanceBy(11 * 3600000)
    await diary.write(); expect(diary.view().entries).toHaveLength(1); const id = diary.view().entries[0].id
    expect(() => diary.read(id)).toThrow(); expect(JSON.stringify(store.records())).not.toContain('SYNTHETIC_PRIVATE_PROSE')
    const file = join(room.root, '日记', '2026-10-16.zip'); expect(existsSync(file)).toBe(true); expect(readFileSync(file).includes(Buffer.from('SYNTHETIC_PRIVATE_PROSE'))).toBe(false)
    clock.advanceBy(86400000); const first = diary.read(id); expect(first.text).toContain('SYNTHETIC_PRIVATE_PROSE'); await diary.write(true); expect(diary.read(id).key).toBe(first.key); expect(diary.view().entries).toHaveLength(1)
    unlinkSync(file); room.rebuild(); expect(existsSync(file)).toBe(true)
    expect(readFileSync(join(room.root, '运行记录', '2026-10-17.md'), 'utf8')).not.toMatch(/PRIVATE_ORIGINAL|SYNTHETIC_PRIVATE_PROSE|ONLY_SEEN_INPUT/)
  } finally { await diary.close(); scheduler.dispose(); store.close() }
})

it('keeps an interrupted diary visibly retryable after restart and enforces the daily attempt limit', async () => {
  const root = mkdtempSync(join(tmpdir(), 'lca-diary-')); cleanups.push(() => { if (!resolve(root).startsWith(join(resolve(tmpdir()), 'lca-diary-'))) throw new Error('UNSAFE'); rmSync(root, { recursive: true, force: true }) })
  const clock = createManualClock(0); clock.advanceBy(clock.parse('2026-10-16T12:00:00+08:00'))
  const journal = openJournal(root, { userId: 'u', characterId: 'c' }, clock)
  const store: SessionStore = { scope: journal.scope, records: journal.records, append: journal.append, projection: () => projectJournal(journal.records()), close: journal.close }
  store.append({ type: 'model/seen', turnId: 'seen', source: 'fake', messages: [{ role: 'user', content: '一起完成了纸桥。' }], eligibleIndexes: [0] })
  clock.advanceBy(86400000); const scheduler = createScheduler(clock); const assets = createBinaryAssets(root, store)
  const base = { store, clock, scheduler, assets, busy: () => false, changed: () => {}, projected: () => {} }
  const interrupted = createDiary({ ...base, model: { source: 'fake', write: async () => new Promise(() => {}) } }); scheduler.cancel('diary.daily')
  const pending = interrupted.write(); interrupted.foreground(); await pending
  expect(interrupted.view().status).toBe('failed'); expect(interrupted.view().entries).toHaveLength(0); await interrupted.close()
  let calls = 0
  const reopened = createDiary({ ...base, model: { source: 'fake', write: async () => { calls++; return { entry: '主观日记\n补写完成。' } } } }); scheduler.cancel('diary.daily')
  try {
    expect(reopened.view().status).toBe('failed'); await reopened.write(); expect(calls).toBe(0)
    expect(reopened.canWrite()).toBeUndefined(); await reopened.write(true); expect(calls).toBe(1); expect(reopened.view().status).toBe('idle'); expect(reopened.view().entries).toHaveLength(1)
    store.append({ type: 'diary/attempt', dayKey: '2026-10-16' }); expect(reopened.canWrite()).toBe('budget-exceeded')
  } finally { await reopened.close(); scheduler.dispose(); store.close() }
})
