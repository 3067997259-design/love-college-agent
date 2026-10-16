import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AppCommand, DocumentFormat } from '../../src/shared'
import { createManualClock } from '../../src/main/clock'
import { openJournal } from '../../src/main/journal/file'
import { projectJournal } from '../../src/main/journal/projection'
import type { SessionStore } from '../../src/main/store/session'
import { createScheduler } from '../../src/main/scheduler'
import { openSettings } from '../../src/main/config/settings'
import { createArtifactStore } from '../../src/main/artifacts/store'
import { createDocumentService } from '../../src/main/documents/service'
import { createFakeDocumentModel, type DocumentPrivacyModel } from '../../src/main/documents/privacy'
import type { DocumentVault } from '../../src/main/documents/vault'
import { createAppController } from '../../src/main/bridge/controller'

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn() })
function fixture(model?: DocumentPrivacyModel | null) {
  const root = mkdtempSync(join(tmpdir(), 'lca-document-'))
  cleanup.push(async () => { if (!resolve(root).startsWith(join(resolve(tmpdir()), 'lca-document-'))) throw new Error('Unsafe cleanup'); rmSync(root, { recursive: true, force: true }) })
  const clock = createManualClock(1000); const journal = openJournal(root, { userId: 'u', characterId: 'c' }, clock)
  const store: SessionStore = { scope: journal.scope, records: journal.records, projection: () => projectJournal(journal.records()), append: journal.append, close: journal.close }
  const settings = openSettings(root); const scheduler = createScheduler(clock); const artifacts = createArtifactStore(root, store.scope)
  const raw = new Map<string, { bytes: Uint8Array; format: DocumentFormat }>()
  const vault: DocumentVault = { put: (bytes, format) => { const ref = 'f:' + createHash('sha256').update(bytes).update(format).digest('hex'); raw.set(ref, { bytes, format }); return ref }, read: (ref) => { const result = raw.get(ref); if (!result) throw new Error('PRIVATE_VAULT_ERROR'); return result }, close: () => {} }
  const fake = createFakeDocumentModel(clock); const emitted: string[] = []; const readAttachment = vi.fn(async () => Buffer.from('PRIVATE_ATTACHMENT_TEXT'))
  const documents = createDocumentService({ clock, store, scheduler, settings, vault, artifacts, model: model === undefined ? fake.model : model, development: fake,
    readAttachment, changed: () => {}, emit: (_id, text) => { emitted.push(text) } })
  cleanup.push(async () => { await documents.close(); scheduler.dispose(); store.close() })
  const command = (body: Record<string, unknown>) => ({ ...body, protocolVersion: 1, epoch: 'test', requestId: String(store.records().length) } as AppCommand)
  return { root, clock, store, settings, fake, documents, artifacts, raw, emitted, command, readAttachment }
}
describe('document task ownership and privacy gate', () => {
  it('stages while off, persists the setting, publishes only metadata and delivers a real private file', async () => {
    const f = fixture(); const id = f.documents.stage(Buffer.from('PRIVATE_SOURCE_DOCUMENT\n2026-10-24 23:59'), 'text', 'drop')
    await f.documents.runNext(); expect(f.documents.view().jobs[0].status).toBe('staged')
    f.documents.dispatch(f.command({ type: 'privacy.set', enabled: true })); await f.documents.runNext()
    expect(openSettings(f.root).read().fileFilteringEnabled).toBe(true)
    expect(f.documents.view().jobs[0]).toMatchObject({ id, status: 'ready', pageCount: null, deadlineIso: '2026-10-24T23:59:00+08:00' })
    const completed = f.store.records().find((row) => row.type === 'document/completed')!
    expect(completed.type).toBe('document/completed')
    if (completed.type === 'document/completed') expect(f.artifacts.read(completed.artifact)).toContain('PRIVATE_SOURCE_DOCUMENT')
    expect(JSON.stringify([f.store.records(), f.documents.view(), f.documents.deliveries(), f.emitted])).not.toContain('PRIVATE_SOURCE_DOCUMENT')
    expect(JSON.stringify(f.emitted)).not.toContain('USER_ONLY_DOCUMENT_RESULT')
  })
  it('cancels a hanging model when /privacy turns off and never commits a late result', async () => {
    const model: DocumentPrivacyModel = { source: 'fake', ready: true, organize: vi.fn(() => new Promise(() => {})) }
    const f = fixture(model); f.documents.dispatch(f.command({ type: 'privacy.set', enabled: true }))
    f.documents.stage(Buffer.from('PRIVATE_CANCELLED'), 'text', 'drop'); const pending = f.documents.runNext()
    await vi.waitFor(() => expect(model.organize).toHaveBeenCalledOnce())
    f.documents.dispatch(f.command({ type: 'privacy.set', enabled: false })); await pending
    expect(f.documents.view().jobs[0].status).toBe('staged'); expect(f.documents.deliveries()).toHaveLength(0)
  })
  it('fails closed on a missing model, isolates a fault, and retries only after an explicit request', async () => {
    const missing = fixture(null)
    expect(missing.documents.dispatch(missing.command({ type: 'privacy.set', enabled: true }))).toBe('privacy-unavailable')
    expect(missing.settings.read().fileFilteringEnabled).toBe(false)
    missing.settings.update((draft) => { draft.fileFilteringEnabled = true })
    missing.documents.stage(Buffer.from('PRIVATE_MISSING_DEPENDENCY'), 'text', 'drop')
    expect(missing.documents.view().jobs[0]).toMatchObject({ status: 'failed', error: { code: 'privacy-unavailable' } })
    const f = fixture(); f.fake.select('privacy-failure'); f.documents.dispatch(f.command({ type: 'privacy.set', enabled: true }))
    const id = f.documents.stage(Buffer.from('PRIVATE_FAULT_INPUT'), 'text', 'drop'); await f.documents.runNext()
    expect(f.documents.view().jobs[0]).toMatchObject({ status: 'failed', error: { code: 'privacy-unavailable' } }); expect(f.documents.deliveries()).toHaveLength(0)
    f.fake.select('ready'); await f.documents.runNext(); expect(f.documents.deliveries()).toHaveLength(0)
    f.documents.dispatch(f.command({ type: 'document.retry', documentId: id })); await f.documents.runNext()
    expect(f.documents.deliveries()).toHaveLength(1)
  })
  it('records attachment metadata first and reads it only after the privacy gate opens', async () => {
    const f = fixture(); f.documents.registerAttachment({ uidValidity: '1', uid: 1, partId: '2', view: { id: 'att:fixture', displayName: '附件-12345678.txt', byteLength: Buffer.byteLength('PRIVATE_ATTACHMENT_TEXT'), format: 'text', source: 'fake' } })
    f.documents.dispatch(f.command({ type: 'document.attachment', attachmentId: 'att:fixture' })); await f.documents.runNext()
    expect(f.readAttachment).not.toHaveBeenCalled()
    f.documents.dispatch(f.command({ type: 'privacy.set', enabled: true })); await f.documents.runNext()
    expect(f.readAttachment).toHaveBeenCalledOnce(); expect(f.documents.view().jobs[0].status).toBe('ready')
  })
  it('intercepts /privacy locally even without chat configuration and never forwards it to a model', () => {
    const f = fixture(); const controller = createAppController(f.clock, undefined, f.store); controller.attachDocuments(f.documents)
    const command = { ...f.command({ type: 'message.send', text: '/privacy' }), epoch: controller.getSnapshot().epoch }
    expect(controller.dispatch(command).status).toBe('accepted'); expect(f.documents.filteringEnabled()).toBe(true)
    expect(f.store.records().filter((row) => row.type === 'user/message' || row.type === 'model/attempt')).toHaveLength(0)
    expect(controller.importUserFiles({ epoch: 'stale', paths: ['D:\\anything.txt'] }).error?.code).toBe('stale-epoch')
    controller.dispose()
  })
})
