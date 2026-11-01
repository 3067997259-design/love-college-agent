import type { MemoryEvaluationCase, MemoryEvaluationMetrics } from '@proj-airi/memory-core'

import { CHINESE_MEMORY_EVALUATION_CASES, evaluateMemoryRetrieval, MEMORY_RETRIEVAL_EVALUATION_CASES, rankMemoryCandidates } from '@proj-airi/memory-core'

import { embedMemoryText } from './local-memory-embedding'

/**
 * Runs the small Chinese retrieval set with the installed local embedding
 * model. Calling this function is explicit because the first model load may
 * download a large model artifact in a browser worker.
 */
export async function evaluateChineseMemoryEmbeddings(texts: Readonly<Record<string, string>>): Promise<MemoryEvaluationMetrics> {
  const candidates = await Promise.all(Object.entries(texts).map(async (entry) => {
    const [id, text] = entry
    return {
      id,
      embedding: await embedMemoryText(text),
    }
  }))
  const cases = await Promise.all(CHINESE_MEMORY_EVALUATION_CASES.map(async item => ({
    ...item,
    retrievedIds: rankMemoryCandidates(await embedMemoryText(item.query), candidates),
  })))
  return evaluateMemoryRetrieval(cases)
}

/**
 * Evaluates a retrieval adapter through the production boundary.
 * The adapter returns final injected ids and optional measured cost fields.
 */
export async function evaluateProductionMemoryRetrieval(
  retrieve: (query: string) => Promise<Pick<MemoryEvaluationCase, 'retrievedIds' | 'queryTokenCount' | 'normalizedQueryTokenCount'>>,
): Promise<MemoryEvaluationMetrics> {
  const cases: MemoryEvaluationCase[] = []
  for (const item of MEMORY_RETRIEVAL_EVALUATION_CASES) {
    const startedAt = performance.now()
    const result = await retrieve(item.query)
    cases.push({
      ...item,
      ...result,
      retrievalLatencyMs: performance.now() - startedAt,
    })
  }
  return evaluateMemoryRetrieval(cases)
}

/** Detailed trace returned by a production memory retrieval adapter. */
export interface ProductionMemoryRetrievalTrace {
  /** Stable fixture id when the trace is produced by the 90-case evaluator. */
  caseId?: string
  /** Stratum assigned by the fixture. */
  stratum?: string
  /** Gold ids for the evaluated query. */
  relevantIds?: string[]
  /** Retrieved ids that are outside the gold set, bounded to the evaluated K. */
  falsePositiveIds?: string[]
  originalQuery?: string
  normalizedQuery?: string
  retrievedIds: string[]
  originalCandidateIds: string[]
  normalizedCandidateIds: string[]
  /** Whether a second embedding/search call actually ran. */
  normalizedQueryCalled?: boolean
  queryTokenCount?: number
  normalizedQueryTokenCount?: number
  embeddingLatencyMs?: number
  retrievalLatencyMs?: number
  /** Provider-reported or externally priced cost for this query and fallback. */
  costUsd?: number
}

function reportMetric(value: number, missing: number, caseCount: number): string {
  return missing > 0 ? `missing (${missing}/${caseCount})` : value.toFixed(3)
}

/**
 * Formats the MQ-0 result without turning unavailable measurements into zero.
 *
 * @example
 * formatProductionMemoryEvaluationReport({
 *   metrics: evaluateMemoryRetrieval([]),
 *   traces: [],
 * })
 * // => a Markdown report that labels token and latency fields as missing
 */
export function formatProductionMemoryEvaluationReport(input: {
  metrics: MemoryEvaluationMetrics
  traces: readonly ProductionMemoryRetrievalTrace[]
}): string {
  const { metrics } = input
  const lines = [
    '# MQ-0 production memory retrieval report',
    '',
    `Cases: ${metrics.caseCount}`,
    `Recall@3: ${metrics.recallAtK.toFixed(3)}`,
    `Precision@3: ${metrics.precisionAtK.toFixed(3)}`,
    `MRR@3: ${metrics.meanReciprocalRank.toFixed(3)}`,
    `False-positive@3: ${metrics.falsePositiveRateAtK.toFixed(3)}`,
    `Query tokens: ${reportMetric(metrics.averageQueryTokenCount, metrics.missingQueryTokenCount, metrics.caseCount)}`,
    `Additional normalized-query tokens: ${reportMetric(metrics.averageAdditionalQueryTokenCount, metrics.missingAdditionalQueryTokenCount, metrics.caseCount)}`,
    `Retrieval latency (ms): ${reportMetric(metrics.averageRetrievalLatencyMs, metrics.missingRetrievalLatency, metrics.caseCount)}`,
    `Cost: ${metrics.caseCount === 0 || metrics.averageCostUsd === undefined || (metrics.missingCostCount ?? metrics.caseCount) > 0 ? `missing (${metrics.missingCostCount ?? metrics.caseCount}/${metrics.caseCount})` : `$${metrics.averageCostUsd.toFixed(6)} average USD`}`,
    '',
    '| Stratum | Cases | Recall@3 | Precision@3 | MRR@3 | False-positive@3 |',
    '| --- | ---: | ---: | ---: | ---: | ---: |',
  ]
  for (const [stratum, result] of Object.entries(metrics.byStratum)) {
    lines.push(`| ${stratum} | ${result.caseCount} | ${result.recallAtK.toFixed(3)} | ${result.precisionAtK.toFixed(3)} | ${result.meanReciprocalRank.toFixed(3)} | ${result.falsePositiveRateAtK.toFixed(3)} |`)
  }
  lines.push('', `Trace rows: ${input.traces.length}`)
  const falsePositiveRows = input.traces.filter(trace => (trace.falsePositiveIds?.length ?? 0) > 0)
  lines.push(`False-positive cases: ${falsePositiveRows.length}`)
  if (falsePositiveRows.length > 0) {
    lines.push('', '| Case | Stratum | False-positive ids |', '| --- | --- | --- |')
    for (const trace of falsePositiveRows) {
      lines.push(`| ${trace.caseId ?? 'unknown'} | ${trace.stratum ?? 'unknown'} | ${(trace.falsePositiveIds ?? []).join(', ')} |`)
    }
  }
  return lines.join('\n')
}

/** Runs the 90-case set while preserving the production retrieval trace. */
export async function evaluateProductionMemoryRetrievalTrace(
  retrieve: (query: string) => Promise<ProductionMemoryRetrievalTrace>,
  options: { costPerMillionTokens?: number } = {},
): Promise<{ metrics: MemoryEvaluationMetrics, traces: Array<ProductionMemoryRetrievalTrace & { caseId: string, stratum?: string }> }> {
  const traces: Array<ProductionMemoryRetrievalTrace & { caseId: string, stratum?: string }> = []
  const cases: MemoryEvaluationCase[] = []
  for (const item of MEMORY_RETRIEVAL_EVALUATION_CASES) {
    const trace = await retrieve(item.query)
    const boundedRetrievedIds = trace.retrievedIds.slice(0, 3)
    const relevantIds = new Set(item.relevantIds)
    traces.push({
      ...trace,
      caseId: item.id,
      stratum: item.stratum,
      relevantIds: [...item.relevantIds],
      falsePositiveIds: boundedRetrievedIds.filter(id => !relevantIds.has(id)),
    })
    const normalizedQueryCalled = trace.normalizedQueryCalled
      ?? (!!trace.normalizedQuery && trace.normalizedQuery !== trace.originalQuery)
    const hasPriceableUsage = typeof trace.queryTokenCount === 'number'
      && Number.isFinite(trace.queryTokenCount)
      && (!normalizedQueryCalled || (typeof trace.normalizedQueryTokenCount === 'number' && Number.isFinite(trace.normalizedQueryTokenCount)))
    const tokenCount = (trace.queryTokenCount ?? 0) + (normalizedQueryCalled ? (trace.normalizedQueryTokenCount ?? 0) : 0)
    const pricedCost = options.costPerMillionTokens === undefined || !hasPriceableUsage
      ? undefined
      : tokenCount / 1_000_000 * options.costPerMillionTokens
    cases.push({
      ...item,
      retrievedIds: trace.retrievedIds,
      queryTokenCount: trace.queryTokenCount,
      normalizedQueryTokenCount: trace.normalizedQueryTokenCount,
      retrievalLatencyMs: trace.retrievalLatencyMs ?? trace.embeddingLatencyMs,
      costUsd: trace.costUsd ?? pricedCost,
    })
  }
  return { metrics: evaluateMemoryRetrieval(cases), traces }
}
