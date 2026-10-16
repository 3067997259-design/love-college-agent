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
  return { clock, root, projection, history, folder: (name: string) => join(root, name), present: (path: string) => existsSync(join(root, path)), read: (path: string) => readFileSync(join(root, path), 'utf8') }
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
    expect(before.read(join('书桌', '用户笔记.md'))).toBe('USER_FILE')
    expect(before.read(join('日记', '我的备份', 'note.md'))).toBe('USER_BACKUP')
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

describe('room projection ownership is recorded, not guessed (issue #10)', () => {
  it('never deletes a user file that only looks like a projection', () => {
    const f = harness([diaryRow('2026-10-17'), giftRow('gift-a', 'given')])
    f.history.push(turnRow(f.clock, '2026-10-17'))
    f.projection.rebuild()
    // 用户在投影目录里自己保存的东西，名字完全符合我们生成的形状，但日志与资产库里没有它们。
    const userFiles = [['日记', 'my-backup.zip', 'USER_DIARY_BACKUP'], ['礼物', 'my-model.glb', 'USER_MODEL'], ['运行记录', 'notes.md', 'USER_NOTES'], ['带回来的东西', 'travel.json', 'USER_TRAVEL']] as const
    for (const [folder, name, text] of userFiles) writeFileSync(join(f.root, folder, name), text)
    // 启动、定时与手动重建走的是同一个函数，所以连续三次重建等价于「重启 + 定时 + 手动」。
    f.projection.rebuild(); f.projection.rebuild(); f.projection.rebuild()
    for (const [folder, name, text] of userFiles) expect(f.read(join(folder, name))).toBe(text)
    expect(f.present(join('礼物', 'gift-a.glb'))).toBe(true)
  })
  it('deletes a file only after this program recorded writing it', () => {
    const f = harness([diaryRow('2026-10-17')])
    f.history.push(turnRow(f.clock, '2026-10-17'))
    f.projection.rebuild()
    expect(f.present(join('运行记录', '2026-10-17.md'))).toBe(true)
    // 这一轮写过 10-17，下一轮日志里没有它：台账能证明是程序写的，才允许删除。
    f.history.splice(0, f.history.length, turnRow(f.clock, '2026-10-16'))
    f.projection.rebuild()
    expect(f.present(join('运行记录', '2026-10-17.md'))).toBe(false)
    expect(f.present(join('运行记录', '2026-10-16.md'))).toBe(true)
  })
  it('does not delete anything on the first run, when no ledger exists yet', () => {
    const f = harness([diaryRow('2026-10-17')])
    mkdirSync(f.folder('日记'), { recursive: true }); writeFileSync(join(f.root, '日记', '2026-10-01.zip'), 'OLDER_VERSION_PROJECTION')
    f.projection.rebuild()
    // 首次运行（或台账不可读）无法证明所有权，因此不删任何东西，只开始记录。
    expect(f.present(join('日记', '2026-10-01.zip'))).toBe(true)
    expect(f.present(join('日记', '2026-10-17.zip'))).toBe(true)
  })
})
