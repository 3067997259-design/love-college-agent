// Audit actual results from one sequential candidate run. No stale "latest passed" lookup.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { globSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { candidateFingerprint } from './continuity-candidate.mjs'

const directory = process.env.LCA_CONTINUITY_RUN_DIR ?? process.argv[process.argv.indexOf('--report-dir') + 1]
if (!directory || !process.env.LCA_CONTINUITY_RUN_DIR && !process.argv.includes('--report-dir')) throw new Error('Run pnpm test:continuity, or pass --report-dir for the SAME unchanged source candidate')
const root = resolve(directory), evidence = new Map()
const read = path => { const bytes = readFileSync(join(root, path)); evidence.set(path, createHash('sha256').update(bytes).digest('hex')); return bytes.toString('utf8') }
const run = JSON.parse(read('report.json'))
assert.equal(run.source, candidateFingerprint(), 'SOURCE_CHANGED_SINCE_RUN')
const unit = JSON.parse(read('unit.json'))
assert.equal(unit.numFailedTests, 0); assert.equal(unit.numFailedTestSuites, 0)
const task = name => {
  const result = run.tasks.find(task => task.name === name)
  assert.equal(result?.code, 0, 'MISSING_OR_FAILED_TASK:' + name); read(result.log)
  return { task: name, log: result.log }
}
const u = file => {
  const suite = unit.testResults.find(result => result.name.replaceAll('\\', '/').endsWith('/tests/unit/' + file + '.test.ts'))
  assert.ok(suite?.assertionResults.length, 'MISSING_SUITE:' + file)
  assert.ok(suite.assertionResults.every(test => test.status === 'passed'), 'INCOMPLETE_SUITE:' + file)
  return { suite: file, tests: suite.assertionResults.map(test => test.fullName) }
}
const gate = (kind, required = []) => {
  const files = globSync(`${kind}/gate-*/report.json`, { cwd: root })
  assert.equal(files.length, 1, 'GATE_MUST_BELONG_TO_THIS_RUN:' + kind)
  const report = JSON.parse(read(files[0])); assert.equal(report.ok, true)
  assert.ok(Array.isArray(report.checks) ? report.checks.length > 0 : Object.values(report.checks).every(value => value === true))
  for (const key of required) assert.ok(Array.isArray(report.checks) ? report.checks.includes(key) : report.checks[key] === true, 'MISSING_CHECK:' + key)
  return { report: files[0], checks: required.length ? required : report.checks }
}
task('unit'); task('sources'); task('typecheck-main'); task('typecheck-renderer'); task('lint'); task('build')
task('dsh-bridge'); task('dsh-family'); task('dsh-collaboration')
const bridgeLog = read('dsh-bridge.log'), bridge = JSON.parse(bridgeLog.slice(bridgeLog.indexOf('[\n'), bridgeLog.lastIndexOf(']') + 1))
const b = name => { const row = bridge.find(row => row.name === name); assert.equal(row?.ok, true, name); assert.ok(!row.skipped, 'REQUIRED_SCENARIO_SKIPPED:' + name); return { bridge: name, checks: row.checks } }
const cases = [
  ['T1', 'Reviewed preference, recall and cross-day product context', [gate('conversation', ['reviewedPreferenceRecalled', 'correctedValueAfterCompaction']), task('memory'), u('airi/core/evaluation'), u('continuity-corpus')]],
  ['T2', 'Foreground responds while a Worker tool remains blocked', [gate('execution', ['foregroundCompletesWhileToolHeld', 'twoWorkerRoots', 'roleRoutes'])]],
  ['T3', 'Durable supplement reaches the same root; stale action is refused', [gate('execution', ['supplementReachedOriginalRoot', 'oldUnissuedActionRejected', 'newestDecisionUsed', 'consumptionReceipts']), u('continuous-work')]],
  ['T4', 'Immediate delivery and recall use verified checkpoint evidence', [gate('execution', ['nativeFileEvidenceCompletesWork', 'deliveryBeforeMemoryExtraction', 'immediateFollowupUsesCheckpoint'])]],
  ['T5', 'Multiple works require an explicit target; stopping is isolated', [gate('execution', ['ambiguousUpdateHasNoImplicitTarget', 'stopDoesNotCancelOtherRoot']), u('continuous-work')]],
  ['T6', 'Bounded day/week/month coverage and two-month exact-ID history', [u('experience-index'), gate('execution', ['realDayRolloverWithWorkHistory', 'nextDayUsesSameWorkIdentity', 'originalHistoryStillPresent']), task('memory')]],
  ['T7', 'New current fact wins; prior decisions remain labelled historical', [gate('execution', ['oldSummaryCannotOverrideNewFact', 'historicalExpansionMarksSupersededValue']), u('experience-index'), u('context-composer')]],
  ['T8', 'Actual automatic/manual DSH compaction and tool pairing', [b('compact-auto'), b('compact-memory'), gate('conversation', ['actualDshCompaction', 'originalConversationPreserved']), task('memory'), u('memory-service')]],
  ['T9', 'Retirement survives compaction, family relay and restart', [b('state-source-restart'), b('reference-restart'), task('dsh-family'), u('memory-source-continuity')]],
  ['T10', 'One original decision across roots; derived reports excluded', [gate('execution', ['originalDecisionsNotRecaptured', 'handoffsNotNewExperiences']), gate('conversation', ['derivedRepliesNotRecaptured', 'noLegacyFactWrites']), u('memory-source-continuity')]],
  ['T11', 'Operation/event replay and interruption reconciliation', [u('airi/commits'), u('memory-capture-recovery'), u('continuous-work'), gate('recovery', ['published_operation_reconciled_without_replay', 'restored_create_event_is_idempotent', 'interrupted_identity_move_rolls_back'])]],
  ['T12', 'Native vectors, reopen, migration and offline mirror lifecycle', [gate('storage'), u('memory-settings'), u('airi/engine-native'), u('airi/mirror'), u('airi/pgvector/repository')]],
  ['T13', 'Nonempty private-save roundtrip and legacy migration', [gate('recovery'), u('memory-migration'), task('backup'), task('recovery')]],
  ['T14', 'Diary/life rules and busy/lighting compatibility', [u('diary'), u('life'), u('life-work'), u('sleep'), u('memory-source-continuity'), task('collaboration')]],
  ['T15', 'Owner, project, movable data root and mirror epoch isolation', [u('airi/core/scope'), u('airi/mirror'), u('memory-settings'), u('continuous-work'), u('character-package'), gate('recovery', ['mirror_epoch_rotated_only_for_restored_owner', 'explicit_continue_uses_fresh_generation'])]],
  ['T16', 'Missing vector/mirror and failed summary remain explicit and retryable', [u('airi/engine-native'), u('airi/embedding'), u('memory-service'), u('memory-settings'), task('model-routing')]],
].map(([id, description, evidence]) => ({ id, description, ok: true, evidence }))
const report = { ok: true, source: run.source, coverage: 'synthetic contracts and isolated product paths', cases,
  unit: { passed: unit.numPassedTests, skipped: unit.numPendingTests }, evidence: Object.fromEntries(evidence),
  pending: ['real model / vector / PostgreSQL mirror acceptance', '90-case retrieval quality and 24-story response evaluation with measured costs', 'performance matrix, ablations and long-term use', 'second Windows device and installed upgrade'],
  limits: ['T5 checks explicit routing and refusal of missing targets; natural-language disambiguation quality requires a real model.', 'T14 runs unchanged diary/life contracts, not a longitudinal personality comparison.', 'PostgreSQL SQL contracts use fakes; real-service tests remain explicitly skipped.'] }
writeFileSync(join(root, 't1-t16.json'), JSON.stringify(report, null, 2))
console.log(JSON.stringify({ ok: true, cases: cases.map(row => row.id), source: run.source, report: join(root, 't1-t16.json'), pending: report.pending }))
