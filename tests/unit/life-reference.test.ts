import { expect, it } from 'vitest'
import type { LifeView, OutingView } from '../../src/shared'
import { createManualClock } from '../../src/main/clock'
import { lifeReference } from '../../src/main/life/reference'
import { composeContext } from '../../src/main/context/composer'
import cases from '../fixtures/world-reference-cases.json'

it.each(cases)('keeps $id distinct from an acquired souvenir', (scenario) => {
  const clock = createManualClock(Date.parse('2026-11-01T18:06:00+08:00')), start = clock.nowMs()
  clock.advanceBy(scenario.elapsedMinutes * 60_000)
  const world: LifeView = { dayKey: '2026-11-01', userSchedule: 'rest', locationId: scenario.status === 'away' ? 'coast' : 'room', settledUntilMs: clock.nowMs(), agenda: [],
    outings: [{ id: 'trip', place: 'coast', status: scenario.status as OutingView['status'], startsAtMs: start, returnsAtMs: start + 3600_000, acquiredAtMs: start + 2100_000, item: 'shell', settledAtMs: ['returned', 'cut_short', 'cancelled'].includes(scenario.status) ? clock.nowMs() : null, offline: false }],
    items: scenario.hasItem ? [{ id: 'shell', outingId: 'trip', dayKey: '2026-11-01', kind: 'shell', place: 'coast', acquiredAtMs: start + 2100_000, display: 'desk' }] : [] }
  const saved = structuredClone(world), reference = lifeReference(world, clock)
  const group = reference.worldFacts[scenario.group as 'plannedOutings']
  expect(group).toHaveLength(1); expect(group[0].statusMeaning).toBe(scenario.meaning)
  expect(group[0].broughtItems).toHaveLength(scenario.hasItem ? 1 : 0)
  expect(group[0]).not.toHaveProperty('item'); expect(group[0]).not.toHaveProperty('acquiredAtMs')
  expect(reference.worldFacts.ownedItemCount).toBe(scenario.hasItem ? 1 : 0)
  if (scenario.status === 'proposed') { expect(group[0]).toHaveProperty('plannedDepartureAt', '2026-11-01T18:06:00.000+08:00'); expect(group[0]).not.toHaveProperty('departedAt') }
  if (['returned', 'cut_short', 'cancelled'].includes(scenario.status)) expect(group[0]).not.toHaveProperty('possibleSouvenir')
  expect(world).toEqual(saved)
  const packed = composeContext({ reference: { ...reference, previousDaysReference: [{ text: 'old '.repeat(9000) }] }, systemText: 'persona', inputText: 'hello', tools: [] })
  expect(JSON.parse(packed.text).worldFacts).toEqual(reference.worldFacts)
  expect(JSON.parse(packed.text).worldFactsNote).toContain('不代表已经出行或返回')
  expect(packed.omitted).toBe(1)
})

it('does not infer souvenirs from a completed trip, and labels bounded inventory', () => {
  const clock = createManualClock(0)
  const outing: OutingView = { id: 'old', place: 'coast', status: 'returned', startsAtMs: 0, returnsAtMs: 100, acquiredAtMs: 50, item: 'shell', settledAtMs: 100, offline: true }
  const world: LifeView = { dayKey: '1970-01-01', userSchedule: 'auto', locationId: 'room', settledUntilMs: 100, agenda: [], outings: [outing], items: [] }
  expect(lifeReference(world, clock).worldFacts.completedOutings[0].broughtItems).toEqual([])
  world.items = Array.from({ length: 4 }, (_, i) => ({ id: String(i), outingId: 'other', dayKey: world.dayKey, kind: 'leaf', place: 'swing', acquiredAtMs: 1, display: 'drawer' }))
  const ref = lifeReference(world, clock)
  expect(ref.worldFacts.items).toHaveLength(3); expect(ref.worldFacts.ownedItemCount).toBe(4)
  expect(ref.worldFacts.completedOutings[0].broughtItems).toEqual([])
  expect(ref.actualOfflineWork).toBe(false)
})
