import { describe, expect, it } from 'vitest'
import { MEMORY_RETRIEVAL_EVALUATION_CASES, normalizeMemoryRetrievalQuery } from '../../src/main/memory/airi/core'
import { createContinuityProbeBudget } from '../../scripts/fixtures/continuity-live-budget'
import type { runMemoryRetrievalQuality } from '../../scripts/fixtures/memory-retrieval-quality'
import type { runMemoryStoriesQuality } from '../../scripts/fixtures/memory-stories-quality'
import corpus from '../fixtures/memory-quality-corpus.json'
import plan from '../../scripts/memory-quality-plan.json'

describe('frozen production retrieval evaluation', () => {
  it('covers every upstream label in both languages without embedding query copies or labels', () => {
    const labels = [...new Set(MEMORY_RETRIEVAL_EVALUATION_CASES.flatMap(item => item.relevantIds))].sort()
    expect(corpus.documents.map(doc => doc.id).sort()).toEqual(labels)
    const queries = new Set(MEMORY_RETRIEVAL_EVALUATION_CASES.map(item => item.query))
    for (const doc of corpus.documents) {
      expect(queries.has(doc.zh) || queries.has(doc.en)).toBe(false)
      expect(doc.zh).not.toContain(doc.id)
      expect(doc.en).not.toContain(doc.id)
      expect(doc.zh).toMatch(/[\u4e00-\u9fff]/)
      expect(doc.en).not.toMatch(/[\u4e00-\u9fff]/)
    }
  })
  it('bounds the unchanged query normalizer and both full corpus migrations', () => {
    const queries = MEMORY_RETRIEVAL_EVALUATION_CASES.flatMap(item => {
      const normalized = normalizeMemoryRetrievalQuery(item.query)
      return normalized && normalized !== item.query.trim() ? [item.query, normalized] : [item.query]
    })
    // One configuration dimension probe per independent engine, plus each document.
    expect(queries.length + 2 * (corpus.documents.length + 1)).toBeLessThanOrEqual(plan.limits.maximumEmbeddingRequests)
    expect(queries.join('').length + corpus.documents.map(doc => doc.zh + doc.en).join('').length + 1000)
      .toBeLessThan(plan.limits.maximumEmbeddingInputCharacters)
  })
  it('refuses a model call or replay under the vector-only grant', () => {
    let charged = 0
    const budget = createContinuityProbeBudget(plan.limits, units => { charged += units })
    expect(() => budget.model('chat', 100, 'work')).toThrow('MODEL_REQUESTS_EXHAUSTED')
    budget.embedding('query:1', '合成问题')
    const before = charged
    expect(() => budget.embedding('query:1', '合成问题')).toThrow('REPLAYED_ADMISSION')
    expect(charged).toBe(before)
    expect(budget.view().modelRequests).toBe(0)
  })
})

// Include the Electron-only fixture in the normal TypeScript graph without loading native addons in Vitest.
export type RetrievalQualityReport = Awaited<ReturnType<typeof runMemoryRetrievalQuality>>
export type StoriesQualityReport = Awaited<ReturnType<typeof runMemoryStoriesQuality>>
