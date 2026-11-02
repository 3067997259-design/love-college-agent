import { expect, it } from 'vitest'
import { createContinuityProbeBudget, compactAdmission } from '../../scripts/fixtures/continuity-live-budget'
import plan from '../../scripts/continuity-live-plan.json'

const limits = { maximumModelRequests: 3, maximumReservedUnits: 10_000, maximumAutonomousUnits: 5000, maximumEmbeddingRequests: 2, maximumEmbeddingInputCharacters: 20 }
it('enforces a separate one-request retry even when the first response used little quota', () => {
  const charges: number[] = [], b = createContinuityProbeBudget(plan.firstRequestLimits, units => { charges.push(units) })
  expect(() => b.model('auto', 1, 'autonomous')).toThrow('AUTONOMOUS_UNITS_EXHAUSTED')
  expect(() => b.embedding('embed', 'tea')).toThrow('EMBEDDING_BUDGET_EXHAUSTED')
  b.model('first', 1, 'work')
  expect(() => b.model('retry', 1, 'work')).toThrow('MODEL_REQUESTS_EXHAUSTED')
  expect(charges).toEqual([1]); expect(b.view().modelRequests).toBe(1)
})
it('binds compaction only to one new published unconsumed ledger receipt', () => {
  const old = { kind: 'model', id: 'old', units: 100, bucket: 'work' }, fresh = { ...old, id: 'new' }, baseline = new Set(['old'])
  expect(compactAdmission([old, fresh], baseline, () => false)).toEqual({ ticket: 'compact:new', units: 100, bucket: 'work' })
  expect(() => compactAdmission([old], baseline, () => false)).toThrow('COMPACTION_ADMISSION_AMBIGUOUS')
  expect(() => compactAdmission([old, fresh], baseline, () => true)).toThrow('COMPACTION_ADMISSION_AMBIGUOUS')
  expect(() => compactAdmission([old, fresh, { ...fresh, id: 'other' }], baseline, () => false)).toThrow('COMPACTION_ADMISSION_AMBIGUOUS')
})
it('includes embedding in both the total and autonomous allowance', () => {
  const charges: unknown[] = [], b = createContinuityProbeBudget(limits, (units, bucket) => { charges.push([units, bucket]) })
  b.model('chat', 7000, 'work'); b.embedding('embedding', '茶')
  expect(b.view()).toEqual({ modelRequests: 1, embeddingRequests: 1, embeddingCharacters: 1, reservedUnits: 9051, autonomousUnits: 2051 })
  expect(() => b.model('background', 1000, 'autonomous')).toThrow('BATCH_UNITS_EXHAUSTED')
  expect(charges).toEqual([[7000, 'work'], [2051, 'autonomous']])
})
it('blocks replay and does not charge rejected attempts', () => {
  let charges = 0
  const b = createContinuityProbeBudget(limits, () => { charges++ })
  b.model('one', 1, 'work')
  expect(() => b.model('one', 1, 'work')).toThrow('REPLAYED_ADMISSION')
  b.model('two', 1, 'work'); b.model('three', 1, 'work')
  expect(() => b.model('four', 1, 'work')).toThrow('MODEL_REQUESTS_EXHAUSTED')
  expect(charges).toBe(3)
})
it('retains a receipt when the ledger refuses admission', () => {
  let blocked = true
  const b = createContinuityProbeBudget(limits, () => { if (blocked) throw Error('ledger unavailable') })
  expect(() => b.embedding('same', 'tea')).toThrow('ledger unavailable')
  expect(b.consumed('same')).toBe(false); expect(b.view().embeddingRequests).toBe(0)
  blocked = false; b.embedding('same', 'tea'); expect(b.view().embeddingRequests).toBe(1)
})
it('keeps batch limits across daily ledger changes and zero autonomous policy', () => {
  let daily = 0
  const b = createContinuityProbeBudget({ ...limits, maximumAutonomousUnits: 0 }, units => { daily += units })
  b.model('before', 9000, 'work'); daily = 0
  expect(() => b.model('after', 1001, 'work')).toThrow('BATCH_UNITS_EXHAUSTED')
  expect(() => b.embedding('embed', 'a')).toThrow('BATCH_UNITS_EXHAUSTED')
  expect(() => b.model('auto', 1, 'autonomous')).toThrow('AUTONOMOUS_UNITS_EXHAUSTED')
  expect(daily).toBe(0)
})
it('checks both embedding request and input limits before charging', () => {
  let charges = 0
  const b = createContinuityProbeBudget(limits, () => { charges++ })
  expect(() => b.embedding('long', 'x'.repeat(21))).toThrow('EMBEDDING_BUDGET_EXHAUSTED')
  b.embedding('one', 'a'); b.embedding('two', 'b')
  expect(() => b.embedding('three', 'c')).toThrow('EMBEDDING_BUDGET_EXHAUSTED')
  expect(charges).toBe(2)
})
