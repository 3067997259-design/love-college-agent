import { expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { MEMORY_RETRIEVAL_EVALUATION_CASES, rankMemoryCandidates } from '../../src/main/memory/airi/core/evaluation'
import { rankMemoryCandidates as upstreamRank } from '../../vendor/airi-memory/baseline/packages/memory-core/src/evaluation'
import stories from '../fixtures/continuity-stories.json'
import livePlan from '../../scripts/continuity-live-plan.json'

it('retains all 90 retrieval cases across nine strata and 24 independent story oracles', () => {
  expect(MEMORY_RETRIEVAL_EVALUATION_CASES).toHaveLength(90)
  expect(new Set(MEMORY_RETRIEVAL_EVALUATION_CASES.map(item => item.id)).size).toBe(90)
  expect(new Set(MEMORY_RETRIEVAL_EVALUATION_CASES.map(item => item.stratum)).size).toBe(9)
  expect(stories.stories).toHaveLength(24)
  expect(new Set(stories.stories.map(item => item.id)).size).toBe(24)
  expect(stories.stories.every(item => item.turns.length >= 3 && item.required.length && item.forbidden.length)).toBe(true)
})

it('replays fixed vectors through migrated and pinned upstream ranking for all 90 queries', () => {
  // Mechanical migration parity only, not semantic embedding/retrieval quality.
  // Vectors derive from text/IDs, never from relevance labels or expected ranks.
  const vector = (text: string) => [...createHash('sha256').update('lca-parity-v1:' + text).digest()].map(value => value / 127.5 - 1)
  const candidates = [...new Set(MEMORY_RETRIEVAL_EVALUATION_CASES.flatMap(item => item.relevantIds))].sort().map(id => ({ id, embedding: vector(id) }))
  for (const item of MEMORY_RETRIEVAL_EVALUATION_CASES) expect(rankMemoryCandidates(vector(item.query), candidates)).toEqual(upstreamRank(vector(item.query), candidates))
})

it('keeps next live batches explicit, bounded and separate from the closed provider grant', () => {
  expect(livePlan.authorization).toContain('required-per-batch')
  expect(livePlan.defaults.automaticRetry).toBe(false)
  expect(livePlan.defaults.oracleExcludedFromModelInput).toBe(true)
  expect(livePlan.batches.map(batch => batch.id)).toEqual(['world', 'work', 'memory'])
  for (const batch of livePlan.batches) {
    expect(batch.maximumModelRequests).toBeGreaterThan(0)
    expect(batch.maximumReservedUnits).toBeGreaterThan(batch.maximumAutonomousUnits)
    expect(batch.steps.length).toBeGreaterThan(2)
    expect(batch.oracle.length).toBeGreaterThan(1)
  }
})
