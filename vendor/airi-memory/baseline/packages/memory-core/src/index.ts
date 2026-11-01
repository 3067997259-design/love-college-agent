export { calculateMemoryDecay, calculateMemoryTimeRelevance } from './decay'
export { canTransitionDreamIdea, selectDreamSourceFragments } from './dream'
export { emotionToMood } from './emotion'
export {
  CHINESE_MEMORY_EVALUATION_CASES,
  evaluateMemoryRetrieval,
  MEMORY_RETRIEVAL_EVALUATION_CASES,
  rankMemoryCandidates,
} from './evaluation'
export type {
  MemoryEvaluationCandidate,
  MemoryEvaluationCase,
  MemoryEvaluationMetrics,
} from './evaluation'
export { memoryEventToExtraction } from './events'
export { parseMemoryTurnExtractions } from './extraction'
export { promoteMemory, shouldPromoteMemory } from './promotion'
export { normalizeMemoryRetrievalQuery } from './query-normalization'
export {
  calculateIntrusionProbability,
  DEFAULT_INTRUSION_BASE_RATE,
  DEFAULT_INTRUSION_COOLDOWN_MS,
  isActionableMemoryFragment,
  isIntrusiveMemoryCandidate,
  matchesMuscleMemory,
  selectIntrusiveMemory,
} from './reflex'
export { calculateMemoryScore, scoreMemoryFragment } from './score'
export { parseMemorySourceContext } from './source-context'
export {
  DEFAULT_MEMORY_HALF_LIFE_HOURS,
  DEFAULT_MEMORY_SCORE_WEIGHTS,
  DEFAULT_MEMORY_SIMILARITY_THRESHOLD,
} from './types'
export type {
  MemoryCategory,
  MemoryDreamIdea,
  MemoryDreamIdeaStatus,
  MemoryEmbeddingInputType,
  MemoryEmbeddingMetadata,
  MemoryEmbeddingQueryMetadata,
  MemoryEmbeddingStatus,
  MemoryExtraction,
  MemoryFactStatus,
  MemoryFragment,
  MemoryMood,
  MemoryRepository,
  MemoryReviewStatus,
  MemoryScope,
  MemoryScoreWeights,
  MemorySourceContext,
  MemorySubscriptionEvent,
  MemorySubscriptionEventType,
  MemoryType,
  ScoredMemoryFragment,
} from './types'
export { isMemoryScopeVisible, isSameMemoryScope } from './types'
