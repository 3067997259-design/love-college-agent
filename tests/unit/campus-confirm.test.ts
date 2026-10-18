import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
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
import { createArtifactStore } from '../../src/main/artifacts/store'
import { mailTools } from '../../src/main/mail/tools'
import { omitIgnoredMail } from '../../src/main/campus/context'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
async function fixture(followMain?: () => boolean) {
  const root = mkdtempSync(join(tmpdir(), 'lca-campus-'))
  cleanups.push(async () => { if (!resolve(root).startsWith(join(resolve(tmpdir()), 'lca-campus-'))) throw new Error('Unsafe cleanup path'); rmSync(root, { recursive: true, force: true }) })
  const clock = createManualClock(0); clock.advanceBy(clock.parse('2026-10-16T19:45:00+08:00'))
  const journal = openJournal(root, { userId: 'u', characterId: 'c' }, clock)
  const store: SessionStore = { scope: journal.scope, projection: () => projectJournal(journal.records()), records: journal.records, append: journal.append, close: journal.close }
  const raw = new Map<string, { mail: SourceMail; quotes: CheckedMail['quotes'] }>()
  const vault: EvidenceVault = { put: (key, mail, quotes) => { const ref = 'e:' + digest(key + JSON.stringify(quotes)); raw.set(ref, { mail, quotes }); return ref },
    readForModel: (ref) => { const data = raw.get(ref); if (!data) throw new Error('EVIDENCE_UNAVAILABLE'); return data.mail },
    read: (ref, scope) => { const data = raw.get(ref); if (!data || scope.userId !== 'u' || scope.characterId !== 'c') throw new Error('EVIDENCE_UNAVAILABLE'); return evidenceView(data.mail, data.quotes) }, cache: () => {}, close: () => {} }
  const scheduler = createScheduler(clock); const fake = createFakeMailbox(clock); const emitted: string[] = []
  const artifacts = createArtifactStore(root, store.scope)
  const campus = createCampusService({ clock, store, scheduler, vault, artifacts, followMain, source: fake.source, privacy: fake.privacy, development: fake, changed: () => {}, emit: (_id, text) => emitted.push(text) })
  cleanups.push(async () => { await campus.close(); scheduler.dispose(); store.close() })
  await campus.scanNow()
  const id = campus.candidates().find((item) => item.kind === 'deadline')!.id
  const command = (body: { type: 'candidate.confirm' | 'candidate.ignore'; expectedRevision?: number; plannedCompletionIso?: string | null }) => ({ ...body, candidateId: id, protocolVersion: 1, epoch: 'test', requestId: String(store.records().length) } as AppCommand)
  return { campus, fake, vault, raw, id, store, clock, emitted, command, artifacts }
}
describe('user-only versioned campus confirmation', () => {
  it('excludes ignored mail from raw context, outbox, current tools and historical generated model context', async () => {
    const f = await fixture(() => true)
    for (const candidate of f.campus.candidates()) f.campus.dispatch({ protocolVersion: 1, epoch: 'test', requestId: candidate.id, type: 'candidate.ignore', expectedRevision: candidate.revision, candidateId: candidate.id })
    expect(f.campus.mainContext().every((source) => !f.campus.candidates().some((candidate) => candidate.evidenceRef === source.ref))).toBe(true)
    f.emitted.length = 0; f.campus.flush(); expect(f.emitted).toEqual([])
    const tool = mailTools(f.campus)[1]
    const result = await tool.run({}, { signal: new AbortController().signal, turnId: 'test', callId: 'test', clock: f.clock, store: f.store })
    expect(result.visible).toEqual({ items: [] })
    const original = [{ role: 'user' as const, content: JSON.stringify({ source: 'mail', facts: JSON.stringify({ candidateId: f.id, title: 'STALE_MAIL' }) }) },
      { role: 'tool' as const, toolCallId: 'test', content: JSON.stringify({ items: [{ candidateId: f.id, title: 'STALE_MAIL' }] }) },
      { role: 'user' as const, content: '请帮我读刚上传的文件' }]
    const cleaned = omitIgnoredMail(original, new Set([f.id]))
    expect(JSON.stringify(cleaned)).not.toContain('STALE_MAIL'); expect(cleaned[2]).toEqual(original[2])
    expect(JSON.stringify(original)).toContain('STALE_MAIL')
  })
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
  it('ingests a plugin candidate once, keeps its excerpt out of the journal, and exposes it as user-only evidence', async () => {
    const f = await fixture()
    const seed = { externalId: 'item:test', title: '提交课程作业', kind: 'deadline' as const, deadlineIso: '2026-11-03T23:00:00+08:00',
      sourceLabel: 'Student Hub · 课程', excerpt: 'PRIVATE_EXCERPT from Student Hub' }
    expect(f.campus.ingestCandidates([seed])).toBe(1)
    const card = f.campus.candidates().find((item) => item.id.startsWith('sh:'))!
    expect(card).toMatchObject({ title: '提交课程作业', kind: 'deadline', deadlineIso: '2026-11-03T15:00:00.000Z', sourceLabel: 'Student Hub · 课程', status: 'candidate' })
    expect(f.vault.read(card.evidenceRef, f.store.scope).excerpt).toContain('PRIVATE_EXCERPT')
    expect(JSON.stringify(f.store.records())).not.toContain('PRIVATE_EXCERPT')
    expect(f.campus.ingestCandidates([seed])).toBe(0)
  })
  it('exports only confirmed revisions and updates the same calendar UID exactly once after change confirmation', async () => {
    const f = await fixture(); f.campus.exportPending(); expect(f.campus.deliveries()).toHaveLength(0)
    f.campus.dispatch(f.command({ type: 'candidate.confirm', expectedRevision: 1 })); f.campus.exportPending(); f.campus.exportPending()
    expect(f.campus.deliveries()).toHaveLength(2)
    const old = f.campus.repository.view().artifacts.find((entry) => entry.view.kind === 'calendar')!
    const oldUid = f.artifacts.read(old).match(/^UID:(.+)$/m)![1].trim()
    f.fake.select('deadline-change'); await f.campus.scanNow(); f.campus.exportPending()
    expect(f.campus.deliveries()).toHaveLength(2)
    f.campus.dispatch(f.command({ type: 'candidate.confirm', expectedRevision: 2 })); f.campus.exportPending(); f.campus.exportPending()
    const calendars = f.campus.repository.view().artifacts.filter((entry) => entry.view.kind === 'calendar')
    expect(calendars).toHaveLength(2); expect(f.campus.deliveries()).toHaveLength(4)
    expect(f.artifacts.read(calendars[1])).toContain('UID:' + oldUid + '\r\nSEQUENCE:1')
    expect(f.artifacts.read(old)).toContain('SEQUENCE:0')
    expect(f.store.records().filter((entry) => entry.type === 'campus/exported')).toHaveLength(2)
  })
  it('records failed deliveries without marking the revision exported and replaces them on a successful retry', async () => {
    const f = await fixture(); f.campus.dispatch(f.command({ type: 'candidate.confirm', expectedRevision: 1 }))
    const write = vi.spyOn(f.artifacts, 'write').mockImplementation(() => { throw new Error('PRIVATE_OS_ERROR') })
    f.campus.exportPending()
    expect(f.campus.deliveries().map((view) => view.status)).toEqual(['failed', 'failed'])
    expect(f.campus.repository.view().items.find((entry) => entry.current.id === f.id)?.exportedRevision).toBeUndefined()
    expect(JSON.stringify(f.store.records())).not.toContain('PRIVATE_OS_ERROR')
    write.mockRestore(); f.campus.exportPending()
    expect(f.campus.deliveries().map((view) => view.status)).toEqual(['ready', 'ready'])
  })
})

it('only exposes sources processed with explicit follow-main, never historical isolated mail after a later policy change', async () => {
  let follow = false
  const f = await fixture(() => follow)
  expect(f.campus.mainContext()).toEqual([])
  follow = true; expect(f.campus.mainContext()).toEqual([])
  f.fake.select('deadline-change'); await f.campus.scanNow()
  const sources = f.campus.mainContext(); expect(sources).toHaveLength(1)
  expect(JSON.stringify(sources)).toContain('RAW_ONLY_MAIL_CHANGE')
  expect(JSON.stringify(f.store.records())).not.toContain('RAW_ONLY_')
  follow = false; expect(f.campus.mainContext()).toEqual([])
})
