import { randomUUID } from 'node:crypto'
import type { AppCommand, MailboxView, PublicErrorCode } from '../../shared'
import type { Clock } from '../clock'
import type { SessionStore } from '../store/session'
import type { Scheduler } from '../scheduler'
import type { EvidenceVault } from '../mail/evidence-vault'
import { digest, mailContentHash } from '../mail/evidence-vault'
import { extractMail, type EmailPrivacyModel } from '../mail/privacy'
import type { MailSource } from '../mail/types'
import type { createFakeMailbox } from '../mail/fake'
import { CampusStorageFailure, createCampusRepository } from './repository'
import { candidateSchema, mailFactsSchema } from './schema'
import { commandHash } from '../journal/file'
import { exportCampusItem } from './export'
import type { ArtifactStore } from '../artifacts/store'
import type { DeliveryView } from '../../shared'
import type { SourceMail } from '../mail/types'
import type { AttachmentRecord } from '../documents/schema'

export interface ScanResult { ok: boolean; source: 'real' | 'fake'; newCount?: number; candidateCount?: number; error?: PublicErrorCode }
export function createCampusService(options: { clock: Clock; store: SessionStore; scheduler: Scheduler; vault: EvidenceVault; source: MailSource;
  privacy: EmailPrivacyModel | null; development?: ReturnType<typeof createFakeMailbox>; changed(): void; emit(id: string, text: string): void; failed?(): void;
  artifacts?: ArtifactStore; openArtifact?(view: DeliveryView, content: string): void;
  attachment?(record: AttachmentRecord): void;
  canProcess?(): boolean;
}) {
  const { clock, store, scheduler, vault, source } = options
  const repository = createCampusRepository(store, vault, options.failed)
  let enabled = true; let disposed = false; let worker: Promise<ScanResult> | undefined; let abort: AbortController | undefined
  let mailbox: MailboxView = { status: source.blocked ? 'blocked' : 'idle', source: source.source, folderLabel: '桃子', unseenCount: null,
    lastAttemptAtMs: null, lastSuccessAtMs: null, processedCount: 0, pendingReviewCount: 0, ...(source.blocked ? { error: { code: 'source-blocked', retryable: false } } : {}) }
  const saved = repository.view().mailbox
  if (saved?.source === source.source && !source.blocked) mailbox = { ...saved, ...(saved.status === 'scanning' ? { status: 'failed' as const, error: { code: 'connection-failed' as const, retryable: true } } : {}) }
  const view = (): MailboxView => ({ ...mailbox, status: enabled ? mailbox.status : 'disabled',
    processedCount: repository.view().processed.length, pendingReviewCount: repository.view().items.filter((item) => ['candidate', 'changed'].includes(item.current.status)).length,
    ...(options.development ? { scenarioId: options.development.scenario() } : {}) })
  const publish = () => options.changed()
  const registerAttachments = (mail: SourceMail, sourceKey: string, candidateId?: string) => {
    for (const part of mail.attachments ?? []) {
      const id = 'att:' + digest(sourceKey + ':' + part.partId)
      options.attachment?.({ view: { id, ...(candidateId ? { candidateId } : {}), displayName: '附件-' + id.slice(-8) + '.' + ({ pdf: 'pdf', text: 'txt', markdown: 'md' }[part.format]),
        byteLength: part.byteLength, format: part.format, source: source.source }, uidValidity: mail.uidValidity, uid: mail.uid, partId: part.partId,
        ...(mail.mailboxId ? { mailboxId: mail.mailboxId } : {}) })
    }
  }
  const setState = (next: Partial<MailboxView>) => { mailbox = { ...mailbox, ...next }; repository.append({ type: 'mail/state', view: view() }); publish() }
  const flush = () => {
    if (!enabled || disposed || store.projection().lightsOut || options.canProcess?.() === false) return
    const records = store.history?.() ?? store.records()
    const consumed = new Set(records.flatMap((row) => row.type === 'inbox/drain' || row.type === 'inbox/drop' ? row.ids : []))
    for (const entry of repository.view().processed) if (entry.facts && !consumed.has('mail:' + entry.sourceKey)) options.emit('mail:' + entry.sourceKey, JSON.stringify(entry.facts))
  }
  const scanNow = (signal?: AbortSignal): Promise<ScanResult> => {
    if (worker) return worker
    if (disposed || !enabled || store.projection().lightsOut || options.canProcess?.() === false) return Promise.resolve({ ok: false, source: source.source, error: 'unavailable' })
    if (source.blocked) return Promise.resolve({ ok: false, source: source.source, error: 'source-blocked' })
    abort = new AbortController(); const local = abort
    const combined = signal ? AbortSignal.any([signal, local.signal]) : local.signal
    const deadline = clock.after(90_000, () => local.abort())
    worker = (async (): Promise<ScanResult> => {
      let newCount = 0; let candidateCount = 0
      try {
        setState({ status: 'scanning', lastAttemptAtMs: clock.nowMs(), error: undefined })
        if (!options.privacy) { setState({ status: 'failed', error: { code: 'privacy-unavailable', retryable: false } }); return { ok: false, source: source.source, error: 'privacy-unavailable' } }
        const batch = await source.readUnseen(combined)
        if (!Number.isSafeInteger(batch.unseenCount) || batch.unseenCount < batch.messages.length) throw new Error('MAIL_SOURCE_INVALID')
        let failure: PublicErrorCode | undefined = (batch.skipped ?? 0) > 0 ? 'invalid-command' : undefined
        for (const mail of batch.messages.slice(0, 30)) {
          combined.throwIfAborted()
          try {
          const sourceKey = digest(JSON.stringify([store.scope.userId, store.scope.characterId, source.source, '桃子', mail.uidValidity, mail.uid]))
          const hash = mailContentHash(mail); const processed = repository.view().processed.find((entry) => entry.sourceKey === sourceKey)
          if (processed) { if (processed.contentHash !== hash) throw new Error('MAIL_SOURCE_CHANGED'); registerAttachments(mail, sourceKey, processed.candidateId); continue }
          const extraction = await extractMail(mail, options.privacy, clock, combined)
          combined.throwIfAborted()
          if (!extraction.ok) { failure = extraction.error; continue }
          const checked = extraction.value
          let evidenceRef: string
          try { evidenceRef = vault.put(sourceKey, mail, checked?.quotes ?? []) }
          catch { options.failed?.(); throw new CampusStorageFailure() }
          if (!checked) { repository.append({ type: 'mail/processed', sourceKey, contentHash: hash, evidenceRef, result: 'notice' }); registerAttachments(mail, sourceKey); newCount++; continue }
          const candidateId = 'c:' + digest(JSON.stringify([store.scope.userId, store.scope.characterId, source.source, mail.senderAddress.trim().toLowerCase(), checked.sourceRole, checked.title]))
          const previous = repository.view().items.find((item) => item.current.id === candidateId)
          const roleLabel = { 'teaching-assistant': '课程助教', 'student-club': '社团活动', library: '图书馆', other: '校园信息' }[checked.sourceRole]
          const content = { kind: checked.kind, title: checked.title, deadlineIso: checked.deadlineIso, ...(checked.eventStartIso ? { eventStartIso: checked.eventStartIso } : {}),
            ...(checked.eventEndIso ? { eventEndIso: checked.eventEndIso } : {}), ...(checked.locationText ? { locationText: checked.locationText } : {}), ...(checked.urgency ? { urgency: checked.urgency } : {}), sourceLabel: roleLabel + ' · ' + checked.title }
          const keys = ['kind', 'title', 'deadlineIso', 'eventStartIso', 'eventEndIso', 'locationText', 'sourceLabel', 'urgency'] as const
          const same = previous && keys.every((key) => previous.current[key] === content[key])
          let candidate = previous?.current
          if (!same) {
            const accepted = previous?.accepted
            candidate = candidateSchema.parse({ ...content, id: candidateId, revision: (previous?.current.revision ?? 0) + 1, source: source.source, createdAtMs: clock.nowMs(),
              status: accepted ? 'changed' : 'candidate', plannedCompletionIso: previous?.current.plannedCompletionIso ?? null, evidenceRef,
              ...(accepted ? { change: { previousDeadlineIso: accepted.deadlineIso, ...(accepted.eventStartIso ? { previousEventStartIso: accepted.eventStartIso } : {}), previousEvidenceRef: accepted.evidenceRef } } : {}) })
            repository.append({ type: 'campus/proposed', candidate, calendarUid: previous?.calendarUid ?? randomUUID() }); candidateCount++
          }
          const facts = mailFactsSchema.parse({ ...content, candidateId, revision: candidate!.revision, source: source.source, trust: 'untrusted' })
          repository.append({ type: 'mail/processed', sourceKey, contentHash: hash, evidenceRef, result: 'candidate', candidateId, facts }); newCount++
          registerAttachments(mail, sourceKey, candidateId)
          publish()
          } catch (cause) {
            if (cause instanceof CampusStorageFailure || combined.aborted) throw cause
            failure = failure ?? 'invalid-command'
          }
        }
        setState({ status: failure ? 'failed' : 'ready', unseenCount: batch.unseenCount, ...(failure ? { error: { code: failure, retryable: true } } : { lastSuccessAtMs: clock.nowMs(), error: undefined }) })
        flush()
        return { ok: !failure, source: source.source, newCount, candidateCount, ...(failure ? { error: failure } : {}) }
      } catch (cause) {
        if (cause instanceof CampusStorageFailure) return { ok: false, source: source.source, error: 'internal' }
        const error: PublicErrorCode = combined.aborted ? 'unavailable' : 'connection-failed'
        setState({ status: 'failed', error: { code: error, retryable: true } }); return { ok: false, source: source.source, error }
      }
    })().finally(() => { deadline(); worker = undefined; abort = undefined })
    return worker
  }
  const exportPending = () => {
    if (!options.artifacts || disposed || store.projection().lightsOut) return
    for (const item of repository.view().items.filter((entry) => entry.current.status === 'confirmed' && entry.accepted && entry.accepted.revision !== entry.exportedRevision).slice(0, 100)) {
      const candidate = item.accepted!
      const specs = (['ics', 'md'] as const).map((format) => ({ candidateId: candidate.id, revision: candidate.revision, format,
        displayName: candidate.title + '.' + format, source: candidate.source, createdAtMs: item.acceptedAtMs! }))
      let files
      try {
        const content = exportCampusItem(item, clock)
        files = specs.map((spec) => options.artifacts!.write({ ...spec, content: content[spec.format] }))
      } catch {
        repository.append({ type: 'campus/export-failed', candidateId: candidate.id, revision: candidate.revision, deliveries: specs.map((spec) => ({ ...options.artifacts!.describe(spec), status: 'failed' as const })) })
        publish(); continue
      }
      repository.append({ type: 'campus/exported', candidateId: candidate.id, revision: candidate.revision, sequence: item.sequence, artifacts: files })
      publish()
    }
  }
  scheduler.schedule('mail.outbox', clock.nowMs() + 1000, flush, { everyMs: 1000 })
  return { view, repository, scanNow,
    candidates: () => repository.view().items.map((item) => item.current),
    deliveries: () => [...repository.view().artifacts.map((entry) => entry.view), ...repository.view().deliveryFailures],
    privacyStatus: () => !options.privacy ? 'unconfigured' as const : mailbox.error?.code.startsWith('privacy-') ? 'failed' as const : 'ready' as const,
    setEnabled: (value: boolean) => { enabled = value; if (!enabled) { abort?.abort(); scheduler.cancel('mail.scan') } publish() },
    stateChanged: () => { if (store.projection().lightsOut) abort?.abort(); else flush() },
    dispatch: (command: AppCommand): PublicErrorCode | undefined => {
      if (command.type === 'campus.export') {
        if (!options.artifacts || disposed || store.projection().lightsOut) return 'unavailable'
        scheduler.schedule('campus.export', clock.nowMs(), exportPending); return
      }
      if (command.type === 'artifact.open') {
        const artifact = repository.view().artifacts.find((entry) => entry.view.artifactId === command.artifactId)
        if (!artifact || !options.artifacts || !options.openArtifact) return 'unavailable'
        try { options.openArtifact(artifact.view, options.artifacts.read(artifact)); return } catch { return 'export-failed' }
      }
      if (command.type === 'candidate.confirm' || command.type === 'candidate.ignore') {
        const item = repository.view().items.find((item) => item.current.id === command.candidateId)
        if (!item || command.expectedRevision !== item.current.revision) return 'stale-candidate'
        if (command.type === 'candidate.ignore') {
          if (item.current.status === 'ignored') return
          if (item.current.status === 'confirmed') return 'invalid-command'
          repository.append({ type: 'campus/ignored', candidateId: command.candidateId, revision: item.current.revision, requestId: command.requestId, commandHash: commandHash(command) })
        } else {
          if (item.current.status === 'confirmed') return
          if (item.current.status === 'ignored') return 'invalid-command'
          try { vault.read(item.current.evidenceRef, store.scope) } catch { return 'evidence-unavailable' }
          const planned = command.plannedCompletionIso === undefined ? item.current.plannedCompletionIso : command.plannedCompletionIso
          if (planned !== null && (!Number.isFinite(clock.parse(planned)) || clock.parse(planned) < 0)) return 'invalid-command'
          repository.append({ type: 'campus/confirmed', candidateId: command.candidateId, revision: item.current.revision,
            plannedCompletionIso: planned, requestId: command.requestId, commandHash: commandHash(command) })
        }
        publish(); return
      }
      if (command.type === 'mail.scan') {
        if (!enabled || store.projection().lightsOut) return 'unavailable'
        if (source.blocked) return 'source-blocked'
        if (!worker) scheduler.schedule('mail.scan', clock.nowMs(), () => { void scanNow().catch(() => options.failed?.()) })
        return
      }
      if (command.type === 'developer.mailbox') {
        if (!options.development) return 'permission-denied'
        if (worker) return 'unavailable'
        options.development.select(command.scenarioId); setState({ status: 'idle', error: undefined, unseenCount: null }); return
      }
      return 'unavailable'
    },
    flush, exportPending, idle: async () => { await worker },
    close: async () => { disposed = true; abort?.abort(); scheduler.cancel('mail.scan'); scheduler.cancel('mail.outbox'); scheduler.cancel('campus.export'); await worker },
  }
}
export type CampusService = ReturnType<typeof createCampusService>
