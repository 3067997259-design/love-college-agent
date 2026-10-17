import type { AppCommand, PublicErrorCode, ResourceBudgetView } from '../../shared'
import type { Clock } from '../clock'
import type { JournalRecord } from '../journal/schema'
import { openResourceLedger, ResourceFailure, type ResourceLedger } from './ledger'
import { openResourceMutex } from './sqlite-mutex'

export function createResourceBudget(options: { root: string; clock: Clock; configurable: boolean }) {
  let mutex: ReturnType<typeof openResourceMutex> | undefined; let ledger: ResourceLedger | undefined
  try { mutex = openResourceMutex(options.root); ledger = openResourceLedger({ ...options, atomic: mutex.atomic }) } catch { /* Keep the book usable; every paid admission fails closed. */ }
  const required = () => { if (!ledger) throw new ResourceFailure('unavailable'); return ledger }
  return {
    reserveModel: (units: number, bucket: 'work' | 'autonomous') => required().reserveModel(units, bucket),
    reserveSpeech: (chars: number) => required().reserveSpeech(chars),
    bootstrap: (profile: string, rows: readonly JournalRecord[]) => { try { required().bootstrap(profile, rows) } catch { ledger = undefined } },
    view: (): ResourceBudgetView => ledger?.view() ?? { status: 'unavailable', accounting: 'reserved-units', configurable: options.configurable,
      model: { dayKey: options.clock.iso(options.clock.nowMs() + 4 * 3600000).slice(0, 10), totalReservedUnits: null, autonomousReservedUnits: null, totalLimitUnits: 500000, autonomousLimitUnits: 100000, attemptCount: null, legacyReservedUnits: null },
      speech: { dayKey: options.clock.iso(options.clock.nowMs() + 8 * 3600000).slice(0, 10), reservedChars: null, charLimit: 12000, attemptCount: null, attemptLimit: 30 } },
    dispatch: (command: AppCommand): PublicErrorCode | undefined => {
      if (command.type !== 'resources.configure') return 'invalid-command'
      try { required().configure({ dailyTotalUnits: command.dailyTotalUnits, dailyAutonomousUnits: command.dailyAutonomousUnits }) }
      catch (error) { return error instanceof ResourceFailure ? error.code : 'unavailable' }
    },
    close: () => { ledger = undefined; mutex?.close(); mutex = undefined },
  }
}
export type ResourceBudget = ReturnType<typeof createResourceBudget>
