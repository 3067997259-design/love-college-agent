import { lstatSync, mkdirSync, realpathSync } from 'node:fs'
import { isAbsolute, relative, resolve, dirname } from 'node:path'
import { BackupFailure } from './schema'

export function inside(root: string, file: string) {
  const base = resolve(root); const target = resolve(file); const rel = relative(base, target)
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new BackupFailure('backup-invalid')
  return target
}
export function regular(root: string, file: string, maxBytes: number) {
  const target = inside(root, file); const stat = lstatSync(target)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > maxBytes || realpathSync(target) !== target) throw new BackupFailure('backup-invalid')
  return target
}
export function directory(root: string, target: string) {
  if (resolve(root) !== resolve(target)) inside(root, target)
  mkdirSync(target, { recursive: true })
  if (lstatSync(target).isSymbolicLink() || realpathSync(target) !== resolve(target)) throw new BackupFailure('backup-invalid')
  return target
}
export function privateWriteParent(root: string, file: string) { inside(root, file); directory(root, dirname(file)); return file }
