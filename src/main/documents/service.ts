import { createHash } from 'node:crypto'
import { closeSync, fstatSync, lstatSync, openSync, readSync, realpathSync } from 'node:fs'
import { extname, isAbsolute } from 'node:path'
import type { AppCommand, DeliveryView, DocumentFormat, DocumentsView, DocumentView, FileImportAck, PublicErrorCode } from '../../shared'
import type { Clock } from '../clock'
import type { SessionStore } from '../store/session'
import type { Scheduler } from '../scheduler'
import type { SettingsStore } from '../config/settings'
import type { ArtifactStore } from '../artifacts/store'
import type { JournalInput } from '../journal/schema'
import { projectDocuments } from './projection'
import { attachmentRecordSchema, documentFactsSchema, documentJobSchema, type AttachmentRecord, type DocumentJob } from './schema'
import { MAX_FILE_BYTES, DocumentFailure, extractDocument } from './reader'
import { organizeDocument, type DocumentPrivacyModel, type createFakeDocumentModel } from './privacy'
import type { DocumentVault } from './vault'
import { documentFixture } from './fixtures'

const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const suffix = { pdf: 'pdf', text: 'txt', markdown: 'md' }
const failureCode = (cause: unknown): PublicErrorCode => cause instanceof DocumentFailure ? cause.code : 'internal'
export function createDocumentService(options: { clock: Clock; store: SessionStore; scheduler: Scheduler; settings: SettingsStore; vault: DocumentVault; artifacts: ArtifactStore;
  model: DocumentPrivacyModel | null; development?: ReturnType<typeof createFakeDocumentModel>; readAttachment?(attachment: AttachmentRecord, signal: AbortSignal): Promise<Uint8Array>;
  openArtifact?(view: DeliveryView, text: string): void; changed(): void; emit(id: string, text: string): void; failed?(): void;
}) {
  const { clock, store, scheduler, settings, vault, artifacts } = options
  const records = () => store.history?.() ?? store.records()
  let state = projectDocuments(records()); let disposed = false; let pluginEnabled = true
  let active: { id: string; abort: AbortController } | undefined; let worker: Promise<void> | undefined
  const enabled = () => settings.read().fileFilteringEnabled
  const canRun = () => !disposed && pluginEnabled && enabled() && !!options.model?.ready && !store.projection().lightsOut
  const append = (row: JournalInput) => {
    try { store.append(row); state = projectDocuments(records()) }
    catch { options.failed?.(); throw new DocumentFailure('internal') }
    options.changed()
  }
  const update = (job: DocumentJob, patch: Partial<DocumentView>, attempt = job.attempt) => {
    const view = { ...job.view, ...patch, updatedAtMs: clock.nowMs() }; if (!patch.error) delete view.error
    append({ type: 'document/job', job: documentJobSchema.parse({ ...job, view, attempt }) })
  }
  const flush = () => {
    if (disposed || !pluginEnabled || store.projection().lightsOut) return
    const consumed = new Set(records().flatMap((row) => row.type === 'inbox/drain' || row.type === 'inbox/drop' ? row.ids : []))
    for (const item of state.completed) { const id = `document:${item.documentId}:${item.attempt}`; if (!consumed.has(id)) options.emit(id, JSON.stringify(item.facts)) }
  }
  const schedule = () => {
    if (canRun() && !worker && state.jobs.some((job) => job.view.status === 'queued')) scheduler.schedule('documents.work', clock.nowMs(), () => { void runNext().catch(() => options.failed?.()) })
  }
  const runNext = async () => {
    if (worker) return worker
    if (!canRun()) return
    const job = state.jobs.find((job) => job.view.status === 'queued'); if (!job) return
    const operation = { id: job.view.id, abort: new AbortController() }; active = operation
    const signal = operation.abort.signal
    let timedOut = false
    const cancelDeadline = clock.after(90_000, () => { timedOut = true; operation.abort.abort() })
    worker = (async () => {
      try {
        update(job, { status: 'processing' }, job.attempt + 1)
        let sourceRef = job.sourceRef
        if (!sourceRef) {
          const attachment = state.attachments.find((entry) => entry.view.id === job.attachmentId)
          if (!attachment || !options.readAttachment) throw new DocumentFailure('file-unreadable')
          let remove = () => {}
          let bytes: Uint8Array
          try {
            const stopped = new Promise<never>((_resolve, reject) => { const listener = () => reject(new DocumentFailure('unavailable')); signal.addEventListener('abort', listener, { once: true }); remove = () => signal.removeEventListener('abort', listener); if (signal.aborted) listener() })
            bytes = await Promise.race([options.readAttachment(attachment, signal), stopped])
          } finally { remove() }
          signal.throwIfAborted()
          if (bytes.length !== attachment.view.byteLength) throw new DocumentFailure('file-unreadable')
          sourceRef = vault.put(bytes, attachment.view.format)
          append({ type: 'document/job', job: { ...state.jobs.find((item) => item.view.id === job.view.id)!, sourceRef } })
        }
        const input = vault.read(sourceRef)
        const parsed = await extractDocument(input.bytes, input.format, clock, signal)
        signal.throwIfAborted()
        const output = await organizeDocument({ ...parsed, format: input.format }, options.model, clock, signal)
        signal.throwIfAborted(); if (!canRun()) throw new DocumentFailure('unavailable')
        const current = state.jobs.find((item) => item.view.id === job.view.id)!
        const facts = documentFactsSchema.parse({ documentId: job.view.id, fileName: '整理-' + job.view.id.slice(-8) + '.md', format: input.format,
          pageCount: parsed.pageCount, deadlineIso: output.deadlineIso, source: options.model!.source, trust: 'untrusted' })
        let artifact
        try { artifact = artifacts.write({ candidateId: job.view.id, revision: current.attempt, format: 'md', kind: 'document', displayName: facts.fileName,
          createdAtMs: clock.nowMs(), source: options.model!.source, content: output.markdown }) }
        catch { throw new DocumentFailure('export-failed') }
        append({ type: 'document/completed', documentId: job.view.id, attempt: current.attempt, artifact, facts }); flush()
      } catch (cause) {
        const current = state.jobs.find((item) => item.view.id === job.view.id)!
        if (current.view.status === 'processing') update(current, timedOut ? { status: 'failed', error: { code: 'connection-failed', retryable: true } } : signal.aborted ? { status: 'staged' } : { status: 'failed', error: { code: failureCode(cause), retryable: true } })
      }
    })().finally(() => { cancelDeadline(); active = undefined; worker = undefined; schedule() })
    return worker
  }
  const stage = (bytes: Uint8Array, format: DocumentFormat, origin: DocumentView['origin'], attachmentId = '') => {
    if (disposed || !pluginEnabled) throw new DocumentFailure('unavailable')
    if (state.jobs.length >= 200 || state.jobs.filter((job) => ['staged', 'queued', 'processing'].includes(job.view.status)).length >= 20) throw new DocumentFailure('budget-exceeded')
    let sourceRef: string
    try { sourceRef = vault.put(bytes, format) } catch (cause) { if (cause instanceof DocumentFailure) throw cause; options.failed?.(); throw new DocumentFailure('internal') }
    const id = 'doc:' + hash(JSON.stringify([store.scope.userId, store.scope.characterId, sourceRef, origin, attachmentId]))
    if (state.jobs.some((job) => job.view.id === id)) return id
    append({ type: 'document/job', job: { sourceRef, attempt: 0, view: { id, displayName: '资料-' + id.slice(-8) + '.' + suffix[format], format,
      origin, source: options.model?.source ?? 'real', byteLength: bytes.length, createdAtMs: clock.nowMs(), updatedAtMs: clock.nowMs(),
      status: enabled() ? 'queued' : 'staged', pageCount: null, deadlineIso: null } } })
    schedule(); return id
  }
  const importPaths = (paths: readonly string[]): FileImportAck => {
    const acceptedIds: string[] = []; let error: PublicErrorCode | undefined; let rejectedCount = 0
    for (const path of paths) {
      let fd: number | undefined
      try {
        if (!isAbsolute(path) || /^(?:\\\\|\/\/)|:\/\//.test(path)) throw new DocumentFailure('permission-denied')
        const format = ({ '.pdf': 'pdf', '.txt': 'text', '.md': 'markdown' } as Record<string, DocumentFormat>)[extname(path).toLowerCase()]
        if (!format) throw new DocumentFailure('unsupported-file')
        const before = lstatSync(path)
        if (!before.isFile() || before.isSymbolicLink()) throw new DocumentFailure('file-unreadable')
        if (!before.size || before.size > MAX_FILE_BYTES) throw new DocumentFailure('file-too-large')
        const canonical = realpathSync(path); fd = openSync(canonical, 'r'); const opened = fstatSync(fd)
        if (!opened.isFile() || opened.size !== before.size || opened.ino !== before.ino) throw new DocumentFailure('file-unreadable')
        const bytes = Buffer.alloc(opened.size); let offset = 0
        while (offset < bytes.length) { const count = readSync(fd, bytes, offset, bytes.length - offset, offset); if (!count) break; offset += count }
        const after = fstatSync(fd)
        if (offset !== bytes.length || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs) throw new DocumentFailure('file-unreadable')
        acceptedIds.push(stage(bytes, format, 'drop'))
      } catch (cause) { error = cause instanceof DocumentFailure ? cause.code : 'file-unreadable'; rejectedCount++ }
      finally { if (fd !== undefined) closeSync(fd) }
    }
    return { acceptedIds, rejectedCount, ...(error ? { error: { code: error, retryable: false } } : {}) }
  }
  const pause = () => {
    active?.abort.abort(); scheduler.cancel('documents.work')
    for (const job of state.jobs.filter((job) => job.view.status === 'queued' || job.view.status === 'processing')) update(job, { status: 'staged' })
  }
  const resume = () => { if (canRun()) { for (const job of state.jobs.filter((job) => job.view.status === 'staged')) update(job, { status: 'queued' }); schedule() } }
  // Never infer completion or silently rerun a half-completed model request after a crash.
  for (const job of state.jobs.filter((job) => job.view.status === 'processing')) update(job, { status: 'failed', error: { code: 'document-interrupted', retryable: true } })
  scheduler.schedule('documents.outbox', clock.nowMs() + 1000, flush, { everyMs: 1000 })
  resume()
  return { importPaths, stage, runNext, flush,
    view: (): DocumentsView => ({ jobs: state.jobs.map((job) => structuredClone(job.view)), attachments: state.attachments.map((entry) => structuredClone(entry.view)),
      privacyAvailable: !!options.model?.ready, ...(options.development ? { scenarioId: options.development.scenario() } : {}) }),
    filteringEnabled: enabled,
    deliveries: () => state.artifacts.map((artifact) => artifact.view),
    ownsArtifact: (id: string) => state.artifacts.some((artifact) => artifact.view.artifactId === id),
    openArtifact: (id: string): PublicErrorCode | undefined => {
      const artifact = state.artifacts.find((artifact) => artifact.view.artifactId === id)
      if (!artifact || !options.openArtifact) return 'unavailable'
      try { options.openArtifact(artifact.view, artifacts.read(artifact)) } catch { return 'export-failed' }
    },
    registerAttachment: (record: AttachmentRecord) => { const checked = attachmentRecordSchema.parse(record); if (!state.attachments.some((entry) => entry.view.id === checked.view.id)) append({ type: 'document/attachment', attachment: checked }) },
    setEnabled: (value: boolean) => { pluginEnabled = value; if (!value) pause(); else resume(); options.changed() },
    stateChanged: () => { if (store.projection().lightsOut) pause(); else resume(); flush() },
    dispatch: (command: AppCommand): PublicErrorCode | undefined => {
      if (command.type === 'privacy.set') {
        if (command.enabled && !options.model?.ready) return 'privacy-unavailable'
        settings.update((draft) => { draft.fileFilteringEnabled = command.enabled })
        if (command.enabled) resume(); else pause(); options.changed(); return
      }
      if (command.type === 'developer.documents') {
        if (!options.development) return 'permission-denied'
        if (active) return 'unavailable'
        options.development.select(command.scenarioId); options.changed(); return
      }
      if (command.type === 'developer.document.import') {
        if (!options.development) return 'permission-denied'
        const fixture = documentFixture(command.fixtureId); stage(fixture.bytes, fixture.format, 'drop'); return
      }
      if (command.type === 'document.attachment') {
        if (!pluginEnabled || disposed || store.projection().lightsOut) return 'unavailable'
        const record = state.attachments.find((item) => item.view.id === command.attachmentId)
        if (!record || !options.readAttachment) return 'unavailable'
        const id = 'doc:' + hash(JSON.stringify([store.scope.userId, store.scope.characterId, record.view.id]))
        if (state.jobs.some((job) => job.view.id === id)) return
        if (state.jobs.length >= 200 || state.jobs.filter((job) => ['staged', 'queued', 'processing'].includes(job.view.status)).length >= 20) return 'budget-exceeded'
        append({ type: 'document/job', job: { sourceRef: null, attachmentId: record.view.id, attempt: 0, view: { id, displayName: '资料-' + id.slice(-8) + '.' + suffix[record.view.format],
          origin: 'mail-attachment', format: record.view.format, byteLength: record.view.byteLength, source: record.view.source, createdAtMs: clock.nowMs(), updatedAtMs: clock.nowMs(), status: enabled() ? 'queued' : 'staged', pageCount: null, deadlineIso: null } } })
        schedule(); return
      }
      if (command.type === 'document.retry' || command.type === 'document.cancel') {
        const job = state.jobs.find((job) => job.view.id === command.documentId); if (!job || job.view.status === 'ready') return 'invalid-command'
        if (command.type === 'document.cancel') { if (active?.id === job.view.id) active.abort.abort(); update(job, { status: 'cancelled' }) }
        else { if (active?.id === job.view.id) return 'unavailable'; update(job, { status: enabled() ? 'queued' : 'staged' }); schedule() }
        return
      }
      return 'unavailable'
    },
    idle: async () => { await worker },
    close: async () => { disposed = true; active?.abort.abort(); scheduler.cancel('documents.work'); scheduler.cancel('documents.outbox'); await worker },
  }
}
export type DocumentService = ReturnType<typeof createDocumentService>
