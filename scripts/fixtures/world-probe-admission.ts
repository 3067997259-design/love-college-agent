import assert from 'node:assert/strict'

/** The application appends while the gateway reads. Only newline-terminated
 * records can serve as admission receipts; a partial tail is not yet published. */
export function completedJournalRecords(text: string): Record<string, unknown>[] {
  const end = text.lastIndexOf('\n')
  return end < 0 ? [] : text.slice(0, end).split('\n').map(line => JSON.parse(line))
}

/** Keep a batch cap independently of the resource ledger's daily rollover. */
export type WorldProbeLimits = { maximumCalls: number; maximumReservedUnits: number }
export function createWorldProbeAdmissions(reserve: (units: number) => void, limits: WorldProbeLimits = { maximumCalls: 12, maximumReservedUnits: 256000 }) {
  const { maximumCalls, maximumReservedUnits } = limits
  assert.ok(Number.isSafeInteger(maximumCalls) && maximumCalls > 0 && maximumCalls <= 12, 'INVALID_CALL_LIMIT')
  assert.ok(Number.isSafeInteger(maximumReservedUnits) && maximumReservedUnits > 0 && maximumReservedUnits <= 256000, 'INVALID_UNIT_LIMIT')
  const consumed = new Set<string>()
  let calls = 0, reservedUnits = 0
  return {
    admit: (ticket: string, units: number) => {
      assert.ok(calls < maximumCalls && !consumed.has(ticket), 'UNADMITTED_REQUEST')
      assert.ok(Number.isSafeInteger(units) && units > 0 && reservedUnits + units <= maximumReservedUnits, 'BATCH_BUDGET_EXCEEDED')
      reserve(units)
      consumed.add(ticket); calls++; reservedUnits += units
    },
    view: () => ({ calls, reservedUnits }),
  }
}
