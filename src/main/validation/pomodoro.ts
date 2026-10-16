import Database from 'better-sqlite3'
import { join } from 'node:path'
import { createManualClock } from '../clock'
import { openSessionStore } from '../store/session'
import { createScheduler } from '../scheduler'
import { createPomodoro } from '../pomodoro/service'

export function probePomodoro(root: string) {
  const clock = createManualClock(0); clock.advanceBy(clock.parse('2026-10-16T03:59:50+08:00'))
  const owner = { userId: 'timer-probe-user', characterId: 'timer-probe-character' }
  const open = () => {
    const store = openSessionStore(root, owner, clock); const scheduler = createScheduler(clock)
    const timer = createPomodoro({ store, clock, scheduler, changed: () => {}, stateChanged: () => {}, emit: () => {} })
    timer.reconcile()
    return { store, timer, close: () => { timer.dispose(); scheduler.dispose(); store.close() } }
  }
  let current = open()
  try {
    current.timer.propose({ label: 'Synthetic timer probe', plannedCount: 2, focusDurationMs: 60_000, shortBreakDurationMs: 20_000,
      longBreakDurationMs: 20_000, longBreakEvery: 4, timing: 'demo' }, 'user')
    const planId = current.timer.read().proposal!.id
    current.timer.dispatch({ type: 'pomodoro.confirm', planId, protocolVersion: 1, requestId: 'confirm', epoch: 'probe' })
    current.timer.start(planId)
    const deadline = current.timer.read().endsAtMs; const previousSession = current.store.scope.sessionId
    current.close(); clock.advanceBy(20_000); current = open()
    if (current.store.scope.sessionId === previousSession || current.timer.read().endsAtMs !== deadline || current.timer.read().remainingMs !== 40_000) throw new Error('TIMER_CROSS_DAY_FAILED')
    const db = new Database(join(root, 'projections.sqlite'), { readonly: true })
    try {
      const row = db.prepare('SELECT state_json FROM session_projections WHERE session_id=?').get(current.store.scope.sessionId) as { state_json: string }
      if (JSON.parse(row.state_json).pomodoro.endsAtMs !== deadline) throw new Error('TIMER_CACHE_FAILED')
    } finally { db.close() }
    current.close(); clock.advanceBy(50_000); current = open()
    if (current.timer.read().phase !== 'short-break') throw new Error('TIMER_RECONCILE_FAILED')
    current.timer.reconcile(); current.timer.reconcile()
    if (current.store.records().filter((row) => row.type === 'pomodoro/state' && row.cause === 'elapsed').length !== 1) throw new Error('TIMER_DUPLICATED')
    return { ok: true, probe: 'pomodoro', syntheticClock: true, crossDayRestart: true, sqliteDeadlinePreserved: true, elapsedReconciledOnce: true }
  } finally { current.close() }
}
