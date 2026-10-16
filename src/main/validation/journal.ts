import Database from 'better-sqlite3'
import { join } from 'node:path'
import { unlinkSync } from 'node:fs'
import { createManualClock } from '../clock'
import { openSessionStore } from '../store/session'

export function probeJournal(dataDir: string) {
  const clock = createManualClock(1_000)
  const owner = { userId: 'probe-user', characterId: 'probe-character' }
  let store = openSessionStore(dataDir, owner, clock)
  const scope = store.scope
  store.append({ type: 'companion/mode', mode: 'quiet', requestId: 'r1', commandHash: 'hash1' })
  store.append({ type: 'user/message', id: 'm1', text: 'synthetic persisted input', requestId: 'r2', commandHash: 'hash2' })
  store.append({ type: 'tool/result', turnId: 't1', callId: 'call1', raw: { private: 'synthetic user-only original' }, visible: { count: 1 }, ok: true, elapsedMs: 2 })
  const before = JSON.stringify(store.records())
  store.close()
  const cachePath = join(dataDir, 'projections.sqlite')
  const db = new Database(cachePath)
  db.prepare('UPDATE session_projections SET journal_seq=999, state_json=?').run('{}')
  db.close()
  store = openSessionStore(dataDir, owner, clock)
  if (JSON.stringify(store.records()) !== before || store.scope.sessionId !== scope.sessionId || store.projection().mode !== 'quiet') throw new Error('JOURNAL_REPLAY_FAILED')
  if (JSON.stringify(store.projection()).includes('synthetic user-only original')) throw new Error('PRIVATE_PROJECTION_LEAK')
  store.close()
  const repaired = new Database(cachePath, { readonly: true })
  const cached = repaired.prepare('SELECT journal_seq, state_json FROM session_projections WHERE user_id=? AND character_id=? AND session_id=?').get(owner.userId, owner.characterId, scope.sessionId) as { journal_seq: number; state_json: string }
  repaired.close()
  if (cached.journal_seq !== 4 || JSON.parse(cached.state_json).mode !== 'quiet') throw new Error('CACHE_REPAIR_FAILED')
  // Only this isolated probe's disposable cache is removed; the journal stays byte-for-byte intact.
  unlinkSync(cachePath)
  store = openSessionStore(dataDir, owner, clock)
  if (store.projection().lastSeq !== 4 || store.projection().messages.length !== 1) throw new Error('CACHE_REBUILD_FAILED')
  store.close()
  const other = openSessionStore(dataDir, { ...owner, characterId: 'other-character' }, clock)
  if (other.projection().messages.length) throw new Error('SCOPE_LEAK')
  other.close()
  return { ok: true, probe: 'journal', restartReplayed: true, staleCacheRebuilt: true, missingCacheRebuilt: true, rawExcluded: true, scopeIsolated: true }
}
