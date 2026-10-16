import { mkdtempSync, rmSync, readFileSync, symlinkSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { migrateLegacyDesk } from '../../src/main/room/legacy-desk'
import { createDesk } from '../../src/main/heart-flow/desk'
import type { JournalRecord } from '../../src/main/journal/schema'
const cleanups: (() => void)[] = []
afterEach(() => cleanups.splice(0).forEach((fn) => fn()))
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'lca-room-upgrade-')); cleanups.push(() => { if (!resolve(root).startsWith(join(resolve(tmpdir()), 'lca-room-upgrade-'))) throw new Error('UNSAFE'); rmSync(root, { recursive: true, force: true }) })
  const ownerKey = 'a'.repeat(64); const legacy = createDesk(join(root, 'data', 'rooms', ownerKey, '书桌')); const target = createDesk(join(root, 'new', '书桌'))
  const rows: JournalRecord[] = ['note.md', 'edited.md', 'conflict.md', 'deleted.md'].map((path, index) => ({ version: 1, seq: index + 1, atMs: 0, type: 'desk/change', id: path, flowId: 'flow', path, before: null, after: path === 'deleted.md' ? null : 'OLD_TEXT' }))
  const options = { dataDir: join(root, 'data'), roomRoot: join(root, 'new'), ownerKey, rows }
  return { root, legacy, target, options }
}
it('copies only owned logged live paths once, preserves actual edits/conflicts and never resurrects later deletions', () => {
  const f = fixture(); f.legacy.write('note.md', 'OLD_TEXT'); f.legacy.write('edited.md', 'USER_EDIT_AFTER_LOG'); f.legacy.write('conflict.md', 'OLD_TEXT'); f.legacy.write('unlogged.md', 'UNOWNED'); f.legacy.write('deleted.md', 'STALE')
  f.target.write('conflict.md', 'NEW_USER_EDIT'); migrateLegacyDesk(f.options)
  expect(f.target.read('note.md')).toBe('OLD_TEXT'); expect(f.target.read('edited.md')).toBe('USER_EDIT_AFTER_LOG'); expect(f.target.read('conflict.md')).toBe('NEW_USER_EDIT')
  expect(f.target.read('unlogged.md')).toBeNull(); expect(f.target.read('deleted.md')).toBeNull(); expect(f.legacy.read('note.md')).toBe('OLD_TEXT')
  const receipt = readFileSync(join(f.options.dataDir, 'room-upgrades', f.options.ownerKey + '.json'), 'utf8'); expect(receipt).not.toMatch(/OLD_TEXT|USER_EDIT_AFTER_LOG|NEW_USER_EDIT/); expect(receipt).toContain('conflict')
  f.target.write('note.md', null); migrateLegacyDesk(f.options); expect(f.target.read('note.md')).toBeNull()
})
it('rejects a link anywhere in the legacy owner path and a source from a different owner', () => {
  const f = fixture(); f.legacy.write('note.md', 'OLD_TEXT')
  migrateLegacyDesk({ ...f.options, ownerKey: 'b'.repeat(64) }); expect(f.target.read('note.md')).toBeNull()
  const folder = join(f.root, 'data', 'rooms', f.options.ownerKey); const moved = join(f.root, 'foreign')
  mkdirSync(moved); if (!resolve(folder).startsWith(resolve(f.root) + sep)) throw new Error('UNSAFE')
  rmSync(folder, { recursive: true }); symlinkSync(moved, folder, 'junction')
  createDesk(join(moved, '书桌')).write('note.md', 'FOREIGN'); migrateLegacyDesk(f.options); expect(f.target.read('note.md')).toBeNull()
})
