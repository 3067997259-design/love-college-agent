import { expect, it } from 'vitest'
import { MEMORY_RETRIEVAL_EVALUATION_CASES } from '../../src/main/memory/airi/core/evaluation'
import stories from '../fixtures/continuity-stories.json'

it('retains all 90 retrieval cases across nine strata and 24 independent story oracles', () => {
  expect(MEMORY_RETRIEVAL_EVALUATION_CASES).toHaveLength(90)
  expect(new Set(MEMORY_RETRIEVAL_EVALUATION_CASES.map(item => item.id)).size).toBe(90)
  expect(new Set(MEMORY_RETRIEVAL_EVALUATION_CASES.map(item => item.stratum)).size).toBe(9)
  expect(stories.stories).toHaveLength(24)
  expect(new Set(stories.stories.map(item => item.id)).size).toBe(24)
  expect(stories.stories.every(item => item.turns.length >= 3 && item.required.length && item.forbidden.length)).toBe(true)
})
