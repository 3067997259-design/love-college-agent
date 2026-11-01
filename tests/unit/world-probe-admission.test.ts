import { expect, it } from 'vitest'
import { completedJournalRecords, createWorldProbeAdmissions } from '../../scripts/fixtures/world-probe-admission'

it('reads the published admission while another journal row is partially appended', () => {
  expect(completedJournalRecords('{"type":"model/attempt","reservedTokens":16000}\n{"type":"life/st')).toEqual([{ type: 'model/attempt', reservedTokens: 16000 }])
})
it('cannot admit an unterminated record even when its JSON is complete', () => {
  expect(completedJournalRecords('{"type":"model/attempt","reservedTokens":16000}')).toEqual([])
  expect(completedJournalRecords('')).toEqual([])
})
it('does not hide corrupt completed journal rows', () => {
  expect(() => completedJournalRecords('{bad}\n')).toThrow()
})

it('keeps the batch unit cap even when the daily ledger rolls over', () => {
  let daily = 0
  const batch = createWorldProbeAdmissions(units => { daily += units })
  batch.admit('before-rollover', 200000)
  daily = 0
  expect(() => batch.admit('after-rollover', 60000)).toThrow('BATCH_BUDGET_EXCEEDED')
  expect(daily).toBe(0)
  batch.admit('after-rollover', 56000)
  expect(batch.view()).toEqual({ calls: 2, reservedUnits: 256000 })
})
it('rejects duplicate receipts and the thirteenth call before charging', () => {
  let charges = 0
  const batch = createWorldProbeAdmissions(() => { charges++ })
  for (let i = 0; i < 12; i++) batch.admit('receipt-' + i, 1)
  expect(() => batch.admit('receipt-0', 1)).toThrow('UNADMITTED_REQUEST')
  expect(() => batch.admit('receipt-12', 1)).toThrow('UNADMITTED_REQUEST')
  expect(charges).toBe(12)
})
it('does not consume receipts or count calls when the ledger refuses admission', () => {
  let unavailable = true
  const batch = createWorldProbeAdmissions(() => { if (unavailable) throw new Error('unavailable') })
  expect(() => batch.admit('receipt', 16000)).toThrow('unavailable')
  expect(batch.view()).toEqual({ calls: 0, reservedUnits: 0 })
  unavailable = false
  batch.admit('receipt', 16000)
  expect(batch.view()).toEqual({ calls: 1, reservedUnits: 16000 })
})
