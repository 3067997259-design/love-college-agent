import Database from 'better-sqlite3'
import { existsSync, lstatSync, mkdirSync, realpathSync } from 'node:fs'
import { join, resolve } from 'node:path'

/** SQLite owns the cross-process lock; usage.jsonl remains the append-only authority. */
export function openResourceMutex(folder: string) {
  const root = resolve(folder); mkdirSync(root, { recursive: true })
  if (lstatSync(root).isSymbolicLink() || realpathSync(root) !== root) throw new Error('RESOURCE_MUTEX_UNAVAILABLE')
  const path = join(root, 'mutex.sqlite')
  const check = (file: string) => { if (!existsSync(file)) return; const stat = lstatSync(file); if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || realpathSync(file) !== file || stat.size > 1_048_576) throw new Error('RESOURCE_MUTEX_UNAVAILABLE') }
  for (const file of [path, path + '-wal', path + '-shm', path + '-journal']) check(file)
  const db = new Database(path); db.pragma('trusted_schema = OFF'); db.pragma('busy_timeout = 250')
  db.exec('CREATE TABLE IF NOT EXISTS resource_mutex (id INTEGER PRIMARY KEY)')
  const stat = lstatSync(path)
  return { atomic: <T>(body: () => T): T => { check(path); const current = lstatSync(path); if (current.ino !== stat.ino || current.dev !== stat.dev) throw new Error('RESOURCE_MUTEX_UNAVAILABLE'); return db.transaction(body).immediate() }, close: () => db.close() }
}
