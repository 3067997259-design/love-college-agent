import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Clock } from '../clock'
import type { Scope } from '../../shared'
import { journalLocation, parseJournalContent, type Journal } from '../journal/file'
import { projectJournal } from '../journal/projection'
import { idleTimer } from '../pomodoro/schema'

/** Start a new daily page with provable global state; never copy chat/context or rerun effects. */
export function carryPreviousState(journal: Journal, root: string, owner: Pick<Scope, 'userId' | 'characterId'>, clock: Clock) {
  if (journal.records().length !== 1) return
  const { folder, dayKey } = journalLocation(root, owner, clock)
  const previous = readdirSync(folder).filter((name) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(name) && name < `${dayKey}.jsonl`).sort().at(-1)
  if (!previous) return
  const records = parseJournalContent(readFileSync(join(folder, previous), 'utf8'), owner)
  const state = projectJournal(records)
  const consumed = new Set(records.flatMap((row) => row.type === 'inbox/drain' || row.type === 'inbox/drop' ? row.ids : []))
  const pomodoro = state.pomodoro.plan?.status === 'finished' ? idleTimer() : state.pomodoro
  journal.append({ type: 'session/carry', sourceSessionId: state.scope.sessionId, sourceSeq: state.lastSeq,
    mode: state.mode, lightsOut: state.lightsOut, sleeping: state.sleeping, onboarding: state.onboarding, pomodoro, pomodoroPause: state.pomodoroPause,
    pomodoroEvents: state.pomodoroEvents.filter((event) => !consumed.has(event.id)), pendingEvents: state.pendingEvents.slice(0, 32) })
}
