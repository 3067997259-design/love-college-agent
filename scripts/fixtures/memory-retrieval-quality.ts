import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createManualClock, systemClock } from '../../src/main/clock'
import { createMemoryEngine } from '../../src/main/memory/engine'
import { createMemoryDatabaseClient } from '../../src/main/memory/storage/client'
import { createNativeMemoryDatabase } from '../../src/main/memory/storage/neo'
import { createApiMemoryEmbeddingSource } from '../../src/main/memory/airi/embedding'
import { evaluateProductionMemoryRetrievalTrace, formatProductionMemoryEvaluationReport } from '../../src/main/memory/airi/evaluation'
import { MEMORY_RETRIEVAL_EVALUATION_CASES } from '../../src/main/memory/airi/core'
import { createResourceBudget } from '../../src/main/resources/service'
import { createContinuityProbeBudget } from './continuity-live-budget'
import corpus from '../../tests/fixtures/memory-quality-corpus.json'
import plan from '../memory-quality-plan.json'

type Configuration = { baseUrl: string; apiKey: string; model: string }
type Sample = { id: number; kind: string; characters: number; status: number | null; elapsedMs: number; ok: boolean; inputSha256: string }

/** Controlled retrieval evaluation, not automatic extraction or a substitute for product stories. */
export async function runMemoryRetrievalQuality(input: { root: string; selfTest: boolean; authorized?: string }) {
  assert.ok(process.versions.electron, 'ELECTRON_MAIN_REQUIRED')
  const config: Configuration = input.selfTest
    ? { baseUrl: 'https://api.voyageai.com/v1', apiKey: 'synthetic-only', model: plan.expectedModel }
    : JSON.parse(readFileSync(input.authorized!, 'utf8')).embedding
  assert.equal(config.model, plan.expectedModel, 'AUTHORIZED_MODEL_CHANGED')
  const ledger = createResourceBudget({ root: join(input.root, 'budget'), clock: systemClock, configurable: true })
  const fixedTime = createManualClock(1_793_635_200_000)
  // Equal-age documents, but production IO deadlines must still expire in wall time.
  const corpusClock = { ...fixedTime, after: systemClock.after }
  const samples: Sample[] = []
  const budget = createContinuityProbeBudget(plan.limits, (units, bucket) => { ledger.reserveModel(units, bucket) })
  let failure: string | null = null
  const engines: ReturnType<typeof createMemoryEngine>[] = []
  const report = { ok: false, selfTest: input.selfTest, qualityAssessed: !input.selfTest, qualityPassed: null as boolean | null,
    coverage: plan.measurement, failurePolicy: plan.failurePolicy, limits: plan.limits, acceptance: plan.acceptance,
    upstreamRequests: 0, samples, casesCompleted: 0, corpusCounts: { zh: 0, en: 0 }, counts: budget.view(), error: null as string | null,
    stage: 'setup', diagnostic: null as string | null,
    result: null as Awaited<ReturnType<typeof evaluateProductionMemoryRetrievalTrace>> | null }
  const save = () => { report.counts = budget.view(); writeFileSync(join(input.root, 'report.json'), JSON.stringify(report, null, 2)) }
  const raw = createApiMemoryEmbeddingSource({ ...config, clock: systemClock, fetch: async (url, init) => {
    assert.equal(failure, null, 'BATCH_ALREADY_FAILED')
    const body = JSON.parse(String(init?.body))
    assert.ok(typeof body.input === 'string' && ['query', 'document'].includes(body.input_type), 'EMBEDDING_PROTOCOL_CHANGED')
    const sample: Sample = { id: samples.length + 1, kind: body.input_type, characters: body.input.length, status: null, elapsedMs: 0, ok: false,
      inputSha256: createHash('sha256').update(body.input).digest('hex') }
    samples.push(sample); const start = systemClock.nowMs()
    try {
      budget.embedding('embedding:' + sample.id, body.input); save()
      if (!input.selfTest) { report.upstreamRequests++; save() }
      const response = input.selfTest
        ? new Response(JSON.stringify({ data: [{ embedding: Array.from({ length: 1024 }, (_, i) => i === 0 ? 1 : 0) }] }))
        : await fetch(url, { ...init, redirect: 'error' })
      sample.status = response.status
      assert.ok(response.ok, 'EMBEDDING_HTTP_FAILED')
      return response
    } catch { failure = 'EMBEDDING_ADMISSION_OR_TRANSPORT_FAILED'; throw new Error(failure) }
    finally { sample.elapsedMs = systemClock.nowMs() - start; save() }
  } })
  const source = { ...raw, embed: async (text: string, kind?: 'query' | 'document') => {
    assert.equal(failure, null, 'BATCH_ALREADY_FAILED')
    const started = systemClock.nowMs()
    try { const vector = await raw.embed(text, kind); samples.at(-1)!.ok = true; return vector }
    catch { failure ??= 'EMBEDDING_PROTOCOL_FAILED'; throw new Error(failure) }
    finally { if (samples.length) samples.at(-1)!.elapsedMs = systemClock.nowMs() - started; save() }
  } }
  try {
    assert.equal(raw.provider, 'voyage', 'VOYAGE_CONNECTION_REQUIRED')
    assert.equal(ledger.dispatch({ protocolVersion: 1, epoch: 'quality', requestId: 'limits', type: 'resources.configure',
      dailyTotalUnits: plan.limits.maximumReservedUnits, dailyAutonomousUnits: plan.limits.maximumAutonomousUnits }), undefined)
    assert.equal(corpus.documents.length, 20)
    assert.equal(new Set(corpus.documents.map(doc => doc.id)).size, 20)
    const corpora = new Map<string, { engine: ReturnType<typeof createMemoryEngine>; scope: { userId: string; characterId: string }; ids: Map<string, string> }>()
    for (const language of ['zh', 'en'] as const) {
      report.stage = language + ':initialize'; save()
      const scope = { userId: 'retrieval-fixture-' + language, characterId: 'taozi' }
      const engine = createMemoryEngine({ root: join(input.root, language), owner: { ...scope, dataRootId: 'quality-' + language }, clock: corpusClock,
        embedding: () => source, held: () => false, waitForRestore: async () => {}, journal: () => {},
        openDatabase: async path => { const database = createMemoryDatabaseClient(createNativeMemoryDatabase(), systemClock); await database.open(path); return database } })
      engines.push(engine)
      assert.ok(await engine.runtime.initialize(), 'DATABASE_UNAVAILABLE')
      const ids = new Map<string, string>()
      // Fixture facts pass through the original proposal/review transactions. Labels stay in this evaluator's map.
      for (const [index, doc] of corpus.documents.entries()) {
        report.stage = language + ':seed:' + index; save()
        const operationId = 'seed-' + language + '-' + index
        const operation = await engine.runtime.proposeOperation({ scope, sessionId: 'corpus', turnId: operationId,
          sourceContext: { sessionId: 'corpus', messageId: operationId, neighbors: [] }, isCurrent: () => true },
        operationId, { kind: 'remember', content: doc[language], title: '', summary: '' })
        assert.equal((await engine.runtime.confirmOperation(scope, operationId, true)).status, 'applied')
        assert.ok(operation.fragmentId); ids.set(operation.fragmentId, doc.id); report.corpusCounts[language]++; save()
      }
      // Explicit settings-style migration is awaited. Do not hide first-turn initialization timeouts by changing thresholds.
      report.stage = language + ':migrate'; save()
      await engine.runtime.refreshEmbedding(); await engine.runtime.idle()
      assert.equal(failure, null); assert.equal(engine.runtime.embeddingMigration.value.state, 'complete', 'VECTOR_MIGRATION_FAILED')
      corpora.set(language, { engine, scope, ids })
    }
    report.result = await evaluateProductionMemoryRetrievalTrace(async query => {
      const item = MEMORY_RETRIEVAL_EVALUATION_CASES[report.casesCompleted]
      report.stage = 'query:' + item.id; save()
      assert.equal(query, item.query)
      const { engine, scope, ids } = corpora.get(item.stratum === 'zh-to-en' ? 'en' : 'zh')!
      const trace = await engine.runtime.retrieveEvaluationTrace(query, 'quality', scope)
      assert.equal(failure, null); assert.equal(engine.runtime.databaseStatus.value, 'ready')
      assert.ok(!engine.runtime.embeddingError.value, 'PRODUCTION_RETRIEVAL_FAILED')
      const map = (values: string[]) => values.map(id => { const fixture = ids.get(id); assert.ok(fixture, 'UNEXPECTED_CORPUS_ID'); return fixture })
      const result = { ...trace, retrievedIds: map(trace.retrievedIds), originalCandidateIds: map(trace.originalCandidateIds), normalizedCandidateIds: map(trace.normalizedCandidateIds) }
      writeFileSync(join(input.root, 'case-' + item.id + '.json'), JSON.stringify({ caseId: item.id, ...result }, null, 2), { flag: 'wx' })
      report.casesCompleted++; save(); return result
    })
    const metrics = report.result.metrics
    assert.equal(report.casesCompleted, plan.acceptance.cases)
    assert.equal(Object.keys(metrics.byStratum).length, plan.acceptance.strata)
    report.qualityPassed = input.selfTest ? null : metrics.recallAtK >= plan.acceptance.minimumRecallAt3
      && metrics.meanReciprocalRank >= plan.acceptance.minimumMrrAt3
      && Object.values(metrics.byStratum).every(value => value.recallAtK >= plan.acceptance.minimumStratumRecallAt3)
    report.ok = input.selfTest || report.qualityPassed === true
    if (!report.ok) report.error = 'FROZEN_QUALITY_THRESHOLD_NOT_MET'
    writeFileSync(join(input.root, 'metrics.md'), formatProductionMemoryEvaluationReport(report.result))
  } catch (cause) { report.error = failure ?? 'RETRIEVAL_FIXTURE_OR_STORAGE_FAILED'; if (input.selfTest) report.diagnostic = cause instanceof Error ? cause.message : 'UNKNOWN_OFFLINE_FAILURE' }
  finally { for (const engine of engines.reverse()) await engine.dispose(); ledger.close(); save() }
  return report
}
