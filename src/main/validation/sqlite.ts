import Database from 'better-sqlite3'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

export function probeSqlite(dataDir: string) {
  const filename = join(dataDir, `sqlite-probe-${randomUUID()}.sqlite`)
  const db = new Database(filename)
  db.pragma('journal_mode = WAL')
  db.exec('CREATE TABLE probe (id INTEGER PRIMARY KEY, value TEXT NOT NULL)')
  db.transaction(() => db.prepare('INSERT INTO probe (value) VALUES (?)').run('roundtrip'))()
  db.close()
  const reopened = new Database(filename, { readonly: true })
  try {
    const row = reopened.prepare('SELECT value FROM probe WHERE id = 1').get() as { value: string }
    if (row.value !== 'roundtrip') throw new Error('SQLite roundtrip failed.')
    return { ok: true, probe: 'sqlite', nativeLoaded: true, persistedAfterReopen: true, electron: process.versions.electron, moduleAbi: process.versions.modules }
  } finally { reopened.close() }
}
