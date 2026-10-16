import Database from 'better-sqlite3'
import JSZip from 'jszip'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { createManualClock } from '../clock'
import { openSessionStore } from '../store/session'
import { openMemoryRepository } from '../memory/repository'
import { openEvidenceVault } from '../mail/evidence-vault'
import { openDocumentVault } from '../documents/vault'
import { exportPrivateSave, stagePrivateSave, validatePrivateSave } from '../backup/archive'
import { applyPendingRestore, queueRestore } from '../backup/restore'
import { journalLocation } from '../journal/file'

export async function probeBackup(root: string) {
  const clock = createManualClock(0); clock.advanceBy(clock.parse('2026-10-16T20:00:00+08:00'))
  const owner = { userId: 'local-user', characterId: 'default-character' }
  const store = openSessionStore(root, owner, clock); const memory = openMemoryRepository(root, store); const evidence = openEvidenceVault(root, owner); const documents = openDocumentVault(root, owner)
  let stage = 0
  try {
    store.append({ type: 'user/message', id: 'saved-message', text: 'SYNTHETIC_SAVED_EXPERIENCE', requestId: 'saved-message', commandHash: 'probe' })
    const sourceRef = documents.put(new Uint8Array(Buffer.from('SYNTHETIC_PRIVATE_DOCUMENT')), 'text')
    const privateRef = evidence.put('synthetic', { uidValidity: '1', uid: 1, senderAddress: 'fixture@example.invalid', senderName: 'SYNTHETIC_SENDER', subject: 'SYNTHETIC_SUBJECT', body: 'RAW_ONLY_SAVED_MAIL', sentAtMs: clock.nowMs(), receivedAtMs: clock.nowMs() }, [])
    mkdirSync(join(root, 'connections'), { recursive: true }); writeFileSync(join(root, 'connections/mcp.json'), 'APPLICATION_CONFIGURATION_CANARY')
    mkdirSync(join(root, 'secrets'), { recursive: true }); writeFileSync(join(root, 'secrets/providers.json'), 'APPLICATION_CREDENTIAL_CANARY')
    const otherOwner = { ...owner, userId: 'other-user' }; const otherStore = openSessionStore(root, otherOwner, clock)
    otherStore.append({ type: 'user/message', id: 'other', text: 'OTHER_USER_MUST_NOT_EXPORT', requestId: 'other', commandHash: 'probe' }); otherStore.close()
    const saved = await exportPrivateSave({ root, store, clock, source: 'fake', fileFilteringEnabled: true, credentials: ['APPLICATION_CREDENTIAL_CANARY'] }); stage = 1
    const validated = await validatePrivateSave(saved.bytes, owner, 'fake')
    if (validated.files.size !== 5 || [...validated.files.keys()].some((name) => /secrets|connections|settings|debug/.test(name))) throw new Error('SAVE_WHITELIST_FAILED')
    if ([...validated.files.values()].some((bytes) => bytes.includes(Buffer.from('OTHER_USER_MUST_NOT_EXPORT')))) throw new Error('SAVE_OTHER_OWNER_EXPORTED')
    const differentOwner = { ...owner, characterId: 'other' }
    if (!(await validatePrivateSave(saved.bytes, differentOwner, 'fake').then(() => false, () => true))) throw new Error('SAVE_SCOPE_FAILED')
    const bad = await JSZip.loadAsync(saved.bytes); bad.file('manifest.json', (await bad.file('manifest.json')!.async('string')).replace('SYNTHETIC_NEVER', 'INVALID'))
    const first = saved.manifest.files[0]; bad.file(first.path, 'tampered', { createFolders: false })
    if (!(await validatePrivateSave(await bad.generateAsync({ type: 'nodebuffer' }), owner, 'fake').then(() => false, () => true))) throw new Error('SAVE_HASH_FAILED')
    const staged = await stagePrivateSave(root, saved.bytes, owner, 'fake'); stage = 2
    store.append({ type: 'user/message', id: 'after-save', text: 'AFTER_SAVE_SHOULD_BE_REWOUND', requestId: 'after-save', commandHash: 'probe' })
    const safety = await exportPrivateSave({ root, store, clock, source: 'fake', fileFilteringEnabled: false }); writeFileSync(join(root, 'safety.lca-save'), safety.bytes)
    const otherDocuments = openDocumentVault(root, otherOwner); const otherRef = otherDocuments.put(new Uint8Array(Buffer.from('OTHER_USER_AFTER_SAVE')), 'text'); otherDocuments.close()
    memory.close(); evidence.close(); documents.close(); store.close()
    const oldBytes = readFileSync(join(journalLocation(root, owner, clock).folder, '2026-10-16.jsonl'))
    queueRestore(root, staged.restoreId, safety.manifest.archiveId); clock.advanceBy(24 * 60 * 60_000)
    const applied = applyPendingRestore(root, owner, 'fake', clock)
    if (applied?.status !== 'restored') throw new Error('SAVE_RESTORE_FAILED'); stage = 3
    const nextStore = openSessionStore(root, owner, clock); const nextDocuments = openDocumentVault(root, owner); const nextEvidence = openEvidenceVault(root, owner)
    try {
      if (JSON.stringify(nextStore.history?.()).includes('AFTER_SAVE_SHOULD_BE_REWOUND') || !JSON.stringify(nextStore.history?.()).includes('SYNTHETIC_SAVED_EXPERIENCE')) throw new Error('SAVE_CHAT_FAILED')
      if (Buffer.from(nextDocuments.read(sourceRef).bytes).toString() !== 'SYNTHETIC_PRIVATE_DOCUMENT' || nextEvidence.read(privateRef, nextStore.scope).excerpt !== 'RAW_ONLY_SAVED_MAIL') throw new Error('SAVE_PRIVATE_RESTORE_FAILED')
      const oldDb = new Database(join(root, '.backup-staging', staged.restoreId, 'rollback', 'documents.sqlite'), { readonly: true }); oldDb.close()
    } finally { nextStore.close(); nextDocuments.close(); nextEvidence.close() }
    const otherRestored = openDocumentVault(root, otherOwner)
    try { if (Buffer.from(otherRestored.read(otherRef).bytes).toString() !== 'OTHER_USER_AFTER_SAVE') throw new Error('SAVE_OTHER_USER_REWOUND') } finally { otherRestored.close() }
    if (!readFileSync(join(root, '.backup-staging', staged.restoreId, 'rollback', 'journals', journalLocation(root, owner, clock).folder.split(/[\\/]/).at(-1)!, '2026-10-16.jsonl')).equals(oldBytes)) throw new Error('SAVE_ROLLBACK_LOST')
    stage = 4
    // Simulate interruption after a directory move, before commit. Next boot must roll back, never accept a partial restore.
    const interrupted = await stagePrivateSave(root, saved.bytes, owner, 'fake'); queueRestore(root, interrupted.restoreId, randomUUID())
    const relativeJournal = saved.manifest.files[0].path.split('/').slice(0, 2).join('/'); const rollback = join(interrupted.stage, 'rollback', relativeJournal)
    mkdirSync(join(rollback, '..'), { recursive: true }); renameSync(join(root, relativeJournal), rollback)
    const targets = [relativeJournal, 'projections.sqlite', 'campus.sqlite', 'documents.sqlite', 'memory.sqlite', ...['projections.sqlite', 'campus.sqlite', 'documents.sqlite', 'memory.sqlite'].flatMap((name) => [name + '-wal', name + '-shm'])]
    writeFileSync(join(interrupted.stage, 'transaction.json'), JSON.stringify({ phase: 'applying', targets, previous: targets.filter((name) => name === relativeJournal || existsSync(join(root, name))) }))
    const rejected = applyPendingRestore(root, owner, 'fake', clock)
    if (rejected?.status !== 'failed' || !existsSync(join(root, relativeJournal))) throw new Error('SAVE_CRASH_RECOVERY_FAILED')
    const credentialStore = openSessionStore(root, owner, clock); const credentialVault = openDocumentVault(root, owner)
    try {
      credentialVault.put(new Uint8Array(Buffer.from('APPLICATION_CREDENTIAL_CANARY')), 'text')
      if (!(await exportPrivateSave({ root, store: credentialStore, clock, source: 'fake', fileFilteringEnabled: false, credentials: ['APPLICATION_CREDENTIAL_CANARY'] }).then(() => false, () => true))) throw new Error('SAVE_EMBEDDED_CREDENTIAL_EXPORTED')
    } finally { credentialVault.close(); credentialStore.close() }
    return { ok: true, probe: 'backup', sqliteBackupApi: true, privateSourcesPreserved: true, applicationSecretsExcluded: true, embeddedKnownCredentialRefused: true, manifestHashesChecked: true, scopeChecked: true, otherUserPreserved: true, actualRestore: true, preRestoreDataPreserved: true, interruptedRestoreRolledBack: true }
  } catch { return { ok: false, probe: 'backup', stage } }
  finally { try { memory.close(); evidence.close(); documents.close(); store.close() } catch { /* Probe may have closed all handles before replacement. */ } }
}
