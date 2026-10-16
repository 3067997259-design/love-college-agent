import { describe, expect, it } from 'vitest'
import { buildDiagnostics } from '../../src/main/developer/diagnostics'
import { createManualClock } from '../../src/main/clock'
import { createScheduler } from '../../src/main/scheduler'
import { projectJournal } from '../../src/main/journal/projection'
import { projectMemory } from '../../src/main/memory/projection'
import type { JournalRecord } from '../../src/main/journal/schema'
import type { SessionStore } from '../../src/main/store/session'

describe('safe developer diagnostics projection', () => {
  it('reads actual seen input and measured usage without exposing raw results or inventing missing metrics', () => {
    const rows: JournalRecord[] = [
      { type: 'session/header', userId: 'u', characterId: 'c', sessionId: 's', version: 1, seq: 1, atMs: 0 },
      { type: 'turn/start', turnId: 't', trigger: 'user', version: 1, seq: 2, atMs: 10 },
      { type: 'model/attempt', turnId: 't', slot: 'chat', attempt: 1, status: 'success', waitMs: 0, inputTokens: 12, outputTokens: 3, version: 1, seq: 3, atMs: 20 },
      { type: 'tool/result', turnId: 't', callId: 'call', ok: true, raw: { original: 'RAW_ONLY_PRIVATE' }, visible: { count: 1 }, elapsedMs: 0, version: 1, seq: 4, atMs: 20 },
      { type: 'model/seen', turnId: 't', source: 'fake', messages: [{ role: 'user', content: '可见纸桥' }], eligibleIndexes: [0], version: 1, seq: 5, atMs: 21 },
      { type: 'turn/end', turnId: 't', reason: 'completed', version: 1, seq: 6, atMs: 25 },
    ]
    const clock = createManualClock(1000); const scheduler = createScheduler(clock)
    const store: SessionStore = { scope: { userId: 'u', characterId: 'c', sessionId: 's' }, projection: () => projectJournal(rows), records: () => rows, append: () => { throw new Error('Diagnostics cannot write') }, close: () => {} }
    const memory = { view: () => projectMemory(rows), append: () => { throw new Error('Diagnostics cannot write') }, refresh: () => {}, close: () => {} }
    scheduler.schedule('synthetic.job', 2000, () => {})
    try {
      const view = buildDiagnostics({ clock, store, scheduler, memory, fileFilteringEnabled: true, mailStatus: 'blocked', pendingFiles: 1 })
      expect(view.contextSource).toBe('last-successful-input'); expect(view.context[0].text).toBe('可见纸桥')
      expect(view.turns[0]).toMatchObject({ inputTokens: 12, outputTokens: 3, durationMs: 15, firstTokenLatencyMs: null, cachedInputTokens: null, cost: null })
      expect(view.queue[0].id).toBe('synthetic.job'); expect(JSON.stringify(view)).not.toContain('RAW_ONLY_PRIVATE')
    } finally { scheduler.dispose() }
  })
})
