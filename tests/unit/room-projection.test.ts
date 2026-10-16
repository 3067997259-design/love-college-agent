import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createManualClock } from '../../src/main/clock'
import { createRoomProjection } from '../../src/main/room/projection'
import type { BinaryAssets } from '../../src/main/storage/assets'
import type { SessionStore } from '../../src/main/store/session'
import type { JournalRecord } from '../../src/main/journal/schema'

const cleanups: (() => void)[] = []
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup() })
function room(prefix: string) {
  const path = mkdtempSync(join(tmpdir(), prefix))
  cleanups.push(() => { if (!resolve(path).startsWith(join(resolve(tmpdir()), prefix))) throw new Error('Unsafe cleanup'); rmSync(path, { recursive: true, force: true }) })
  return path
}
const digest = (seed: string) => seed.repeat(64).slice(0, 64)
const assetRef = 'asset:' + 'a'.repeat(64)

function harness(rows: JournalRecord[]) {
  const root = room('lca-room-projection-')
  const assets = { read: (asset: { sha256: string }) => Buffer.from('ASSET_' + asset.sha256.slice(0, 4)), owned: (sha: string) => ({ sha256: sha, format: 'zip', bytes: 8 }) } as unknown as BinaryAssets
  const history = [...rows]
  const store = { history: () => history, records: () => history } as unknown as SessionStore
  const clock = createManualClock(1000)
  clock.advanceBy(clock.parse('2026-10-17T12:00:00+08:00') - clock.nowMs())
  const projection = createRoomProjection(root, store, assets, clock)
  return { clock, root, projection, history, folder: (name: string) => join(root, name), present: (path: string) => existsSync(join(root, path)) }
}

const diaryRow = (dayKey: string): JournalRecord => ({ type: 'diary/written', atMs: 1_000, diary: { dayKey, asset: { sha256: digest('b'), format: 'zip', bytes: 8 } } } as unknown as JournalRecord)
const giftRow = (id: string, status: 'given' | 'proposed'): JournalRecord => ({ type: 'gift/state', atMs: 1_000, gift: { id, status, assetRef } } as unknown as JournalRecord)
const turnRow = (clock: ReturnType<typeof createManualClock>, day: string): JournalRecord => ({ type: 'turn/end', atMs: clock.parse(day + 'T09:00:00+08:00'), turnId: 't1', reason: 'completed' } as unknown as JournalRecord)

describe('room projection reconciles the files it owns (issue #9)', () => {
  it('removes projections that are no longer in the log after an older save is restored', () => {
    const before = harness([diaryRow('2026-10-17'), giftRow('gift-future', 'given')])
    before.history.push(turnRow(before.clock, '2026-10-17'))
    before.projection.rebuild()
    expect(before.present(join('日记', '2026-10-17.zip'))).toBe(true)
    expect(before.present(join('礼物', 'gift-future.glb'))).toBe(true)
    expect(before.present(join('运行记录', '2026-10-17.md'))).toBe(true)
    // The user's own desk, a subdirectory and any file outside our naming stay untouched when the log is replaced.
    mkdirSync(before.folder('书桌'), { recursive: true }); writeFileSync(join(before.root, '书桌', '用户笔记.md'), 'USER_FILE')
    mkdirSync(join(before.root, '日记', '我的备份'), { recursive: true }); writeFileSync(join(before.root, '日记', '我的备份', 'note.md'), 'USER_BACKUP')
    writeFileSync(join(before.root, '日记', '我的备份.zip'), 'NOT_OURS')

    before.history.splice(0, before.history.length, diaryRow('2026-10-16'), turnRow(before.clock, '2026-10-16'))
    before.projection.rebuild()

    expect(before.present(join('日记', '2026-10-16.zip'))).toBe(true)
    expect(before.present(join('日记', '2026-10-17.zip'))).toBe(false)
    expect(before.present(join('礼物', 'gift-future.glb'))).toBe(false)
    expect(before.present(join('运行记录', '2026-10-17.md'))).toBe(false)
    expect(before.present(join('运行记录', '2026-10-16.md'))).toBe(true)
    expect(readFileSync(join(before.root, '书桌', '用户笔记.md'), 'utf8')).toBe('USER_FILE')
    expect(readFileSync(join(before.root, '日记', '我的备份', 'note.md'), 'utf8')).toBe('USER_BACKUP')
    // 名字不在托管命名里的文件不会被当成投影删除。
    expect(before.present(join('日记', '我的备份.zip'))).toBe(true)
  })
  it('is idempotent and keeps the reconciled room stable across repeated rebuilds', () => {
    const f = harness([diaryRow('2026-10-16'), diaryRow('2026-10-17'), giftRow('gift-a', 'given')])
    f.history.push(turnRow(f.clock, '2026-10-16'))
    f.projection.rebuild()
    const after = readFileSync(join(f.root, '运行记录', '2026-10-16.md'), 'utf8')
    f.projection.rebuild(); f.projection.rebuild()
    expect(readFileSync(join(f.root, '运行记录', '2026-10-16.md'), 'utf8')).toBe(after)
    expect(f.present(join('日记', '2026-10-16.zip'))).toBe(true)
    expect(f.present(join('日记', '2026-10-17.zip'))).toBe(true)
    expect(f.present(join('礼物', 'gift-a.glb'))).toBe(true)
  })
})
