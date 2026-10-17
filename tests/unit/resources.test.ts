import { mkdtempSync, rmSync, readFileSync, writeFileSync, appendFileSync, unlinkSync, linkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { createManualClock } from '../../src/main/clock'
import { openResourceLedger } from '../../src/main/resources/ledger'
import { openJournal } from '../../src/main/journal/file'
import { createAppController } from '../../src/main/bridge/controller'

const cleanup: (() => void)[] = []
afterEach(() => cleanup.splice(0).reverse().forEach((close) => close()))
function fixture(configurable = true) {
  const root = mkdtempSync(join(tmpdir(), 'lca-resources-'))
  cleanup.push(() => { if (!resolve(root).startsWith(join(resolve(tmpdir()), 'lca-resources-'))) throw new Error('UNSAFE'); rmSync(root, { recursive: true, force: true }) })
  const clock = createManualClock(Date.parse('2026-10-17T03:59:00+08:00')); const options = { root, clock, atomic: <T>(body: () => T) => body(), configurable }
  const ledger = openResourceLedger(options)
  return { root, clock, ledger, options, reopen: () => openResourceLedger(options) }
}
it('reserves before dispatch, never refunds failed requests, and survives reopen independently of a book', () => {
  const f = fixture(); f.ledger.reserveModel(5000, 'work'); f.ledger.reserveModel(100000, 'autonomous')
  expect(() => f.ledger.reserveModel(1, 'autonomous')).toThrow(); expect(f.reopen().view().model).toMatchObject({ totalReservedUnits: 105000, autonomousReservedUnits: 100000, attemptCount: 2 })
  for (let i = 0; i < 10; i++) f.ledger.reserveSpeech(1200)
  expect(() => f.ledger.reserveSpeech(1)).toThrow(); expect(f.reopen().view().speech).toMatchObject({ reservedChars: 12000, attemptCount: 10 })
  const short = fixture(); for (let i = 0; i < 30; i++) short.ledger.reserveSpeech(1)
  expect(() => short.ledger.reserveSpeech(1)).toThrow(); expect(short.ledger.view().speech).toMatchObject({ reservedChars: 30, attemptCount: 30 })
})
it('allows only an operator to change valid limits and applies reductions to subsequent admissions', () => {
  const f = fixture(); f.ledger.reserveModel(12000, 'work'); f.ledger.configure({ dailyTotalUnits: 10000, dailyAutonomousUnits: 0 })
  expect(() => f.ledger.reserveModel(1, 'work')).toThrow(); expect(f.ledger.view().model.totalReservedUnits).toBe(12000)
  f.ledger.configure({ dailyTotalUnits: 1000000, dailyAutonomousUnits: 500000 }); f.ledger.reserveModel(200000, 'autonomous')
  const normal = openResourceLedger({ ...f.options, configurable: false }); expect(normal.view().model.autonomousReservedUnits).toBe(200000)
  expect(() => normal.configure({ dailyTotalUnits: 10000, dailyAutonomousUnits: 0 })).toThrow()
  for (const value of [{ dailyTotalUnits: 10000, dailyAutonomousUnits: 10001 }, { dailyTotalUnits: 5000001, dailyAutonomousUnits: 0 }, { dailyTotalUnits: 9999, dailyAutonomousUnits: 0 }, { dailyTotalUnits: 10000.1, dailyAutonomousUnits: 0 }]) expect(() => f.ledger.configure(value)).toThrow()
})
it('keeps model 04:00 days distinct from speech calendar days', () => {
  const f = fixture(); f.ledger.reserveModel(1000, 'work'); f.ledger.reserveSpeech(10)
  expect(f.ledger.view().model.dayKey).toBe('2026-10-16'); expect(f.ledger.view().speech.dayKey).toBe('2026-10-17')
  f.clock.advanceBy(120000); expect(f.ledger.view().model.totalReservedUnits).toBe(0); expect(f.ledger.view().speech.reservedChars).toBe(10)
  f.ledger.reserveModel(2000, 'autonomous'); f.clock.advanceBy(20 * 3600000)
  expect(f.ledger.view().model.totalReservedUnits).toBe(2000); expect(f.ledger.view().speech.reservedChars).toBe(0)
})
it('migrates legacy current-day reservations once without storing source identifiers or charging imported modern books', () => {
  const f = fixture(); const journal = openJournal(join(f.root, 'legacy-book'), { userId: 'PRIVATE_OWNER_CANARY', characterId: 'c' }, f.clock); cleanup.push(journal.close)
  journal.append({ type: 'user/message', id: 'u', text: 'PRIVATE_TEXT_CANARY', requestId: 'r', commandHash: 'h' })
  journal.append({ type: 'model/attempt', turnId: 'PRIVATE_TURN_CANARY', slot: 'chat', attempt: 1, waitMs: 0, status: 'started', reservedTokens: 6400, bucket: 'autonomous' })
  journal.append({ type: 'voice/attempt', id: 'legacy-speech', source: 'fake', dayKey: '2026-10-17', charCount: 15 })
  f.ledger.bootstrap('PRIVATE_PROFILE_CANARY', journal.records()); f.ledger.bootstrap('PRIVATE_PROFILE_CANARY', journal.records()); f.ledger.bootstrap('another-profile', journal.records())
  expect(f.ledger.view().model).toMatchObject({ totalReservedUnits: 6400, legacyReservedUnits: 6400, attemptCount: 1 }); expect(f.ledger.view().speech.reservedChars).toBe(15)
  const id = f.ledger.reserveModel(1000, 'work'); journal.append({ type: 'model/attempt', turnId: 'modern', slot: 'chat', attempt: 1, waitMs: 0, status: 'started', reservedTokens: 1000, bucket: 'work', resourceReservationId: id })
  f.ledger.bootstrap('restored-profile', journal.records()); expect(f.ledger.view().model.totalReservedUnits).toBe(7400)
  const text = readFileSync(join(f.root, 'usage.jsonl'), 'utf8'); expect(text).not.toContain('PRIVATE_'); expect(text).not.toContain('modern')
})
it('observes another ledger writer instead of trusting a stale in-memory balance', () => {
  const f = fixture(); const other = f.reopen(); expect(other.view().model.totalReservedUnits).toBe(0)
  f.ledger.reserveModel(1000, 'work'); other.reserveModel(2000, 'work'); expect(f.ledger.view().model.totalReservedUnits).toBe(3000)
})
it('accepts operator commands only from the book and validates them before invoking the resource port', () => {
  const f = fixture(); const controller = createAppController(f.clock); cleanup.push(controller.dispose)
  const dispatch = vi.fn(() => undefined); controller.attachResources({ ...f.ledger, dispatch, close: () => {} })
  const command = () => ({ protocolVersion: 1, epoch: controller.getSnapshot().epoch, requestId: crypto.randomUUID(), type: 'resources.configure', dailyTotalUnits: 10000, dailyAutonomousUnits: 0 })
  expect(controller.dispatch(command(), 'mini')).toMatchObject({ status: 'rejected', error: { code: 'permission-denied' } }); expect(dispatch).not.toHaveBeenCalled()
  expect(controller.dispatch({ ...command(), dailyAutonomousUnits: 10001 })).toMatchObject({ status: 'rejected', error: { code: 'invalid-command' } }); expect(dispatch).not.toHaveBeenCalled()
  expect(controller.dispatch(command())).toMatchObject({ status: 'accepted' }); expect(dispatch).toHaveBeenCalledOnce()
})
it.each(['truncated', 'corrupt', 'deleted', 'hardlink', 'identity'])('fails closed on a %s authority without resetting it', (kind) => {
  const f = fixture(); f.ledger.reserveModel(2000, 'work'); const path = join(f.root, 'usage.jsonl')
  if (kind === 'truncated') appendFileSync(path, '{')
  if (kind === 'corrupt') writeFileSync(path, '{}\n')
  if (kind === 'deleted') unlinkSync(path)
  if (kind === 'hardlink') linkSync(path, join(f.root, 'alias'))
  if (kind === 'identity') writeFileSync(join(f.root, 'identity.json'), JSON.stringify({ id: crypto.randomUUID() }))
  expect(f.ledger.view()).toMatchObject({ status: 'unavailable', model: { totalReservedUnits: null } })
  expect(() => f.ledger.reserveModel(1, 'work')).toThrow(); expect(() => f.reopen()).toThrow()
})
