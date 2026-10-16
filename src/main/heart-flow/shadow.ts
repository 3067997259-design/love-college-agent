import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, realpathSync } from 'node:fs'
import { dirname, join, resolve, relative, isAbsolute } from 'node:path'
import type { DeskShadowView } from '../../shared'
import type { SessionStore } from '../store/session'
import { appliedDeskChanges } from './changes'
import { deskPathSchema, validateDeskText } from './desk'

type Change = ReturnType<typeof appliedDeskChanges>[number]
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const commitHash = /^[a-f0-9]{40}$/
export function shadowViews(store: SessionStore) {
  return new Map((store.history?.() ?? store.records()).flatMap((row) => row.type === 'desk/shadow' ? [[row.changeId, { status: row.status, ...(row.commit ? { commit: row.commit } : {}) } as DeskShadowView] as const] : []))
}
/** Fixed Git plumbing in a private bare repository. Never execute Git in the user's worktree. */
export function createDeskShadow(options: { root: string; deskRoot: string; store: SessionStore; unavailable?: boolean }) {
  const { store } = options; const root = resolve(options.root); const gitDir = join(root, 'repository.git'); const empty = join(root, 'empty-template')
  const checked = (path: string) => {
    const rel = relative(root, path); if (rel && (rel.startsWith('..') || isAbsolute(rel))) throw new Error('SHADOW_UNAVAILABLE')
    for (let at = resolve(path); ; at = dirname(at)) { if (existsSync(at) && (lstatSync(at).isSymbolicLink() || realpathSync(at) !== at)) throw new Error('SHADOW_UNAVAILABLE'); if (dirname(at) === at) break }
    mkdirSync(path, { recursive: true }); if (lstatSync(path).isSymbolicLink() || realpathSync(path) !== resolve(path)) throw new Error('SHADOW_UNAVAILABLE')
  }
  const env = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR, TEMP: process.env.TEMP, TMP: process.env.TMP,
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null', GIT_CONFIG_COUNT: '0', GIT_TERMINAL_PROMPT: '0', GIT_ATTR_NOSYSTEM: '1' }
  const command = (args: string[], input?: Buffer) => {
    if (options.unavailable) throw new Error('SHADOW_UNAVAILABLE')
    const result = spawnSync('git', ['-c', 'core.longpaths=true', '-c', 'core.hooksPath=' + empty, '-c', 'core.fsmonitor=false', '-c', 'gc.auto=0', '-c', 'maintenance.auto=false', '-c', 'commit.gpgsign=false', ...args], { cwd: root, env, input, windowsHide: true, timeout: 10_000, maxBuffer: 1024 * 1024 })
    if (result.error || result.status !== 0) throw new Error('SHADOW_UNAVAILABLE')
    return result.stdout.toString('utf8').trim()
  }
  const prepare = () => { checked(root); checked(empty); if (existsSync(gitDir)) checked(gitDir); if (!existsSync(join(gitDir, 'HEAD'))) command(['init', '--bare', '--object-format=sha1', '--template=' + empty, gitDir]); checked(gitDir); checked(join(gitDir, 'objects')); checked(join(gitDir, 'objects', 'pack')); checked(join(gitDir, 'refs')); checked(join(gitDir, 'refs', 'lca')) }
  const ref = (id: string) => 'refs/lca/' + hash(id)
  const script = (change: Change) => {
    deskPathSchema.parse(change.path); validateDeskText(change.before); validateDeskText(change.after)
    const parts: Buffer[] = []; const line = (value: string) => parts.push(Buffer.from(value + '\n')); const data = (value: string) => { line('data ' + Buffer.byteLength(value)); parts.push(Buffer.from(value)); line('') }
    const id = hash(change.id); const date = Math.floor(change.atMs / 1000) + ' +0000'; const path = JSON.stringify(change.path)
    line('reset ' + ref(change.id)); line('')
    if (change.before !== null) { line('blob'); line('mark :1'); data(change.before) }
    line('commit ' + ref(change.id)); line('mark :2'); line('committer LCA Shadow <shadow@local.invalid> ' + date); data('before ' + id)
    if (change.before !== null) line('M 100644 :1 ' + path); line('')
    if (change.after !== null) { line('blob'); line('mark :3'); data(change.after) }
    line('commit ' + ref(change.id)); line('committer LCA Shadow <shadow@local.invalid> ' + date); data('applied ' + id); line('from :2')
    line(change.after === null ? 'D ' + path : 'M 100644 :3 ' + path); line(''); line('done')
    return Buffer.concat(parts)
  }
  const create = (change: Change) => { prepare(); command(['--git-dir=' + gitDir, 'fast-import', '--quiet', '--done'], script(change)); const commit = command(['--git-dir=' + gitDir, 'rev-parse', '--verify', ref(change.id) + '^{commit}']); if (!commitHash.test(commit)) throw new Error('SHADOW_UNAVAILABLE'); return commit }
  const overrides = new Map<string, DeskShadowView>()
  // Private saves carry the authoritative before/after journal, not Git metadata or hooks. Rebuild only
  // already-recorded shadow commits, with their original timestamp, never execute/replay model work.
  const receipts = shadowViews(store)
  const saved = appliedDeskChanges(store.history?.() ?? store.records()).filter((change) => receipts.get(change.id)?.status === 'committed')
  for (let offset = 0; offset < saved.length; offset += 500) {
    const batch = saved.slice(offset, offset + 500)
    try {
      prepare(); const actual = command(['--git-dir=' + gitDir, 'cat-file', '--batch-check'], Buffer.from(batch.map((change) => receipts.get(change.id)!.commit + '\n').join(''))).split('\n')
      for (let index = 0; index < batch.length; index++) {
        const change = batch[index]; const expected = receipts.get(change.id)!.commit!
        if (!actual[index]?.startsWith(expected + ' commit ')) { try { if (create(change) !== expected) throw new Error('SHADOW_UNAVAILABLE') } catch { overrides.set(change.id, { status: 'unavailable' }) } }
      }
    } catch { for (const change of batch) overrides.set(change.id, { status: 'unavailable' }) }
  }
  return {
    view: (id: string) => overrides.get(id) ?? receipts.get(id),
    record: (change: Change) => {
      let view: DeskShadowView = { status: 'not-git' }
      try {
        const marker = join(options.deskRoot, '.git'); const head = join(marker, 'HEAD')
        if (existsSync(marker)) {
          if (!lstatSync(marker).isDirectory() || lstatSync(marker).isSymbolicLink() || realpathSync(marker) !== resolve(marker) || !existsSync(head) || !lstatSync(head).isFile() || lstatSync(head).isSymbolicLink() || lstatSync(head).nlink !== 1) view = { status: 'unavailable' }
          else view = { status: 'committed', commit: create(change) }
        }
      } catch { view = { status: options.unavailable ? 'unavailable' : 'failed' } }
      store.append({ type: 'desk/shadow', changeId: change.id, ...view }); receipts.set(change.id, view); overrides.delete(change.id)
    },
  }
}
export type DeskShadow = ReturnType<typeof createDeskShadow>
