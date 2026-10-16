import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join, relative, resolve, isAbsolute } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { SessionStore } from '../store/session'
import type { BinaryAssets } from '../storage/assets'
import type { Clock } from '../clock'
import { calendarDay } from '../life/service'
/**
 * `ownerKey` scopes deletion to the profile that actually wrote the files: if a room folder is ever reused
 * by another owner (a different active character landing on the same path, or a copied room), the foreign
 * files are kept and the ledger is started fresh instead of deleting someone else's projections.
 */
export function createRoomProjection(root: string, store: SessionStore, assets: BinaryAssets, clock: Clock, ownerKey: string) {
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
   *
   * Ownership is recorded, never inferred from the file name: a file the user saves into a projection
   * folder (for example an ASCII `my-backup.zip`) is not ours to delete just because it looks like one of
   * ours (issue #10). The ledger therefore stores exactly the relative paths this program wrote, and a
   * file is removed only while it is both in the ledger and no longer expected by the current log.
   */
  const managed = ['日记', '礼物', '运行记录', '带回来的东西'] as const
  const ledgerFile = join(absolute, '.managed.json')
  const readLedger = () => {
    try { const value: unknown = JSON.parse(readFileSync(ledgerFile, 'utf8'))
      if (value && typeof value === 'object' && (value as { owner?: unknown }).owner === ownerKey && Array.isArray((value as { paths?: unknown }).paths)) {
        const paths = (value as { paths: unknown[] }).paths; if (paths.every((item) => typeof item === 'string')) return new Set(paths as string[])
      } } catch { /* A missing or unreadable ledger means we cannot prove ownership, so nothing is deleted. */ }
    return new Set<string>()
  }
  const writeLedger = (paths: readonly string[]) => {
    const temporary = ledgerFile + '.' + randomUUID() + '.tmp'; writeFileSync(temporary, JSON.stringify({ owner: ownerKey, paths: [...paths].sort() }), { flag: 'wx', mode: 0o600 }); renameSync(temporary, ledgerFile)
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
    const records = new Set<string>()
    for (const [folder, files] of expected) for (const name of files.keys()) records.add(folder + '/' + name)
    const ledger = readLedger()
    // The previous ledger is the only proof of ownership. A first run (or an unreadable ledger) proves
    // nothing, so it reconciles nothing and just starts recording what we wrote.
    for (const entry of ledger) { if (records.has(entry)) continue; const [folder, ...rest] = entry.split('/'); if (!(managed as readonly string[]).includes(folder) || !/^[a-zA-Z0-9_.-]+$/.test(rest.join('/'))) continue
      const file = join(absolute, folder, rest.join('/')); if (!existsSync(file)) continue; const stats = lstatSync(file)
      // Anything that is not the plain file we wrote is left alone.
      if (stats.isSymbolicLink() || !stats.isFile() || stats.nlink !== 1) continue
      rmSync(file, { force: true }) }
    writeLedger([...records])
  }
  rebuild(); return { root: absolute, rebuild }
}
