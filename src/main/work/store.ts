import type { ContinuityOwner } from '../../shared/continuity'
import type { Clock } from '../clock'
import { openJournal, sessionDayKey } from '../journal/file'
import { projectJournal } from '../journal/projection'
import type { SessionStore } from '../store/session'

/** A worker's journal never rotates with the front page and is never added to
 * the diary's source collection. Its scope belongs to one work generation. */
export function openWorkStore(root: string, owner: ContinuityOwner, clock: Clock, startedAt: number, main: SessionStore): SessionStore {
  const journal = openJournal(root, { userId: owner.userId, characterId: owner.characterId }, clock, sessionDayKey(clock, startedAt))
  return { scope: journal.scope, records: journal.records, history: journal.records,
    projection: () => {
      const current = main.projection(), own = projectJournal(journal.records())
      return { ...own, mode: current.mode, sleeping: current.sleeping, lightsOut: current.lightsOut, pomodoro: current.pomodoro, onboarding: current.onboarding }
    },
    append: input => { journal.append(input) }, close: journal.close }
}
