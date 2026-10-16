import Database from 'better-sqlite3'
import { join } from 'node:path'
import type { Clock } from '../clock'
import type { Scope } from '../../shared'
import { journalLocation, sessionDayKey, openJournal, parseJournalContent, type Journal } from '../journal/file'
import { existsSync, readFileSync, readdirSync, lstatSync, unlinkSync, writeFileSync, renameSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { z } from 'zod'
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
  const resumePath = sessionResumePath(dataDir, owner)
  const resumed = existsSync(resumePath) ? (() => { if (lstatSync(resumePath).isSymbolicLink() || lstatSync(resumePath).size > 1024) throw new Error('SESSION_ANCHOR_INVALID'); return resumeSchema.parse(JSON.parse(readFileSync(resumePath, 'utf8'))) })() : undefined
  let dayKey = resumed?.dayKey ?? sessionDayKey(clock)
  let journal = openJournal(dataDir, owner, clock, dayKey)
  if (resumed && journal.scope.sessionId !== resumed.sessionId) { journal.close(); throw new Error('SESSION_ANCHOR_INVALID') }
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
        if (existsSync(resumePath)) unlinkSync(resumePath)
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
const resumeSchema = z.strictObject({ dayKey: z.iso.date(), sessionId: z.string().min(1).max(128) })
const sessionResumePath = (root: string, owner: Pick<Scope, 'userId' | 'characterId'>) => join(root, '.session-resume-' + createHash('sha256').update(JSON.stringify([owner.userId, owner.characterId])).digest('hex') + '.json')
export function resumeSavedSession(root: string, owner: Pick<Scope, 'userId' | 'characterId'>, dayKey: string, sessionId: string) {
  const path = sessionResumePath(root, owner); const value = resumeSchema.parse({ dayKey, sessionId })
  writeFileSync(path + '.tmp', JSON.stringify(value), { mode: 0o600 }); renameSync(path + '.tmp', path)
}
