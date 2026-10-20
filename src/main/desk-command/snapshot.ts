import { randomUUID } from 'node:crypto'
import { mkdir, lstat, open, realpath, readdir, rm, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { contentHash, deskPathSchema, validateDeskText } from '../legacy-flow/desk'

export type CommandSnapshot = { root: string; parent: string; files: ReadonlyMap<string, string>; hash: string }
export type CommandEdit = { path: string; before: string | null; after: string | null }
/** Closed text project format: never silently omit binary files, links or unsupported paths. */
export async function readCommandTree(root: string, runtime = false): Promise<Map<string, string>> {
  const input = resolve(root); const stat = await lstat(input)
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('COMMAND_TREE_INVALID')
  // Windows may hand us an 8.3 temp-directory alias or different casing. Anchor every descendant to its canonical root.
  const expected = await realpath(input)
  const files = new Map<string, string>(); let entries = 0
  const visit = async (folder: string, depth: number) => {
    if (depth > 8) throw new Error('COMMAND_TREE_LIMIT')
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      if (++entries > 1000) throw new Error('COMMAND_TREE_LIMIT')
      const target = join(folder, entry.name); const meta = await lstat(target)
      if (meta.isSymbolicLink() || !(await realpath(target)).startsWith(expected + sep)) throw new Error('COMMAND_TREE_LINK')
      // Reserved native-runtime directory is not a project input/output. A link cannot impersonate it.
      if (runtime && folder === expected && entry.name === '.lca-runtime') { if (!meta.isDirectory()) throw new Error('COMMAND_TREE_INVALID'); continue }
      const path = relative(expected, target).replaceAll('\\', '/'); deskPathSchema.parse(path)
      if (meta.isDirectory()) { await visit(target, depth + 1); continue }
      if (!meta.isFile() || meta.nlink !== 1 || meta.size > 64_000 || files.size >= 300) throw new Error('COMMAND_TREE_LIMIT')
      const handle = await open(target, 'r')
      try {
        const opened = await handle.stat()
        if (!opened.isFile() || opened.nlink !== 1 || opened.size > 64_000 || opened.ino !== meta.ino || opened.dev !== meta.dev) throw new Error('COMMAND_TREE_CHANGED')
        const bytes = await handle.readFile(); const text = bytes.toString('utf8'); validateDeskText(text)
        if (!bytes.equals(Buffer.from(text, 'utf8'))) throw new Error('COMMAND_TREE_INVALID')
        const after = await lstat(target)
        if (after.isSymbolicLink() || after.ino !== opened.ino || after.dev !== opened.dev || after.nlink !== 1 || await realpath(target) !== target) throw new Error('COMMAND_TREE_CHANGED')
        files.set(path, text)
      } finally { await handle.close() }
    }
  }
  await visit(expected, 0)
  return new Map([...files].sort(([a], [b]) => a.localeCompare(b)))
}
export function commandTreeHash(files: ReadonlyMap<string, string>): string {
  return contentHash(JSON.stringify([...files].sort(([a], [b]) => a.localeCompare(b)).map(([path, text]) => [path, contentHash(text)])))
}
export async function prepareCommandSnapshot(deskRoot: string, cacheRoot: string): Promise<CommandSnapshot> {
  const files = await readCommandTree(deskRoot)
  await mkdir(cacheRoot, { recursive: true })
  if ((await lstat(cacheRoot)).isSymbolicLink()) throw new Error('COMMAND_CACHE_INVALID')
  const parent = await realpath(cacheRoot)
  const root = join(parent, 'lca-command-' + randomUUID()); await mkdir(root)
  const snapshot: CommandSnapshot = { root, parent, files, hash: commandTreeHash(files) }
  try {
    for (const [path, text] of files) { const target = join(root, path); await mkdir(dirname(target), { recursive: true }); await writeFile(target, text, { flag: 'wx', mode: 0o600 }) }
    if (commandTreeHash(await readCommandTree(root)) !== snapshot.hash || commandTreeHash(await readCommandTree(deskRoot)) !== snapshot.hash) throw new Error('COMMAND_TREE_CHANGED')
    return snapshot
  } catch (error) { await disposeCommandSnapshot(snapshot); throw error }
}
export async function commandEdits(snapshot: CommandSnapshot): Promise<CommandEdit[]> {
  const output = await readCommandTree(snapshot.root, true)
  const paths = [...new Set([...snapshot.files.keys(), ...output.keys()])].sort()
  return paths.flatMap((path) => {
    const before = snapshot.files.get(path) ?? null; const after = output.get(path) ?? null
    return contentHash(before) === contentHash(after) ? [] : [{ path, before, after }]
  })
}
export async function disposeCommandSnapshot(snapshot: Pick<CommandSnapshot, 'root' | 'parent'>): Promise<void> {
  const parent = resolve(snapshot.parent); const target = resolve(snapshot.root); const rel = relative(parent, target)
  if (!/^lca-command-[a-f0-9-]{36}$/.test(rel) || rel.includes(sep) || isAbsolute(rel) || await realpath(parent) !== parent) throw new Error('COMMAND_CLEANUP_INVALID')
  const meta = await lstat(target).catch(() => null); if (!meta) return
  if (!meta.isDirectory() || meta.isSymbolicLink() || await realpath(target) !== target) throw new Error('COMMAND_CLEANUP_INVALID')
  // Target is one verified, owned scratch directory. rm unlinks any descendant symlinks without traversing them.
  await rm(target, { recursive: true, force: true })
}
