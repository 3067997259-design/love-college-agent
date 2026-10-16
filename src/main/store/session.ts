import Database from 'better-sqlite3'
import { join } from 'node:path'
import type { Clock } from '../clock'
import type { Scope } from '../../shared'
import { journalLocation, sessionDayKey, openJournal, parseJournalContent, type Journal } from '../journal/file'
import { readFileSync, readdirSync } from 'node:fs'
import { projectJournal, type SessionProjection } from '../journal/projection'
import type { JournalInput } from '../journal/schema'
import { carryPreviousState } from './carry'

export interface SessionStore {
  readonly scope: Scope
  projection(): SessionProjection
  records: Journal['records']
  /** Scoped global facts for campus replay. Current-day model context still uses records(). */
  history?(): ReturnType<Journal['records']>
  dayKey?(): string
  rotate?(): boolean
  pages?(): { sessionId: string; dayKey: string; records: readonly ReturnType<Journal['records']>[number][] }[]
  append(input: JournalInput): void
  close(): void
}

export function openSessionStore(dataDir: string, owner: Pick<Scope, 'userId' | 'characterId'>, clock: Clock): SessionStore {
  let journal = openJournal(dataDir, owner, clock)
  let dayKey = sessionDayKey(clock)
  let database: Database.Database | undefined
  try {
    carryPreviousState(journal, dataDir, owner, clock)
    const location = journalLocation(dataDir, owner, clock)
    const loadHistory = () => readdirSync(location.folder).filter((name) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(name) && name < `${dayKey}.jsonl`).sort()
      .map((name) => ({ dayKey: name.slice(0, 10), records: parseJournalContent(readFileSync(join(location.folder, name), 'utf8'), owner) }))
    let history = loadHistory()
    database = new Database(join(dataDir, 'projections.sqlite'))
    database.pragma('journal_mode = WAL')
    database.exec(`CREATE TABLE IF NOT EXISTS session_projections (
      user_id TEXT NOT NULL, character_id TEXT NOT NULL, session_id TEXT NOT NULL,
      journal_seq INTEGER NOT NULL, state_json TEXT NOT NULL,
      PRIMARY KEY (user_id, character_id, session_id))`)
    const db = database
    let state = projectJournal(journal.records())
    const save = db.prepare(`INSERT INTO session_projections VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(user_id, character_id, session_id) DO UPDATE SET journal_seq=excluded.journal_seq, state_json=excluded.state_json`)
    const cache = () => save.run(journal.scope.userId, journal.scope.characterId, journal.scope.sessionId, state.lastSeq, JSON.stringify(state))
    // Always replay the fact source, including after a crash between fsync and cache update.
    db.transaction(cache)()
    return {
      get scope() { return journal.scope }, projection: () => structuredClone(state), records: () => journal.records(),
      history: () => structuredClone([...history.flatMap((page) => page.records), ...journal.records()]),
      dayKey: () => dayKey,
      pages: () => [...history, { dayKey, records: journal.records() }].map((page) => ({ ...page, sessionId: (page.records[0] as Extract<ReturnType<Journal['records']>[number], { type: 'session/header' }>).sessionId })),
      rotate: () => {
        const target = sessionDayKey(clock); if (target <= dayKey) return false
        const next = openJournal(dataDir, owner, clock)
        try { carryPreviousState(next, dataDir, owner, clock) } catch { next.close(); throw new Error('SESSION_HANDOFF_FAILED') }
        journal.close(); journal = next; dayKey = target; history = loadHistory(); state = projectJournal(journal.records())
        try { db.transaction(cache)() } catch { /* Derived cache can be rebuilt. */ }
        return true
      },
      append: (input) => {
        journal.append(input)
        state = projectJournal(journal.records())
        try { db.transaction(cache)() }
        catch { /* Cache failure cannot roll back the already durable fact. Replay repairs it on open. */ }
      },
      close: () => { journal.close(); db.close() },
    }
  } catch { journal.close(); database?.close(); throw new Error('SESSION_STORE_UNAVAILABLE') }
}
