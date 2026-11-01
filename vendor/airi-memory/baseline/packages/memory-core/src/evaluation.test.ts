import { describe, expect, it } from 'vitest'

import { CHINESE_MEMORY_EVALUATION_CASES, evaluateMemoryRetrieval, MEMORY_RETRIEVAL_EVALUATION_CASES, rankMemoryCandidates } from './evaluation'

describe('memory retrieval evaluation', () => {
  it('ranks vector candidates and breaks score ties by id', () => {
    expect(rankMemoryCandidates([1, 0], [
      { id: 'b', embedding: [0, 1] },
      { id: 'a', embedding: [1, 0] },
    ])).toEqual(['a', 'b'])
  })

  it('reports recall, MRR, precision, and per-stratum results', () => {
    const metrics = evaluateMemoryRetrieval([
      { ...CHINESE_MEMORY_EVALUATION_CASES[0], retrievedIds: ['scholarship', 'noise'] },
      { ...CHINESE_MEMORY_EVALUATION_CASES[1], retrievedIds: ['noise', 'study-abroad'] },
    ], 2)

    expect(metrics.caseCount).toBe(2)
    expect(metrics.recallAtK).toBe(1)
    expect(metrics.meanReciprocalRank).toBe(0.75)
    expect(metrics.precisionAtK).toBe(0.5)
    expect(metrics.byStratum.education.caseCount).toBe(2)
  })

  it('reports missing cost measurements separately from measured zero', () => {
    const metrics = evaluateMemoryRetrieval([
      { id: 'measured', query: 'a', relevantIds: ['a'], retrievedIds: ['a'], queryTokenCount: 0, normalizedQueryTokenCount: 0, retrievalLatencyMs: 0, costUsd: 0 },
      { id: 'missing', query: 'b', relevantIds: ['b'], retrievedIds: ['b'] },
    ])
    expect(metrics.averageQueryTokenCount).toBe(0)
    expect(metrics.averageAdditionalQueryTokenCount).toBe(0)
    expect(metrics.averageRetrievalLatencyMs).toBe(0)
    expect(metrics.missingQueryTokenCount).toBe(1)
    expect(metrics.missingAdditionalQueryTokenCount).toBe(1)
    expect(metrics.missingRetrievalLatency).toBe(1)
    expect(metrics.averageCostUsd).toBe(0)
    expect(metrics.missingCostCount).toBe(1)
  })

  it('keeps the zh-to-en stratum as Chinese queries for cross-language evaluation', () => {
    const cases = MEMORY_RETRIEVAL_EVALUATION_CASES.filter(item => item.stratum === 'zh-to-en')

    expect(cases).toHaveLength(10)
    expect(cases.every(item => /[\u3400-\u9FFF]/u.test(item.query))).toBe(true)
  })
})
