import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createManualClock } from '../../src/main/clock'
import { openJournal } from '../../src/main/journal/file'
import { carryPreviousState } from '../../src/main/store/carry'
import { projectJournal } from '../../src/main/journal/projection'

describe('daily timer handoff', () => {
  it('carries active timer once across 04:00 with scope/provenance and no old chat', () => {
    const root = mkdtempSync(join(tmpdir(), 'lca-carry-')); const clock = createManualClock(0)
    const owner = { userId: 'u', characterId: 'c' }; clock.advanceBy(clock.parse('2026-10-16T03:59:50+08:00'))
    let journal = openJournal(root, owner, clock)
    const cleanup = () => { if (!resolve(root).startsWith(join(resolve(tmpdir()), 'lca-carry-'))) throw new Error('Unsafe cleanup path'); rmSync(root, { recursive: true, force: true }) }
    try {
      const endsAtMs = clock.nowMs() + 60_000
      journal.append({ type: 'user/message', id: 'private-old-chat', text: 'old synthetic conversation', requestId: 'u1', commandHash: 'x' })
      journal.append({ type: 'pomodoro/state', cause: 'started', pauseReason: null, mode: 'quiet', view: {
        phase: 'focus', status: 'running', remainingMs: 60_000, endsAtMs, focusIndex: 1, phaseDurationMs: 60_000, plannedCount: 2,
        plan: { label: 'Synthetic', plannedCount: 2, focusDurationMs: 60_000, shortBreakDurationMs: 20_000, longBreakDurationMs: 20_000, longBreakEvery: 4, timing: 'demo', id: 'plan', createdAtMs: clock.nowMs(), status: 'confirmed', source: 'user' },
      }, event: { id: 'phase', text: 'synthetic phase' } })
      const old = JSON.stringify(journal.records()); const oldId = journal.scope.sessionId; journal.close()
      clock.advanceBy(20_000); journal = openJournal(root, owner, clock)
      carryPreviousState(journal, root, owner, clock); carryPreviousState(journal, root, owner, clock)
      expect(journal.records()).toHaveLength(2); expect(journal.records()[1]).toMatchObject({ type: 'session/carry', sourceSessionId: oldId })
      const state = projectJournal(journal.records())
      expect(state.pomodoro.endsAtMs).toBe(endsAtMs); expect(state.pomodoroEvents).toHaveLength(1)
      expect(state.context).toEqual([]); expect(state.messages).toEqual([]); expect(state.scope.sessionId).not.toBe(oldId)
      journal.close(); const other = openJournal(root, { ...owner, characterId: 'other' }, clock)
      carryPreviousState(other, root, { ...owner, characterId: 'other' }, clock); expect(other.records()).toHaveLength(1); other.close()
      const earlier = createManualClock(clock.parse('2026-10-16T03:59:50+08:00')); journal = openJournal(root, owner, earlier)
      expect(JSON.stringify(journal.records())).toBe(old)
    } finally { journal.close(); cleanup() }
  })
})
