import assert from 'node:assert/strict'

/** The application appends while the gateway reads. Only newline-terminated
 * records can serve as admission receipts; a partial tail is not yet published. */
export function completedJournalRecords(text: string): Record<string, unknown>[] {
  const end = text.lastIndexOf('\n')
  return end < 0 ? [] : text.slice(0, end).split('\n').map(line => JSON.parse(line))
}

/** Keep a batch cap independently of the resource ledger's daily rollover. */
export function createWorldProbeAdmissions(reserve: (units: number) => void) {
  const consumed = new Set<string>()
  let calls = 0, reservedUnits = 0
  return {
    admit: (ticket: string, units: number) => {
      assert.ok(calls < 12 && !consumed.has(ticket), 'UNADMITTED_REQUEST')
      assert.ok(Number.isSafeInteger(units) && units > 0 && reservedUnits + units <= 256000, 'BATCH_BUDGET_EXCEEDED')
      reserve(units)
      consumed.add(ticket); calls++; reservedUnits += units
    },
    view: () => ({ calls, reservedUnits }),
  }
}
