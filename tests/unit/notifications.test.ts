import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { createManualClock } from '../../src/main/clock'
import { openJournal } from '../../src/main/journal/file'
import { projectJournal } from '../../src/main/journal/projection'
import { createScheduler } from '../../src/main/scheduler'
import { createNotifications } from '../../src/main/notifications/service'
import type { SessionStore } from '../../src/main/store/session'
import type { AppCommand, CandidateView } from '../../src/shared'
const cleanups: (() => void)[] = []
afterEach(() => cleanups.splice(0).reverse().forEach((cleanup) => cleanup()))
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'lca-notify-')); cleanups.push(() => { if (!resolve(root).startsWith(join(resolve(tmpdir()), 'lca-notify-'))) throw new Error('UNSAFE'); rmSync(root, { recursive: true, force: true }) })
  const clock = createManualClock(100000000); const journal = openJournal(root, { userId: 'u', characterId: 'c' }, clock)
  const store: SessionStore = { scope: journal.scope, records: journal.records, append: journal.append, projection: () => projectJournal(journal.records()), close: journal.close }; const scheduler = createScheduler(clock); const notify = vi.fn(); const candidates: CandidateView[] = []
  const options = { store, clock, scheduler, notify, candidates: () => candidates, approval: () => 'pending-script', synthetic: true, changed: () => {} }; const service = createNotifications(options); scheduler.cancel('notifications.merge'); cleanups.push(store.close); cleanups.push(scheduler.dispose)
  const add = (id: string, urgent = true) => candidates.push({ id, createdAtMs: clock.nowMs(), kind: 'deadline', title: 'PRIVATE_SHORT_TITLE', deadlineIso: urgent ? clock.iso(clock.nowMs() + 12 * 3600000) : clock.iso(clock.nowMs() + 7 * 86400000), plannedCompletionIso: null, status: 'candidate', revision: 1, sourceLabel: '课程助教 · PRIVATE_SHORT_TITLE', evidenceRef: 'USER_ONLY_EVIDENCE' })
  const flush = () => { service.reconcile(); clock.advanceBy(15000); service.reconcile() }
  const dispatch = (body: Record<string, unknown>) => service.dispatch({ ...body, protocolVersion: 1, epoch: 'x', requestId: 'x' } as AppCommand)
  return { store, clock, options, service, candidates, notify, add, flush, dispatch }
}
it('merges only urgent facts without private short fields, limits delivery and persists dedup', () => {
  const f = fixture(); f.add('a'); f.add('b'); f.add('far', false); f.flush(); expect(f.notify).toHaveBeenCalledOnce(); expect(f.notify.mock.calls[0][0].body).toContain('2')
  expect(JSON.stringify(f.notify.mock.calls)).not.toMatch(/PRIVATE_SHORT_TITLE|USER_ONLY_EVIDENCE/)
  const restart = createNotifications(f.options); restart.reconcile(); f.clock.advanceBy(15000); restart.reconcile(); expect(f.notify).toHaveBeenCalledOnce(); restart.close()
  f.add('c'); f.flush(); f.add('d'); f.flush(); f.add('e'); f.flush(); expect(f.notify).toHaveBeenCalledTimes(3)
  f.clock.advanceBy(3600000); f.flush(); expect(f.notify).toHaveBeenCalledTimes(4)
})
it('keeps model rules inert until confirmed, supports removal, pauses in darkness and notifies approvals only while quiet', () => {
  const f = fixture(); f.add('far', false); const id = f.service.propose({ sourceRole: 'teaching-assistant', keyword: 'PRIVATE' }); f.flush(); expect(f.notify).not.toHaveBeenCalled()
  f.dispatch({ type: 'notification.rule.confirm', ruleId: id }); f.flush(); expect(f.notify).toHaveBeenCalledOnce(); f.dispatch({ type: 'notification.rule.remove', ruleId: id }); expect(f.service.view().rules).toHaveLength(0)
  f.store.append({ type: 'companion/mode', mode: 'quiet', requestId: 'quiet', commandHash: 'x' }); f.store.append({ type: 'companion/lights', lightsOut: true, requestId: 'dark', commandHash: 'x' }); f.flush(); expect(f.notify).toHaveBeenCalledOnce()
  f.store.append({ type: 'companion/lights', lightsOut: false, requestId: 'light', commandHash: 'x' }); f.flush(); expect(f.notify.mock.calls[1][0].kind).toBe('flow-approval')
})
