import Database from 'better-sqlite3'
import { join } from 'node:path'
import type { SessionStore } from '../store/session'
import type { JournalInput } from '../journal/schema'
import { projectMemory } from './projection'
import { memoryDigest } from './seen'

/** Disposable, scoped SQLite projection. The append-only journal remains the fact source. */
export function openMemoryRepository(root: string, store: SessionStore) {
  const db = new Database(join(root, 'memory.sqlite')); db.pragma('journal_mode = WAL')
  db.exec('CREATE TABLE IF NOT EXISTS memory_projection (owner TEXT PRIMARY KEY, record_count INTEGER NOT NULL, state_json TEXT NOT NULL)')
  const owner = memoryDigest(JSON.stringify([store.scope.userId, store.scope.characterId])); const records = () => store.history?.() ?? store.records()
  let state = projectMemory(records())
  const cache = () => db.prepare('INSERT INTO memory_projection VALUES (?,?,?) ON CONFLICT(owner) DO UPDATE SET record_count=excluded.record_count,state_json=excluded.state_json').run(owner, records().length, JSON.stringify(state))
  try { cache() } catch { db.close(); throw new Error('MEMORY_STORE_UNAVAILABLE') }
  return { view: () => structuredClone(state),
    refresh: () => { state = projectMemory(records()) },
    append: (input: JournalInput) => { store.append(input); state = projectMemory(records()); try { cache() } catch { /* Replay repairs cache without changing durable facts. */ } },
    close: () => { db.close() },
  }
}
export type MemoryRepository = ReturnType<typeof openMemoryRepository>
