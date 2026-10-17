import { mkdtempSync, rmSync, mkdirSync, writeFileSync, linkSync } from 'node:fs'
import { readFile, writeFile, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { commandEdits, commandTreeHash, disposeCommandSnapshot, prepareCommandSnapshot, readCommandTree } from '../../src/main/desk-command/snapshot'
const cleanups: (() => void)[] = []
afterEach(() => cleanups.splice(0).reverse().forEach((fn) => fn()))
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'lca-command-tree-')); const desk = join(root, 'desk'); const cache = join(root, 'cache'); mkdirSync(desk)
  cleanups.push(() => { if (!resolve(root).startsWith(join(resolve(tmpdir()), 'lca-command-tree-'))) throw new Error('UNSAFE'); rmSync(root, { recursive: true, force: true }) })
  return { root, desk, cache }
}
it('freezes exact text inputs and computes add/edit/delete without changing the real desk', async () => {
  const f = fixture(); writeFileSync(join(f.desk, 'a.txt'), 'before'); writeFileSync(join(f.desk, 'delete.txt'), 'old')
  const snapshot = await prepareCommandSnapshot(f.desk, f.cache); expect(snapshot.hash).toBe(commandTreeHash(await readCommandTree(f.desk)))
  await writeFile(join(snapshot.root, 'a.txt'), 'after'); await unlink(join(snapshot.root, 'delete.txt')); await writeFile(join(snapshot.root, 'new.txt'), 'made')
  expect(await commandEdits(snapshot)).toEqual([{ path: 'a.txt', before: 'before', after: 'after' }, { path: 'delete.txt', before: 'old', after: null }, { path: 'new.txt', before: null, after: 'made' }])
  expect(await readFile(join(f.desk, 'a.txt'), 'utf8')).toBe('before'); await disposeCommandSnapshot(snapshot); await expect(readFile(join(snapshot.root, 'a.txt'))).rejects.toThrow()
})
it.each(['oversized', 'nul', 'binary', 'hidden', 'hardlink'] as const)('refuses %s project inputs instead of silently omitting them', async (kind) => {
  const f = fixture(); const file = join(f.desk, kind === 'hidden' ? '.private' : 'source.txt')
  if (kind === 'hardlink') { writeFileSync(join(f.root, 'external'), 'private'); linkSync(join(f.root, 'external'), file) }
  else writeFileSync(file, kind === 'oversized' ? 'x'.repeat(64001) : kind === 'nul' ? 'a\0b' : kind === 'binary' ? Buffer.from([0xff]) : 'hidden')
  await expect(prepareCommandSnapshot(f.desk, f.cache)).rejects.toThrow()
})
it('does not publish unsupported output files and only ignores the reserved runtime directory', async () => {
  const f = fixture(); const snapshot = await prepareCommandSnapshot(f.desk, f.cache); mkdirSync(join(snapshot.root, '.lca-runtime')); writeFileSync(join(snapshot.root, '.lca-runtime/cache.bin'), Buffer.from([0xff, 0]))
  expect(await commandEdits(snapshot)).toEqual([]); writeFileSync(join(snapshot.root, 'output.bin'), Buffer.from([0xff]))
  await expect(commandEdits(snapshot)).rejects.toThrow(); expect(await readCommandTree(f.desk)).toEqual(new Map())
  await expect(disposeCommandSnapshot({ root: f.desk, parent: f.root })).rejects.toThrow('COMMAND_CLEANUP_INVALID'); await disposeCommandSnapshot(snapshot)
})
