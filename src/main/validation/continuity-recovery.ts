import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createManualClock } from '../clock'
import { ensureContinuityIdentity } from '../continuity/identity'
import { exportPrivateSave, sha256, stagePrivateSave, validatePrivateSave } from '../backup/archive'
import { continuityTargets, exportContinuity, type OpenRestoreDatabase } from '../backup/continuity'
import { applyPendingRestore, queueRestore } from '../backup/restore'
import { openSessionStore } from '../store/session'
import { openMemoryRepository } from '../memory/repository'
import { openEvidenceVault } from '../mail/evidence-vault'
import { openDocumentVault } from '../documents/vault'
import { createMemoryEngine } from '../memory/engine'
import { createMemoryCommitCoordinator } from '../memory/storage/commits'
import { createMemoryRuntimeState } from '../memory/storage/state'
import { createContinuousWork, type WorkRuntimeContext } from '../work/service'
import { captureWorkFile } from '../../../dsh/lca-bridge/work-evidence.js'

/** The same nonempty scenario runs under Node and Electron's actual utility
 * host. All data, SQL, decisions and tool observations are local fixtures. */
export async function probeContinuityRecovery(root: string, openDatabase?: OpenRestoreDatabase) {
  const checks: string[] = []
  const check = (condition: unknown, name: string) => { if (!condition) throw new Error(name); checks.push(name) }
  const clock = createManualClock(1790000000000), scope = { userId: 'recovery-user', characterId: 'recovery-character' }
  ensureContinuityIdentity(root, scope)
  const initialIdentity = JSON.parse(readFileSync(join(root, 'continuity.json'), 'utf8')) as { dataRootId: string }
  initialIdentity.dataRootId = sha256('profile-before-folder-move')
  writeFileSync(join(root, 'continuity.json'), JSON.stringify(initialIdentity))
  const identity = ensureContinuityIdentity(root, scope), owner = identity.owner
  const other = ensureContinuityIdentity(root, { ...scope, characterId: 'other-character' })
  const [memoryTarget, workTarget] = continuityTargets(owner)
  const memoryRoot = join(root, memoryTarget), workRoot = join(root, workTarget)
  let held = false
  const open = openDatabase ?? (async path => (await import('../memory/storage/host')).openUtilityMemoryDatabase({ path, clock }))
  const store = openSessionStore(root, scope, clock), oldMemory = openMemoryRepository(root, store), evidence = openEvidenceVault(root, scope), documents = openDocumentVault(root, scope)
  const closeBook = () => { oldMemory.close(); evidence.close(); documents.close(); store.close() }
  const engine = createMemoryEngine({ root: memoryRoot, owner, clock, embedding: () => undefined, held: () => held, waitForRestore: async () => {}, journal: () => {}, openDatabase: open })
  const contexts: WorkRuntimeContext[] = [], delivered: string[] = [], inputs: string[] = []
  const workOptions = { root: workRoot, owner, clock, available: () => true, held: () => held, project: (id: string) => ({ id, path: root }),
    decision: (id: string) => ({ id, text: 'Original Saturday requirement', atMs: clock.nowMs() }), safeText: (text: string) => text, changed: () => {},
    deliverCheckpoint: (_work: unknown, checkpoint: { id: string }) => { delivered.push(checkpoint.id); return 'consumed' as const },
    createRuntime: (context: WorkRuntimeContext) => { contexts.push(context); return { deliver: async (input: { eventId: string }) => { inputs.push(input.eventId); context.consumed(input.eventId) },
      invalidateWork: () => {}, close: async () => {}, busy: () => false, stateChanged: () => {}, untrust: () => {}, efforts: () => {} } },
  }
  let work = createContinuousWork(workOptions)
  const tick = async () => { for (let i = 0; i < 12; i++) await Promise.resolve() }
  try {
    store.append({ type: 'user/message', id: 'saved-decision', text: 'Original Saturday requirement', requestId: 'saved-decision', commandHash: 'fixture' })
    const repository = await engine.runtime.initialize(); if (!repository) throw new Error('NATIVE_DATABASE_UNAVAILABLE')
    const sourceContext = { sessionId: store.scope.sessionId, messageId: 'saved-decision', neighbors: [] }
    const item = { scope, sessionId: store.scope.sessionId, sourceContext, memoryType: 'long_term' as const, category: 'chat', importance: 5, valence: 0, arousal: 0, tags: [], reviewStatus: 'approved' as const }
    const kept = await repository.insert({ ...item, content: 'Saturday is the current decision.' })
    const forgotten = await repository.insert({ ...item, content: 'Friday was explicitly forgotten.' })
    const vector = Array.from({ length: 768 }, (_, i) => i === 0 ? 1 : 0)
    await repository.updateEmbedding(kept.id, kept.revision ?? 1, vector, { embeddingProvider: 'fixture', embeddingModel: 'fixture-vector', embeddingDimensions: 768, embeddingInputType: 'document', embeddingSourceFingerprint: 'fixture-space', embeddedAt: clock.nowMs(), embeddingStatus: 'active' })
    await engine.runtime.proposeOperation({ scope, sessionId: store.scope.sessionId, turnId: 'forget-turn', sourceContext, isCurrent: () => true }, 'forget-before-save', { kind: 'forget', targetId: forgotten.id, expectedRevision: forgotten.revision })
    await engine.runtime.confirmOperation(scope, 'forget-before-save', true)
    engine.runtime.longTermSyncEnabled.value = true
    await engine.runtime.queueExistingLongTermMemories()
    check(engine.runtime.longTermSyncOutbox.value.length > 0, 'nonempty_original_mirror_outbox')
    const capture = createMemoryRuntimeState(join(memoryRoot, 'capture.json'))
    capture.cell('captured-sources', {}).value = { [sha256('successful-original')]: clock.nowMs() }
    capture.cell<number | null>('last-extracted-at', null).value = clock.nowMs()

    const completed = work.dispatch({ type: 'work.create', projectId: 'p', objective: 'Create a verified result', acceptance: ['result.txt exists'], decisionIds: ['saved-decision'] }, 'saved-create').work!
    await tick(); writeFileSync(join(root, 'result.txt'), 'Saturday result')
    const file = captureWorkFile(root, 'result.txt')!
    contexts[0].evidence({ id: 'proof', identity: contexts[0].work.identity, rootSessionId: 'fixture-root', callId: 'fixture-write', kind: 'artifact', status: 'passed', relativePath: file.relativePath,
      beforeHash: null, afterHash: file.hash, bytes: file.bytes, exitCode: null, restricted: false, observedAt: clock.nowMs() })
    work.checkpoint(contexts[0].work.identity, { expectedObjectiveRevision: 1, evidenceIds: ['proof'], outcome: 'completed', explanation: 'Verified result', unresolved: [], nextStep: null }, 'saved-checkpoint')
    contexts[0].settled(false); await tick()
    check(work.get(completed.identity.workId)?.status === 'completed' && delivered.length === 1, 'checkpoint_delivered_before_save')
    const queued = work.dispatch({ type: 'work.create', projectId: 'p', objective: 'Continue only when requested', acceptance: ['reconcile first'], decisionIds: ['saved-decision'] }, 'saved-queued').work!
    held = true
    mkdirSync(join(root, 'connections'), { recursive: true }); writeFileSync(join(root, 'connections/memory.json'), 'LOCAL_CREDENTIAL_SENTINEL')
    const saved = await exportPrivateSave({ root, store, clock, source: 'fake', fileFilteringEnabled: true, credentials: ['LOCAL_CREDENTIAL_SENTINEL'],
      continuity: () => exportContinuity({ root, owner, memory: () => engine.archive(['LOCAL_CREDENTIAL_SENTINEL']) }) })
    const checked = await validatePrivateSave(saved.bytes, scope, 'fake')
    check(saved.manifest.formatVersion === 2 && saved.manifest.continuity?.memoryCount === 1 && saved.manifest.continuity.workCount === 2, 'nonempty_native_and_work_archive')
    check(![...checked.files.keys()].some(path => /connections|secrets|runs|dsh-sessions/.test(path)), 'private_configuration_and_approvals_excluded')
    const captured = readFileSync(join(memoryRoot, 'capture.json')), runtime = readFileSync(join(memoryRoot, 'runtime.json'))
    const workBytes = readFileSync(join(workRoot, 'events.log'))
    const staged = await stagePrivateSave(root, saved.bytes, scope, 'fake')
    // All subsequent state must be retired by the restore, while other owners survive.
    await repository.insert({ ...item, content: 'POST_SAVE_FACT' })
    store.append({ type: 'user/message', id: 'after-save', text: 'POST_SAVE_MESSAGE', requestId: 'after-save', commandHash: 'fixture' })
    await work.close(); await engine.dispose(); closeBook()
    writeFileSync(join(root, 'dsh-sessions.json'), '{"postSave":"session-and-approvals"}')
    queueRestore(root, staged.restoreId, randomUUID()); clock.advanceBy(86_400_000)
    const receipt = await applyPendingRestore(root, scope, 'fake', clock, open)
    check(receipt?.status === 'restored', 'same_transaction_restore')
    const receiving = ensureContinuityIdentity(root, scope)
    check(receiving.owner.dataRootId === owner.dataRootId && receiving.mirrorEpoch !== identity.mirrorEpoch && ensureContinuityIdentity(root, other.owner).mirrorEpoch === other.mirrorEpoch, 'mirror_epoch_rotated_only_for_restored_owner')
    check(!existsSync(join(root, 'dsh-sessions.json')) && readFileSync(join(root, 'connections/memory.json'), 'utf8') === 'LOCAL_CREDENTIAL_SENTINEL', 'old_execution_retired_local_credentials_preserved')
    check(readFileSync(join(memoryRoot, 'capture.json')).equals(captured) && readFileSync(join(memoryRoot, 'runtime.json')).equals(runtime), 'capture_cursor_and_original_outbox_preserved')
    const database = await open(join(memoryRoot, 'memory.duckdb'))
    try {
      const coordinator = await createMemoryCommitCoordinator({ database, clock, scope, logPath: join(memoryRoot, 'operations.log') })
      const facts = await coordinator.repository.list()
      check(facts.length === 1 && facts[0].id === kept.id && facts[0].content === kept.content, 'post_save_fact_removed')
      check(await coordinator.repository.get(forgotten.id) === undefined && (await coordinator.repository.operation('forget-before-save'))?.status === 'applied', 'forgotten_fact_does_not_resurrect')
      check((await coordinator.receipt('review:forget-before-save')).state === 'published', 'published_operation_reconciled_without_replay')
      const rows = await database.execute(`SELECT content_vector_json FROM memory_fragments WHERE id='${kept.id}'`) as { content_vector_json: string }[]
      check(JSON.stringify(JSON.parse(rows[0].content_vector_json)) === JSON.stringify(vector), 'complete_vector_roundtrip')
    } finally { await database.close() }
    check(readFileSync(join(workRoot, 'restored-history', sha256(workBytes) + '.log')).equals(workBytes), 'original_append_only_work_log_preserved')
    contexts.length = 0; delivered.length = 0; inputs.length = 0; held = false
    work = createContinuousWork(workOptions); work.stateChanged(); await tick()
    const pending = work.get(queued.identity.workId)!
    check(contexts.length === 0 && delivered.length === 0 && pending.status === 'review_required' && pending.identity.generation === 2 && pending.inputs[0].state === 'unknown', 'restore_does_not_execute_or_redeliver')
    const duplicate = work.dispatch({ type: 'work.create', projectId: 'p', objective: 'Continue only when requested', acceptance: ['reconcile first'], decisionIds: ['saved-decision'] }, 'saved-queued')
    check(duplicate.work?.identity.workId === queued.identity.workId && work.view().items.length === 2 && contexts.length === 0, 'restored_create_event_is_idempotent')
    const done = work.get(completed.identity.workId)!
    check(done.status === 'completed' && done.checkpointId === 'saved-checkpoint' && done.delivery?.state === 'consumed' && done.checkpoints?.[0].evidenceIds[0] === 'proof', 'completed_checkpoint_and_delivery_watermark_preserved')
    work.dispatch({ type: 'work.resume', target: { identity: pending.identity, expectedRevision: pending.revision } }, 'fresh-resume'); await tick()
    check(contexts.length === 1 && contexts[0].work.identity.generation === 3 && inputs.length === 1 && inputs[0] === 'fresh-resume', 'explicit_continue_uses_fresh_generation')
    await work.close()
    const restoredStore = openSessionStore(root, scope, clock)
    try {
      check(!JSON.stringify(restoredStore.history!()).includes('POST_SAVE_MESSAGE') && JSON.stringify(restoredStore.history!()).includes('Original Saturday requirement'), 'book_and_memory_rewind_together')
      const legacy = await exportPrivateSave({ root, store: restoredStore, clock, source: 'fake', fileFilteringEnabled: false })
      const legacyStage = await stagePrivateSave(root, legacy.bytes, scope, 'fake')
      restoredStore.close(); queueRestore(root, legacyStage.restoreId, randomUUID())
      check((await applyPendingRestore(root, scope, 'fake', clock, open))?.status === 'restored' && !existsSync(memoryRoot) && !existsSync(workRoot), 'legacy_restore_retires_new_engine_state')
      check(existsSync(join(legacyStage.stage, 'rollback', memoryTarget, 'memory.duckdb')) && existsSync(join(legacyStage.stage, 'rollback', workTarget, 'events.log')), 'legacy_restore_keeps_rollback_copy')
    } finally { restoredStore.close() }

    // Crash after retiring one new-format target: recovery must restore the
    // old book and identity together, never open a mixed candidate profile.
    const interrupted = await stagePrivateSave(root, saved.bytes, scope, 'fake')
    const currentIdentity = readFileSync(join(root, 'continuity.json'))
    const targets = ['journals/' + sha256(JSON.stringify([scope.userId, scope.characterId])), ...['projections.sqlite', 'campus.sqlite', 'documents.sqlite', 'memory.sqlite'], ...['projections.sqlite', 'campus.sqlite', 'documents.sqlite', 'memory.sqlite'].flatMap(name => [name + '-wal', name + '-shm']), 'dsh-sessions.json', ...continuityTargets(owner)]
    const previous = targets.filter(name => existsSync(join(root, name)))
    mkdirSync(join(interrupted.stage, 'rollback'), { recursive: true }); renameSync(join(root, 'continuity.json'), join(interrupted.stage, 'rollback/continuity.json'))
    writeFileSync(join(interrupted.stage, 'transaction.json'), JSON.stringify({ phase: 'applying', targets, previous }))
    queueRestore(root, interrupted.restoreId, randomUUID())
    check((await applyPendingRestore(root, scope, 'fake', clock, open))?.status === 'failed' && readFileSync(join(root, 'continuity.json')).equals(currentIdentity), 'interrupted_identity_move_rolls_back')
    return { ok: true, checks, realServices: false }
  } finally { await work.close(); await engine.dispose(); closeBook() }
}
