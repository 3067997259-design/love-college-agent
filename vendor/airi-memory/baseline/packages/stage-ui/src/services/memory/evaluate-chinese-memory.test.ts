import { describe, expect, it } from 'vitest'

import { evaluateProductionMemoryRetrievalTrace, formatProductionMemoryEvaluationReport } from './evaluate-chinese-memory'

describe('production memory retrieval evaluation', () => {
  it('keeps the complete production trace beside aggregate metrics', async () => {
    const result = await evaluateProductionMemoryRetrievalTrace(async query => ({
      retrievedIds: query.includes('奖学金') ? ['fact-scholarship'] : [],
      originalCandidateIds: [],
      normalizedCandidateIds: [],
      queryTokenCount: 3,
      normalizedQueryTokenCount: 4,
      retrievalLatencyMs: 2,
      costUsd: 0.000003,
    }))
    expect(result.traces).toHaveLength(90)
    expect(result.traces[0]?.originalCandidateIds).toEqual([])
    expect(result.metrics.caseCount).toBe(90)
    expect(result.metrics.averageCostUsd).toBeCloseTo(0.000003)
    expect(result.metrics.missingCostCount).toBe(0)
    expect(result.traces[0]?.caseId).toBe('short-zh-01')
    expect(result.traces[0]?.relevantIds).toEqual(['fact-scholarship'])
    expect(result.traces[0]?.falsePositiveIds).toEqual([])
  })

  it('derives a transparent estimate when a provider price card is supplied', async () => {
    const result = await evaluateProductionMemoryRetrievalTrace(async () => ({
      retrievedIds: [],
      originalCandidateIds: [],
      normalizedCandidateIds: [],
      normalizedQueryCalled: true,
      queryTokenCount: 1_000,
      normalizedQueryTokenCount: 1_500,
    }), { costPerMillionTokens: 2 })

    expect(result.metrics.averageCostUsd).toBeCloseTo(0.003)
    expect(result.metrics.missingCostCount).toBe(0)
  })

  it('renders missing operational measurements explicitly in the report', () => {
    const report = formatProductionMemoryEvaluationReport({
      metrics: {
        caseCount: 1,
        recallAtK: 1,
        meanReciprocalRank: 1,
        precisionAtK: 1,
        falsePositiveRateAtK: 0,
        averageQueryTokenCount: 0,
        averageAdditionalQueryTokenCount: 0,
        averageRetrievalLatencyMs: 0,
        missingQueryTokenCount: 1,
        missingAdditionalQueryTokenCount: 1,
        missingRetrievalLatency: 1,
        byStratum: {
          smoke: { caseCount: 1, recallAtK: 1, meanReciprocalRank: 1, precisionAtK: 1, falsePositiveRateAtK: 0 },
        },
      },
      traces: [],
    })

    expect(report).toContain('Recall@3: 1.000')
    expect(report).toContain('Query tokens: missing (1/1)')
    expect(report).toContain('Cost: missing')
    expect(report).toContain('| smoke | 1 |')
  })

  it('lists false-positive ids beside aggregate false-positive rate', () => {
    const report = formatProductionMemoryEvaluationReport({
      metrics: {
        caseCount: 1,
        recallAtK: 0,
        meanReciprocalRank: 0,
        precisionAtK: 0,
        falsePositiveRateAtK: 0.333,
        averageQueryTokenCount: 1,
        averageAdditionalQueryTokenCount: 0,
        averageRetrievalLatencyMs: 1,
        missingQueryTokenCount: 0,
        missingAdditionalQueryTokenCount: 0,
        missingRetrievalLatency: 0,
        averageCostUsd: 0,
        missingCostCount: 0,
        byStratum: {},
      },
      traces: [{
        caseId: 'near-miss-01',
        stratum: 'near-miss',
        retrievedIds: ['wrong-fact'],
        originalCandidateIds: ['wrong-fact'],
        normalizedCandidateIds: [],
        falsePositiveIds: ['wrong-fact'],
      }],
    })

    expect(report).toContain('False-positive cases: 1')
    expect(report).toContain('| near-miss-01 | near-miss | wrong-fact |')
  })
})
