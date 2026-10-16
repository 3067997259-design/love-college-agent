import { join } from 'node:path'
import { writeFileSync } from 'node:fs'
import type { AppCommand } from '../../shared'
import { systemClock as clock } from '../clock'
import { openSessionStore } from '../store/session'
import { openSettings } from '../config/settings'
import { createScheduler } from '../scheduler'
import { createArtifactStore } from '../artifacts/store'
import { openDocumentVault } from '../documents/vault'
import { createDocumentService } from '../documents/service'
import { createFakeDocumentModel } from '../documents/privacy'
import { documentFixture } from '../documents/fixtures'

export async function probeDocuments(root: string) {
  const owner = { userId: 'document-probe-user', characterId: 'document-probe-character' }
  const open = () => {
    const store = openSessionStore(root, owner, clock); const settings = openSettings(root); const scheduler = createScheduler(clock)
    const vault = openDocumentVault(root, owner); const artifacts = createArtifactStore(root, owner); const fake = createFakeDocumentModel(clock); const emitted: string[] = []
    const documents = createDocumentService({ clock, store, settings, scheduler, vault, artifacts, model: fake.model, development: fake, changed: () => {}, emit: (_id, text) => { emitted.push(text) } })
    let closed = false
    return { documents, store, settings, vault, artifacts, fake, emitted, close: async () => { if (closed) return; closed = true; await documents.close(); scheduler.dispose(); vault.close(); store.close() } }
  }
  let current = open()
  const dispatch = (input: Record<string, unknown>) => current.documents.dispatch({ ...input, protocolVersion: 1, epoch: 'probe', requestId: String(current.store.records().length) } as AppCommand)
  try {
    const fixture = documentFixture('assignment-pdf'); const id = current.documents.stage(fixture.bytes, fixture.format, 'drop')
    if (current.documents.view().jobs[0].status !== 'staged' || current.documents.deliveries().length) throw new Error('DOCUMENT_PRIVACY_GATE_FAILED')
    if (dispatch({ type: 'privacy.set', enabled: true })) throw new Error('DOCUMENT_ENABLE_FAILED')
    await current.documents.runNext()
    const ready = current.documents.view().jobs.find((job) => job.id === id)!
    if (ready.status !== 'ready' || ready.pageCount !== 1 || ready.deadlineIso !== '2026-10-24T23:59:00+08:00') throw new Error('DOCUMENT_PDF_FAILED')
    const completed = current.store.records().find((row) => row.type === 'document/completed')!
    if (completed.type !== 'document/completed') throw new Error('DOCUMENT_RECORD_FAILED')
    const output = current.artifacts.read(completed.artifact)
    if (!output.includes('RAW_ONLY_ATTACHMENT_PDF') || !output.includes('USER_ONLY_DOCUMENT_RESULT') || output.includes('sk-synthetic')) throw new Error('DOCUMENT_PRIVATE_FILE_FAILED')
    const publicData = JSON.stringify([current.documents.view(), current.documents.deliveries(), current.store.records(), current.emitted])
    if (/RAW_ONLY_|USER_ONLY_DOCUMENT_RESULT|sk-synthetic/.test(publicData)) throw new Error('DOCUMENT_SOURCE_LEAK')
    if (current.documents.stage(fixture.bytes, fixture.format, 'drop') !== id || current.documents.view().jobs.length !== 1) throw new Error('DOCUMENT_DEDUP_FAILED')
    for (const fixtureId of ['malformed-pdf', 'scanned-pdf'] as const) {
      dispatch({ type: 'developer.document.import', fixtureId }); await current.documents.runNext()
      if (current.documents.view().jobs.at(-1)?.error?.code !== 'document-parse-failed') throw new Error('DOCUMENT_PARSE_FAILURE_FAILED')
    }
    for (const scenario of ['privacy-failure', 'malicious'] as const) {
      dispatch({ type: 'developer.documents', scenarioId: scenario })
      current.documents.stage(Buffer.from('PRIVATE_FAULT_' + scenario), 'text', 'drop'); await current.documents.runNext()
      if (current.documents.view().jobs.at(-1)?.error?.code !== (scenario === 'privacy-failure' ? 'privacy-unavailable' : 'privacy-invalid-output')) throw new Error('DOCUMENT_FILTER_FAILURE_FAILED')
    }
    const path = join(root, 'synthetic-drop.txt'); writeFileSync(path, 'PRIVATE_DROP_PROBE\nsynthetic user file')
    if (current.documents.importPaths([path]).acceptedIds.length !== 1 || current.documents.importPaths([join(root, 'providers.json')]).error?.code !== 'unsupported-file') throw new Error('DOCUMENT_IMPORT_FAILED')
    const oldCount = current.documents.deliveries().length
    await current.close(); current = open()
    if (!current.documents.filteringEnabled() || current.documents.deliveries().length !== oldCount || current.documents.view().jobs.find((job) => job.id === id)?.status !== 'ready') throw new Error('DOCUMENT_RESTART_FAILED')
    const other = openDocumentVault(root, { ...owner, characterId: 'other' })
    try { const ref = current.store.records().find((row) => row.type === 'document/job' && row.job.sourceRef); let denied = false
      try { if (ref?.type === 'document/job') other.read(ref.job.sourceRef!); else throw new Error('MISSING_REF') } catch { denied = true }
      if (!denied) throw new Error('DOCUMENT_SCOPE_FAILED')
    } finally { other.close() }
    return { ok: true, probe: 'documents', source: 'fake', actualPdfWorker: true, privateSqliteSource: true, actualMarkdownFile: true, privacyPersisted: true,
      metadataOnlyJournalAndEvents: true, credentialsRedacted: true, invalidPdfRejected: true, noTextLayerRejected: true, filterFailureClosed: true, restartPreserved: true, scopeIsolated: true, realImapNotAttempted: true }
  } finally { await current.close() }
}
