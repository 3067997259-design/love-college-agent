import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { AppCommand } from '../../src/shared'
import { createManualClock } from '../../src/main/clock'
import { openJournal } from '../../src/main/journal/file'
import { projectJournal } from '../../src/main/journal/projection'
import type { SessionStore } from '../../src/main/store/session'
import { createScheduler } from '../../src/main/scheduler'
import { createCampusService } from '../../src/main/campus/service'
import { createFakeMailbox } from '../../src/main/mail/fake'
import { digest, evidenceView, type EvidenceVault } from '../../src/main/mail/evidence-vault'
import type { SourceMail } from '../../src/main/mail/types'
import type { CheckedMail } from '../../src/main/mail/privacy'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'lca-campus-'))
  cleanups.push(async () => { if (!resolve(root).startsWith(join(resolve(tmpdir()), 'lca-campus-'))) throw new Error('Unsafe cleanup path'); rmSync(root, { recursive: true, force: true }) })
  const clock = createManualClock(0); clock.advanceBy(clock.parse('2026-10-16T19:45:00+08:00'))
  const journal = openJournal(root, { userId: 'u', characterId: 'c' }, clock)
  const store: SessionStore = { scope: journal.scope, projection: () => projectJournal(journal.records()), records: journal.records, append: journal.append, close: journal.close }
  const raw = new Map<string, { mail: SourceMail; quotes: CheckedMail['quotes'] }>()
  const vault: EvidenceVault = { put: (key, mail, quotes) => { const ref = 'e:' + digest(key + JSON.stringify(quotes)); raw.set(ref, { mail, quotes }); return ref },
    read: (ref, scope) => { const data = raw.get(ref); if (!data || scope.userId !== 'u' || scope.characterId !== 'c') throw new Error('EVIDENCE_UNAVAILABLE'); return evidenceView(data.mail, data.quotes) }, cache: () => {}, close: () => {} }
  const scheduler = createScheduler(clock); const fake = createFakeMailbox(clock); const emitted: string[] = []
  const campus = createCampusService({ clock, store, scheduler, vault, source: fake.source, privacy: fake.privacy, development: fake, changed: () => {}, emit: (_id, text) => emitted.push(text) })
  cleanups.push(async () => { await campus.close(); scheduler.dispose(); store.close() })
  await campus.scanNow()
  const id = campus.candidates().find((item) => item.kind === 'deadline')!.id
  const command = (body: { type: 'candidate.confirm' | 'candidate.ignore'; expectedRevision?: number; plannedCompletionIso?: string | null }) => ({ ...body, candidateId: id, protocolVersion: 1, epoch: 'test', requestId: String(store.records().length) } as AppCommand)
  return { campus, fake, vault, raw, id, store, clock, emitted, command }
}
describe('user-only versioned campus confirmation', () => {
  it('rejects stale/missing versions and confirms idempotently while preserving the original deadline', async () => {
    const f = await fixture()
    expect(f.campus.dispatch(f.command({ type: 'candidate.confirm' }))).toBe('stale-candidate')
    expect(f.campus.dispatch(f.command({ type: 'candidate.confirm', expectedRevision: 9 }))).toBe('stale-candidate')
    const planned = '2026-10-23T20:00:00+08:00'
    expect(f.campus.dispatch(f.command({ type: 'candidate.confirm', expectedRevision: 1, plannedCompletionIso: planned }))).toBeUndefined()
    f.campus.dispatch(f.command({ type: 'candidate.confirm', expectedRevision: 1 }))
    const item = f.campus.repository.view().items.find((item) => item.current.id === f.id)!
    expect(item.current).toMatchObject({ status: 'confirmed', deadlineIso: '2026-10-24T23:59:00+08:00', plannedCompletionIso: planned })
    expect(f.store.records().filter((row) => row.type === 'campus/confirmed')).toHaveLength(1)
    expect(f.campus.deliveries()).toHaveLength(0)
  })
  it('holds both evidence refs and the old accepted schedule until the changed revision is confirmed', async () => {
    const f = await fixture(); f.campus.dispatch(f.command({ type: 'candidate.confirm', expectedRevision: 1 }))
    const old = f.campus.repository.view().items.find((item) => item.current.id === f.id)!
    f.fake.select('deadline-change'); await f.campus.scanNow()
    const changed = f.campus.repository.view().items.find((item) => item.current.id === f.id)!
    expect(changed.current).toMatchObject({ status: 'changed', revision: 2, deadlineIso: '2026-10-26T23:59:00+08:00', change: { previousDeadlineIso: '2026-10-24T23:59:00+08:00' } })
    expect(changed.accepted?.deadlineIso).toBe('2026-10-24T23:59:00+08:00'); expect(changed.calendarUid).toBe(old.calendarUid)
    expect(changed.current.change?.previousEvidenceRef).toBe(old.current.evidenceRef)
    expect(f.campus.dispatch(f.command({ type: 'candidate.confirm', expectedRevision: 1 }))).toBe('stale-candidate')
    f.campus.dispatch(f.command({ type: 'candidate.confirm', expectedRevision: 2 }))
    expect(f.campus.repository.view().items.find((item) => item.current.id === f.id)).toMatchObject({ sequence: 1, accepted: { revision: 2, deadlineIso: '2026-10-26T23:59:00+08:00' } })
    expect(JSON.stringify(f.store.records())).not.toContain('RAW_ONLY_'); expect(JSON.stringify(f.emitted)).not.toContain('RAW_ONLY_')
  })
  it('ignoring a change preserves the accepted deadline and does not advance calendar sequence', async () => {
    const f = await fixture(); f.campus.dispatch(f.command({ type: 'candidate.confirm', expectedRevision: 1 }))
    f.fake.select('deadline-change'); await f.campus.scanNow(); f.campus.dispatch(f.command({ type: 'candidate.ignore', expectedRevision: 2 }))
    expect(f.campus.repository.view().items.find((item) => item.current.id === f.id)).toMatchObject({ sequence: 0,
      current: { revision: 2, status: 'confirmed', deadlineIso: '2026-10-24T23:59:00+08:00' }, accepted: { revision: 1 } })
  })
  it('does not accept a proposal if its source evidence is unavailable', async () => {
    const f = await fixture(); f.raw.clear()
    expect(f.campus.dispatch(f.command({ type: 'candidate.confirm', expectedRevision: 1 }))).toBe('evidence-unavailable')
    expect(f.campus.candidates().find((item) => item.id === f.id)?.status).toBe('candidate')
  })
})
