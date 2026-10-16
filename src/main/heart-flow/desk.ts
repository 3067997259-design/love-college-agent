import { createHash, randomUUID } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { z } from 'zod'

export const deskPathSchema = z.string().min(1).max(180).refine((value) => !isAbsolute(value) && !/[\\:]/.test(value) && [...value].every((char) => char.charCodeAt(0) > 31 && char.charCodeAt(0) !== 127) && value.split('/').every((part) => /^[^ .][^<>"|?*]*$/.test(part) && !part.endsWith('.') && !part.endsWith(' ') && !/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(part) && part !== '..'))
export const contentHash = (text: string | null) => createHash('sha256').update(text === null ? 'absent' : 'text:' + text).digest('hex')
export function validateDeskText(text: string | null) {
  if (text !== null && (Buffer.byteLength(text, 'utf8') > 64_000 || text.includes('\0') || Buffer.from(text, 'utf8').toString('utf8') !== text)) throw new Error('DESK_INVALID')
}
export function createDesk(root: string) {
  mkdirSync(root, { recursive: true }); if (lstatSync(root).isSymbolicLink()) throw new Error('DESK_INVALID')
  const base = realpathSync(root)
  const check = () => { if (lstatSync(root).isSymbolicLink() || realpathSync(root) !== base) throw new Error('DESK_INVALID') }
  const path = (input: string, create = false) => {
    check()
    deskPathSchema.parse(input); const target = resolve(base, input); const rel = relative(base, target)
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error('DESK_INVALID')
    let at = base
    for (const part of rel.split(/[\\/]/)) {
      at = join(at, part)
      if (!existsSync(at)) { if (create && at !== target) mkdirSync(at); continue }
      const stat = lstatSync(at)
      if (stat.isSymbolicLink() || stat.isFile() && stat.nlink !== 1 || !realpathSync(at).startsWith(base + '\\') && !realpathSync(at).startsWith(base + '/')) throw new Error('DESK_INVALID')
    }
    return target
  }
  const read = (file: string): string | null => { const target = path(file); if (!existsSync(target)) return null; if (!lstatSync(target).isFile() || lstatSync(target).size > 64_000) throw new Error('DESK_INVALID'); const bytes = readFileSync(target); const text = bytes.toString('utf8'); if (!Buffer.from(text).equals(bytes) || text.includes('\0')) throw new Error('DESK_INVALID'); return text }
  const write = (file: string, text: string | null) => {
    validateDeskText(text)
    const target = path(file, true); if (existsSync(target) && !lstatSync(target).isFile()) throw new Error('DESK_INVALID')
    if (text === null) { if (existsSync(target)) unlinkSync(target); return }
    const temporary = join(dirname(target), '.lca-' + randomUUID() + '.tmp')
    writeFileSync(temporary, text, { flag: 'wx', mode: 0o600 }); renameSync(temporary, target)
  }
  const list = () => {
    check()
    const result: { path: string; byteLength: number }[] = []
    const visit = (dir: string, depth: number) => { if (depth > 8) return; for (const entry of readdirSync(dir, { withFileTypes: true })) { if (result.length >= 300) return; if (entry.isSymbolicLink()) continue; const full = join(dir, entry.name); if (entry.isDirectory()) visit(full, depth + 1); else if (entry.isFile() && lstatSync(full).nlink === 1) { const file = relative(base, full).replaceAll('\\', '/'); if (deskPathSchema.safeParse(file).success) result.push({ path: file, byteLength: lstatSync(full).size }) } } }
    visit(base, 0); return result
  }
  return { read, write, list }
}
