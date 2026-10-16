import { createManualClock } from '../clock'
import { openSessionStore } from '../store/session'
import { createScheduler } from '../scheduler'
import { openEvidenceVault } from '../mail/evidence-vault'
import { createFakeMailbox, createBlockedImapSource } from '../mail/fake'
import { createCampusService } from '../campus/service'
import { createUserEvidenceReader } from '../bridge/evidence'

export async function probeCampus(root: string) {
  const clock = createManualClock(0); clock.advanceBy(clock.parse('2026-10-16T19:45:00+08:00'))
  const owner = { userId: 'campus-probe-user', characterId: 'campus-probe-character' }
  const open = () => {
    const store = openSessionStore(root, owner, clock); const scheduler = createScheduler(clock); const vault = openEvidenceVault(root, owner); const fake = createFakeMailbox(clock)
    const events = new Map<string, string>()
    const campus = createCampusService({ clock, store, scheduler, vault, source: fake.source, privacy: fake.privacy, development: fake, changed: () => {}, emit: (id, text) => { events.set(id, text) } })
    let closed = false
    return { store, vault, campus, fake, scheduler, events, close: async () => { if (closed) return; closed = true; await campus.close(); scheduler.dispose(); vault.close(); store.close() } }
  }
  let current = open()
  try {
    const original = JSON.stringify(await current.fake.source.readUnseen(new AbortController().signal))
    const first = await current.campus.scanNow()
    if (!first.ok || current.campus.candidates().length !== 2 || current.campus.view().processedCount !== 3) throw new Error('CAMPUS_INITIAL_FAILED')
    const assignment = current.campus.candidates().find((item) => item.kind === 'deadline')!
    const evidence = createUserEvidenceReader(async (ref, scope) => current.vault.read(ref, scope))
    const viewed = await evidence(assignment.evidenceRef, current.store.scope)
    if (!viewed.excerpt.includes('RAW_ONLY_MAIL_ONE') || viewed.excerpt.includes('sk-synthetic') || !viewed.highlights.some((span) => viewed.excerpt.slice(span.start, span.end).includes('23:59'))) throw new Error('CAMPUS_EVIDENCE_FAILED')
    const event = current.campus.candidates().find((item) => item.kind === 'event')!
    if (event.deadlineIso !== '2026-10-21T12:00:00+08:00' || event.eventStartIso !== '2026-10-22T19:00:00+08:00' || event.eventEndIso !== '2026-10-22T20:30:00+08:00') throw new Error('CAMPUS_DATES_FAILED')
    await current.campus.scanNow()
    if (JSON.stringify(await current.fake.source.readUnseen(new AbortController().signal)) !== original) throw new Error('CAMPUS_SOURCE_MUTATED')
    if (current.campus.candidates().length !== 2 || current.campus.candidates().some((item) => item.revision !== 1)) throw new Error('CAMPUS_DUPLICATE_FAILED')
    if (JSON.stringify(current.store.history?.()).includes('RAW_ONLY_') || JSON.stringify([...current.events.values()]).includes('RAW_ONLY_')) throw new Error('CAMPUS_RAW_LEAK')
    let denied = false
    try { current.vault.read(assignment.evidenceRef, { ...current.store.scope, characterId: 'other' }) } catch { denied = true }
    if (!denied) throw new Error('CAMPUS_SCOPE_FAILED')
    await current.close(); current = open()
    if (current.campus.candidates().length !== 2 || !current.vault.read(assignment.evidenceRef, current.store.scope).excerpt.includes('RAW_ONLY_MAIL_ONE')) throw new Error('CAMPUS_RESTART_FAILED')
    current.fake.select('privacy-failure'); const failure = await current.campus.scanNow()
    if (failure.ok || failure.error !== 'privacy-unavailable' || current.campus.candidates().length !== 2) throw new Error('CAMPUS_PRIVACY_FAILURE_FAILED')
    current.fake.select('malicious'); const malicious = await current.campus.scanNow()
    if (malicious.ok || malicious.error !== 'privacy-invalid-output' || current.campus.candidates().length !== 2) throw new Error('CAMPUS_INJECTION_FAILED')
    const blocked = createCampusService({ clock, store: current.store, scheduler: current.scheduler, vault: current.vault, source: createBlockedImapSource(), privacy: null, changed: () => {}, emit: () => {} })
    if ((await blocked.scanNow()).error !== 'source-blocked' || blocked.view().unseenCount !== null) throw new Error('CAMPUS_BLOCKED_FAILED')
    await blocked.close()
    return { ok: true, probe: 'campus', source: 'fake', sourceMailUnchanged: true, evidenceScoped: true, rawAbsentFromJournalAndContext: true, relativeDatesVerified: true,
      deduplicated: true, restartPreserved: true, privacyFailureClosed: true, invalidOutputRejected: true, realImapNotAttempted: true }
  } finally { await current.close() }
}
