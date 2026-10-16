import { existsSync, lstatSync, mkdirSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { basename, join, relative, resolve, isAbsolute } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { SessionStore } from '../store/session'
import type { BinaryAssets } from '../storage/assets'
import type { Clock } from '../clock'
import { calendarDay } from '../life/service'
export function createRoomProjection(root: string, store: SessionStore, assets: BinaryAssets, clock: Clock) {
  const absolute = resolve(root)
  const checkedDirectory = (path: string) => {
    const rel = relative(absolute, path); if (isAbsolute(rel) || rel.startsWith('..')) throw new Error('ROOM_INVALID')
    mkdirSync(absolute, { recursive: true }); if (lstatSync(absolute).isSymbolicLink() || realpathSync(absolute) !== absolute) throw new Error('ROOM_INVALID')
    let at = absolute
    for (const part of rel.split(/[\\/]/).filter(Boolean)) { at = join(at, part); if (!existsSync(at)) mkdirSync(at); if (lstatSync(at).isSymbolicLink() || !lstatSync(at).isDirectory()) throw new Error('ROOM_INVALID') }
    return path
  }
  /**
   * Program-owned projections are reconciled instead of only written: restoring an older private save
   * leaves files that are no longer in the log (issue #9), and the folder is documented as a projection
   * that can always be regenerated. `书桌` is listed but deliberately not reconciled — it is the one part
   * of the room the user edits, and her tools write there too.
   */
  const managed = ['日记', '礼物', '运行记录', '带回来的东西'] as const
  const ownedFiles = (folder: string) => {
    const names: string[] = []
    for (const entry of readdirSync(checkedDirectory(join(absolute, folder)), { withFileTypes: true })) {
      // An unexpected name, subdirectory or link is the user's, not ours: skip it instead of deleting it.
      if (!entry.isFile() || !/^[a-zA-Z0-9_.-]+$/.test(entry.name)) continue
      const file = join(absolute, folder, entry.name); const stats = lstatSync(file)
      if (stats.isSymbolicLink() || !stats.isFile() || stats.nlink !== 1) continue
      names.push(entry.name)
    }
    return names
  }
  const write = (folder: string, name: string, bytes: Buffer | string) => {
    if (!/^[a-zA-Z0-9_.-]+$/.test(name)) throw new Error('ROOM_INVALID'); const directory = checkedDirectory(join(absolute, folder)); const file = join(directory, name)
    if (existsSync(file) && (lstatSync(file).isSymbolicLink() || lstatSync(file).nlink !== 1 || !lstatSync(file).isFile())) throw new Error('ROOM_INVALID')
    const temporary = join(directory, '.' + randomUUID() + '.tmp'); writeFileSync(temporary, bytes, { flag: 'wx', mode: 0o600 }); renameSync(temporary, file)
  }
  const rebuild = () => {
    for (const name of ['书桌', '日记', '带回来的东西', '礼物', '运行记录']) checkedDirectory(join(absolute, name))
    const expected = new Map<string, Map<string, Buffer | string>>(managed.map((folder) => [folder, new Map()]))
    const plan = (folder: string, name: string, bytes: Buffer | string) => { if (!/^[a-zA-Z0-9_.-]+$/.test(name)) throw new Error('ROOM_INVALID'); expected.get(folder)!.set(name, bytes) }
    const rows = store.history?.() ?? store.records(); const days = new Map<string, string[]>()
    for (const row of rows) {
      if (row.type === 'diary/written') plan('日记', row.diary.dayKey + '.zip', assets.read(row.diary.asset))
      if (row.type === 'gift/state' && row.gift.status === 'given' && row.gift.assetRef) { const asset = assets.owned(row.gift.assetRef.slice(6)); if (asset) plan('礼物', row.gift.id + '.glb', assets.read(asset)) }
      // Whitelist metadata: never serialize arbitrary row fields, tool inputs/results, private prose or keys.
      if (['turn/end', 'campus/confirmed', 'campus/exported', 'document/completed', 'flow/close', 'gift/state', 'save/restored', 'diary/written'].includes(row.type)) {
        const day = calendarDay(clock, row.atMs); const records = days.get(day) ?? []; records.push(clock.iso(row.atMs) + ' ' + row.type + (row.type === 'turn/end' ? ' ' + row.reason : '')); days.set(day, records)
      }
    }
    for (const [day, records] of days) plan('运行记录', day + '.md', '# 运行记录（脱敏投影）\n\n' + records.join('\n'))
    const life = rows.findLast((row) => row.type === 'life/state'); if (life?.type === 'life/state') plan('带回来的东西', 'catalog.json', JSON.stringify(life.view.items, null, 2))
    // Writes are atomic, so removing the leftovers only after every write succeeds cannot strand a half-built room.
    for (const [folder, files] of expected) for (const [name, bytes] of files) write(folder, name, bytes)
    for (const folder of managed) for (const name of ownedFiles(folder)) if (!expected.get(folder)!.has(name)) rmSync(join(absolute, folder, basename(name)), { force: true })
  }
  rebuild(); return { root: absolute, rebuild }
}
