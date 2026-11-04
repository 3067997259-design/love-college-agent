// Offline evidence audit. Never reads connection files or makes service calls.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { evaluateMemoryRetrieval, MEMORY_RETRIEVAL_EVALUATION_CASES } from '../src/main/memory/airi/core/evaluation.ts'

const [manifestPath, outputPath] = process.argv.slice(2)
assert.ok(manifestPath && outputPath, 'MANIFEST_AND_NEW_OUTPUT_REQUIRED')
const repo = resolve(import.meta.dirname, '..')
const read = path => JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''))
const sha = path => createHash('sha256').update(readFileSync(path)).digest('hex')
const receipt = path => ({ path, sha256: sha(path) })
const manifest = read(resolve(manifestPath))
const retrievalPlan = read(join(repo, 'scripts/memory-quality-plan.json'))
const storyPlan = read(join(repo, 'scripts/memory-stories-plan.json'))
const stories = read(join(repo, 'tests/fixtures/continuity-stories.json')).stories
assert.equal(retrievalPlan.productionCommit, storyPlan.productionCommit, 'PLAN_CANDIDATE_MISMATCH')
assert.equal(retrievalPlan.asarSha256, storyPlan.asarSha256, 'PLAN_CANDIDATE_MISMATCH')
execFileSync('git', ['diff', '--exit-code', retrievalPlan.productionCommit, '--', 'src'], { cwd: repo, stdio: 'pipe' })
const report = { ok: false, productionCommit: retrievalPlan.productionCommit, asarSha256: retrievalPlan.asarSha256,
  scope: '90-real-retrieval-and-24-real-stories-across-bounded-windows', serviceCallsByAudit: 0,
  retrieval: null, storyRuns: [], verifiedStories: [], missingStories: [], errors: [] }
const failure = (kind, root, error) => report.errors.push({ kind, root, code: error instanceof Error && /^[A-Z_]+$/.test(error.message) ? error.message : 'AUDIT_EVIDENCE_MISSING_OR_INCONSISTENT' })

function common(root, criticalSources) {
  const run = read(join(root, 'run.json')), result = read(join(root, 'report.json'))
  const closed = read(join(root, 'closed.json'))
  assert.ok(run.selfTest === false && result.selfTest === false, 'REAL_SERVICE_EVIDENCE_REQUIRED')
  const authorization = read(join(root, 'authorization.json'))
  assert.ok(closed.reuseAllowed === false && closed.cleanupUncertain === false, 'CLOSED_WINDOW_REQUIRED')
  assert.equal(closed.ok, result.ok, 'RUNNER_RESULT_MISMATCH')
  assert.equal(run.productionCommit, report.productionCommit, 'PRODUCTION_VERSION_MISMATCH')
  assert.equal(run.asarSha256, report.asarSha256, 'PACKAGE_VERSION_MISMATCH')
  assert.ok(authorization.authorized === true && authorization.authorizationId && authorization.firstFailureStops === true, 'AUTHORIZATION_REQUIRED')
  assert.equal(authorization.batch, run.batch, 'AUTHORIZATION_SCOPE_MISMATCH')
  assert.equal(authorization.asarSha256, run.asarSha256, 'AUTHORIZATION_PACKAGE_MISMATCH')
  assert.deepEqual(authorization.sources, run.sources, 'AUTHORIZATION_SOURCE_MISMATCH')
  assert.equal(authorization.bundleSha256, run.bundleSha256, 'AUTHORIZATION_BUNDLE_MISMATCH')
  assert.equal(sha(join(root, 'bundle/probe.cjs')), run.bundleSha256, 'BUNDLE_CHANGED')
  for (const [path, hash] of Object.entries(run.sources)) {
    assert.ok(/^(scripts|tests|src)\/[A-Za-z0-9_./-]+$/.test(path) && !path.split('/').includes('..'), 'UNSAFE_SOURCE_REFERENCE')
    assert.equal(sha(join(root, 'source', path.replaceAll('/', '__'))), hash, 'ARCHIVED_SOURCE_CHANGED')
  }
  for (const path of criticalSources) assert.equal(run.sources[path], sha(join(repo, path)), 'FROZEN_CASE_OR_SEMANTICS_CHANGED')
  for (const [key, field] of Object.entries({ modelRequests: 'maximumModelRequests', embeddingRequests: 'maximumEmbeddingRequests', embeddingCharacters: 'maximumEmbeddingInputCharacters', reservedUnits: 'maximumReservedUnits', autonomousUnits: 'maximumAutonomousUnits' })) {
    assert.equal(run.limits[field], authorization[field], 'AUTHORIZED_LIMIT_MISMATCH')
    assert.ok(Number.isSafeInteger(result.counts[key]) && result.counts[key] >= 0 && result.counts[key] <= authorization[field], 'BUDGET_EVIDENCE_INVALID')
  }
  assert.equal(result.upstreamRequests, result.counts.modelRequests + result.counts.embeddingRequests, 'REQUEST_ACCOUNTING_MISMATCH')
  assert.ok(result.counts.autonomousUnits <= result.counts.reservedUnits, 'AUTONOMOUS_NOT_INCLUDED_IN_TOTAL')
  assert.ok(result.upstreamRequests > 0, 'REAL_REQUESTS_REQUIRED')
  return { run, result, closed, authorization, receipts: ['run.json', 'report.json', 'closed.json', 'authorization.json'].map(path => receipt(join(root, path))) }
}

try {
  const root = resolve(manifest.retrievalRoot)
  const { result, closed, authorization, receipts } = common(root, ['tests/fixtures/memory-quality-corpus.json', 'src/main/memory/airi/core/evaluation.ts'])
  assert.equal(authorization.expectedModel, retrievalPlan.expectedModel, 'VECTOR_MODEL_CHANGED')
  assert.ok(result.ok && result.qualityPassed === true && closed.ok && result.error === null && result.runtimeFailure === null, 'COMPLETE_RETRIEVAL_PASS_REQUIRED')
  assert.equal(result.counts.modelRequests, 0, 'RETRIEVAL_MODEL_CALL_FORBIDDEN')
  assert.equal(result.casesCompleted, 90, 'NINETY_CASES_REQUIRED')
  assert.deepEqual(result.acceptance, retrievalPlan.acceptance, 'QUALITY_THRESHOLDS_CHANGED')
  assert.equal(result.result.traces.length, MEMORY_RETRIEVAL_EVALUATION_CASES.length, 'RETRIEVAL_CASES_MISSING')
  assert.ok(result.samples.length === result.counts.embeddingRequests && result.samples.every(sample => sample.ok && sample.status === 200), 'EMBEDDING_REQUEST_NOT_PASSED')
  const caseReceipts = []
  const cases = MEMORY_RETRIEVAL_EVALUATION_CASES.map((expected, index) => {
    const trace = result.result.traces[index], path = join(root, 'case-' + expected.id + '.json'), actual = read(path)
    assert.equal(trace.caseId, expected.id, 'RETRIEVAL_CASE_ID_MISMATCH')
    assert.equal(trace.originalQuery, expected.query, 'RETRIEVAL_QUERY_CHANGED')
    assert.equal(trace.stratum, expected.stratum, 'RETRIEVAL_STRATUM_CHANGED')
    assert.deepEqual(trace.relevantIds, expected.relevantIds, 'RETRIEVAL_GOLD_CHANGED')
    assert.ok(trace.retrievedIds.length <= 3 && new Set(trace.retrievedIds).size === trace.retrievedIds.length, 'DUPLICATE_RETRIEVAL_RESULTS')
    for (const key of ['caseId', 'originalQuery', 'normalizedQuery', 'retrievedIds', 'originalCandidateIds', 'normalizedCandidateIds', 'normalizedQueryCalled']) assert.deepEqual(actual[key], trace[key], 'TRACE_FILE_MISMATCH')
    caseReceipts.push(receipt(path))
    return { ...expected, ...trace, id: expected.id }
  })
  const metrics = evaluateMemoryRetrieval(cases)
  for (const key of ['caseCount', 'recallAtK', 'precisionAtK', 'meanReciprocalRank', 'falsePositiveRateAtK', 'byStratum']) assert.deepEqual(metrics[key], result.result.metrics[key], 'RECOMPUTED_METRICS_MISMATCH')
  assert.ok(metrics.recallAtK >= retrievalPlan.acceptance.minimumRecallAt3 && metrics.meanReciprocalRank >= retrievalPlan.acceptance.minimumMrrAt3, 'OVERALL_THRESHOLD_FAILED')
  assert.ok(Object.keys(metrics.byStratum).length === 9 && Object.values(metrics.byStratum).every(value => value.caseCount === 10 && value.recallAtK >= retrievalPlan.acceptance.minimumStratumRecallAt3), 'STRATUM_THRESHOLD_FAILED')
  report.retrieval = { root, passed: true, metrics, receipts, caseReceipts }
} catch (error) { failure('retrieval', manifest.retrievalRoot, error) }

const verified = new Set()
for (const rootArg of manifest.storyRoots ?? []) {
  try {
    const root = resolve(rootArg)
    const { run, result, authorization, receipts } = common(root, ['tests/fixtures/continuity-stories.json', 'scripts/fixtures/memory-story-cases.ts', 'scripts/fixtures/continuity-live-budget.ts', 'scripts/fixtures/world-probe-stream.ts', 'scripts/fixtures/probe-response-deadline.ts'])
    const ioHash = run.sources['scripts/fixtures/memory-story-io.ts']
    if (ioHash === sha(join(repo, 'scripts/fixtures/memory-story-io.ts'))) {
      for (const path of ['scripts/fixtures/memory-story-harness.ts', 'scripts/fixtures/memory-story-embedding.ts', 'scripts/fixtures/probe-transport.ts', 'scripts/fixtures/memory-retrieval-diagnostics.ts']) assert.equal(run.sources[path], sha(join(repo, path)), 'STORY_IO_DEPENDENCY_CHANGED')
    } else {
      // Exact audited predecessors, not a general waiver. Only completed clean cases qualify.
      assert.ok(['5907c8973a7f3db4554ada3fa19f88142fb379c45195bde94ba9c8beb0222040', 'fde71596a4f0eaf0256c914181a8264e5e17b489c9a714d1afccce38635f85bd'].includes(ioHash), 'UNAUDITED_STORY_IO_VERSION')
      assert.equal(run.sources['scripts/fixtures/memory-story-harness.ts'], 'd25c715ceeaef5ce8944980a8b06bc56f6b029fb24ac4eb5ef45e9529612d836', 'UNAUDITED_STORY_HARNESS_VERSION')
      if (ioHash === 'fde71596a4f0eaf0256c914181a8264e5e17b489c9a714d1afccce38635f85bd') {
        assert.equal(run.sources['scripts/fixtures/memory-story-embedding.ts'], '554af5d82ae9da269adcd417c673c5b32fd2d28ddd2516afd40d5996c9c1dd81', 'STORY_IO_DEPENDENCY_CHANGED')
        assert.equal(run.sources['scripts/fixtures/probe-transport.ts'], '7e04f23ef2b54110cd24a7f6863bc3d9db7a71cf88c63dcb75581c91f31d9aa3', 'STORY_IO_DEPENDENCY_CHANGED')
      }
    }
    assert.equal(authorization.expectedEmbeddingModel, storyPlan.expectedEmbeddingModel, 'VECTOR_MODEL_CHANGED')
    const io = read(join(root, 'io.json'))
    assert.equal(io.halted, true, 'STORY_IO_NOT_CLOSED')
    assert.equal(io.inFlight, 0, 'STORY_REQUEST_STILL_ACTIVE')
    if (io.embedding) assert.ok(io.embedding.inFlight === 0 && io.embedding.drain.pendingAtClose === 0 && io.embedding.drain.settledWithoutRetry, 'STORY_VECTOR_STILL_ACTIVE')
    assert.deepEqual(io.counts, result.counts, 'STORY_ACCOUNTING_MISMATCH')
    assert.deepEqual(result.completed, run.storyOrder.slice(0, result.completed.length), 'STORY_ORDER_CHANGED')
    assert.equal(new Set(result.completed).size, result.completed.length, 'DUPLICATE_STORY_COVERAGE')
    const reviewed = []
    for (const id of result.completed) {
      const expected = stories.find(item => item.id === id); assert.ok(expected, 'UNKNOWN_STORY')
      const path = join(root, id + '.json'), value = read(path), reviewPath = join(root, 'reviews', id + '.json'), review = read(reviewPath)
      assert.equal(value.id, id, 'STORY_ID_CHANGED'); assert.equal(value.question, expected.question, 'STORY_QUESTION_CHANGED')
      assert.equal(review.id, id, 'REVIEW_ID_CHANGED'); assert.equal(review.resultSha256, sha(path), 'REVIEW_RESULT_CHANGED')
      assert.ok(review.verdict === 'pass' && typeof review.reason === 'string' && review.reason.length > 20, 'SEMANTIC_PASS_REQUIRED')
      assert.deepEqual(result.reviews.find(item => item.id === id), review, 'REVIEW_RECEIPT_MISMATCH')
      assert.ok(value.answer?.trim() && value.references?.length > 0, 'ANSWER_OR_SUCCESSFUL_INPUT_MISSING')
      const model = io.samples.filter(sample => sample.story === id && sample.kind === 'model')
      assert.ok(io.samples.filter(sample => sample.story === id && sample.kind === 'embedding').every(sample => sample.ok && sample.status === 200 && Number.isFinite(sample.elapsedMs)), 'STORY_VECTOR_NOT_PASSED')
      if (ioHash !== sha(join(repo, 'scripts/fixtures/memory-story-io.ts'))) assert.ok(io.samples.filter(sample => sample.story === id && sample.kind === 'embedding' && sample.inputType === 'query').every(sample => sample.elapsedMs < 3000), 'LEGACY_QUERY_DEADLINE_NOT_VERIFIED')
      assert.ok(model.length > 0 && model.every(sample => sample.ok && sample.status === 200), 'STORY_MODEL_CALL_NOT_PASSED')
      assert.ok(value.references.every(reference => model.some(sample => sample.ticket === reference.ticket)), 'SUCCESSFUL_INPUT_TICKET_MISMATCH')
      if (storyPlan.followUps[id]) {
        assert.equal(value.followUp?.question, storyPlan.followUps[id], 'FOLLOW_UP_QUESTION_MISSING_OR_CHANGED')
        assert.ok(model.length >= 2 && value.followUp.answer?.trim() && value.followUp.references?.length > 0, 'FOLLOW_UP_REAL_ANSWER_REQUIRED')
        assert.ok(value.followUp.references.every(reference => model.some(sample => sample.ticket === reference.ticket)), 'FOLLOW_UP_INPUT_TICKET_MISMATCH')
      }
      reviewed.push({ id, result: receipt(path), review: receipt(reviewPath) })
      verified.add(id)
    }
    report.storyRuns.push({ root, originalWindowPassed: result.ok, completed: result.completed, receipts, reviewed })
  } catch (error) { failure('stories', rootArg, error) }
}
report.verifiedStories = stories.map(item => item.id).filter(id => verified.has(id))
report.missingStories = stories.map(item => item.id).filter(id => !verified.has(id))
report.ok = report.errors.length === 0 && report.retrieval?.passed === true && report.missingStories.length === 0
writeFileSync(resolve(outputPath), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' })
console.log(JSON.stringify({ ok: report.ok, retrievalPassed: report.retrieval?.passed ?? false, verifiedStories: report.verifiedStories, missingStories: report.missingStories, errors: report.errors, serviceCallsByAudit: 0 }))
if (!report.ok) process.exitCode = 1
