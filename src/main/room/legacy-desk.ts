import { randomUUID } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { z } from 'zod'
import type { JournalRecord } from '../journal/schema'
import { appliedDeskChanges } from '../heart-flow/changes'
import { createDesk, deskPathSchema } from '../heart-flow/desk'

const receiptSchema = z.strictObject({ version: z.literal(1), ownerKey: z.string().regex(/^[a-f0-9]{64}$/), targetRoot: z.string(),
  files: z.array(z.strictObject({ path: deskPathSchema, status: z.enum(['copied', 'present', 'conflict', 'unavailable']) })) })
/** Upgrade only the old, profile-local full-owner-hash desk. The old shared 12-char Documents path
 * cannot prove profile ownership and is deliberately not adopted. Original files are always retained.
 * A durable receipt prevents resurrection after the user later deletes a migrated file.
 */
export function migrateLegacyDesk(options: { dataDir: string; roomRoot: string; ownerKey: string; rows: readonly JournalRecord[] }) {
  if (!/^[a-f0-9]{64}$/.test(options.ownerKey)) throw new Error('ROOM_UPGRADE_INVALID')
  const sourceRoot = join(options.dataDir, 'rooms', options.ownerKey, '书桌'); const targetRoot = join(options.roomRoot, '书桌')
  if (resolve(sourceRoot).toLowerCase() === resolve(targetRoot).toLowerCase() || !existsSync(sourceRoot)) return
  const base = realpathSync(options.dataDir); let at = options.dataDir
  for (const part of ['rooms', options.ownerKey, '书桌']) {
    at = join(at, part); const stats = lstatSync(at); const rel = relative(base, realpathSync(at))
    if (!stats.isDirectory() || stats.isSymbolicLink() || isAbsolute(rel) || rel.startsWith('..')) return
  }
  const receiptDir = join(options.dataDir, 'room-upgrades'); mkdirSync(receiptDir, { recursive: true })
  if (lstatSync(receiptDir).isSymbolicLink()) throw new Error('ROOM_UPGRADE_INVALID')
  const receiptPath = join(receiptDir, options.ownerKey + '.json')
  if (existsSync(receiptPath)) {
    const stats = lstatSync(receiptPath); if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1 || stats.size > 1024 * 1024) throw new Error('ROOM_UPGRADE_INVALID')
    const receipt = receiptSchema.parse(JSON.parse(readFileSync(receiptPath, 'utf8')))
    if (receipt.ownerKey === options.ownerKey && receipt.targetRoot === resolve(targetRoot)) return
    throw new Error('ROOM_UPGRADE_INVALID')
  }
  const source = createDesk(sourceRoot); const target = createDesk(targetRoot)
  // A restored save owns the current desk history; do not import pre-restore files on a later restart.
  const known = new Map(options.rows.some((row) => row.type === 'save/restored') ? [] : appliedDeskChanges(options.rows).map((row) => [row.path, row.after] as const))
  const files: z.infer<typeof receiptSchema>['files'] = []
  for (const [path, expected] of known) {
    if (expected === null || !deskPathSchema.safeParse(path).success) continue
    let status: typeof files[number]['status'] = 'unavailable'
    try {
      const old = source.read(path); const current = target.read(path)
      if (old !== null) {
        if (current !== null) status = current === old ? 'present' : 'conflict'
        else { target.writeNew(path, old); status = 'copied' }
      }
    } catch { /* A link, unreadable/invalid source, or concurrent target is never overwritten. */ }
    files.push({ path, status })
  }
  const receipt = receiptSchema.parse({ version: 1, ownerKey: options.ownerKey, targetRoot: resolve(targetRoot), files })
  // Receipt only contains relative paths/statuses, never source text; old desk remains the rollback copy.
  const temporary = receiptPath + '.' + randomUUID() + '.tmp'; writeFileSync(temporary, JSON.stringify(receipt), { flag: 'wx', mode: 0o600 }); renameSync(temporary, receiptPath)
}
