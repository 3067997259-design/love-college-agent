import type { LongGoalRunRecord, LongGoalTransitionRecord, PlanSpec, PlanState, PlanStepStatus } from '@proj-airi/core-agent'
import type { MemoryDreamIdea, MemoryDreamIdeaStatus, MemoryEmbeddingMetadata, MemoryEmbeddingQueryMetadata, MemoryFragment, MemoryMood, MemoryRepository, MemoryReviewStatus, MemoryScope, MemoryScoreWeights, ScoredMemoryFragment } from '@proj-airi/memory-core'

import { DEFAULT_MEMORY_SIMILARITY_THRESHOLD, isMemoryScopeVisible, parseMemorySourceContext, scoreMemoryFragment, shouldPromoteMemory } from '@proj-airi/memory-core'

interface MemoryDbExecutor {
  execute: (query: string) => Promise<unknown>
}

type MemoryRow = Record<string, unknown>

function isRecord(value: unknown): value is MemoryRow {
  return typeof value === 'object' && value !== null
}

function rowsFromResult(result: unknown): MemoryRow[] {
  if (Array.isArray(result))
    return result.filter(isRecord)

  if (!isRecord(result) || !('toArray' in result) || typeof result.toArray !== 'function')
    return []

  const rows = result.toArray()
  return Array.isArray(rows) ? rows.filter(isRecord) : []
}

function stringValue(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

function numberValue(value: unknown, fallback = 0): number {
  if (typeof value === 'number' && Number.isFinite(value))
    return value
  if (typeof value === 'bigint')
    return Number(value)
  return fallback
}

function quote(value: string): string {
  return `'${value.replaceAll('\'', '\'\'')}'`
}

function jsonLiteral(value: unknown): string {
  return quote(JSON.stringify(value))
}

function parseJson(value: unknown): unknown {
  if (typeof value !== 'string')
    return value

  try {
    return JSON.parse(value) as unknown
  }
  catch {
    return undefined
  }
}

function rowScope(row: MemoryRow): MemoryScope | undefined {
  const parsed = parseJson(row.scope_json)
  if (!isRecord(parsed) || typeof parsed.userId !== 'string' || typeof parsed.characterId !== 'string')
    return undefined
  return { userId: parsed.userId, characterId: parsed.characterId }
}

/** Reads the stored embedding of a row: the JSON column wins over legacy fixed-size columns. */
function readRowVector(row: MemoryRow): unknown {
  if (row.content_vector_json != null)
    return parseJson(row.content_vector_json)
  return row.content_vector_1024 ?? row.content_vector_1536 ?? row.content_vector_768
}

function rowEmbeddingMetadata(row: MemoryRow): MemoryEmbeddingMetadata | undefined {
  const provider = stringValue(row.embedding_provider)
  const model = stringValue(row.embedding_model)
  const dimensions = numberValue(row.embedding_dimensions)
  const inputType = stringValue(row.embedding_input_type)
  const fingerprint = stringValue(row.embedding_source_fingerprint)
  const embeddedAt = numberValue(row.embedded_at)
  const status = stringValue(row.embedding_status)
  if (!provider || !model || !dimensions || (inputType !== 'query' && inputType !== 'document') || !fingerprint || row.embedded_at == null || (status !== 'active' && status !== 'stale'))
    return undefined
  return {
    embeddingProvider: provider,
    embeddingModel: model,
    embeddingDimensions: dimensions,
    embeddingInputType: inputType,
    embeddingSourceFingerprint: fingerprint,
    embeddedAt,
    embeddingStatus: status === 'stale' ? 'stale' : 'active',
  }
}

function embeddingColumns(metadata: MemoryEmbeddingMetadata | undefined): string {
  if (!metadata)
    return 'NULL, NULL, NULL, NULL, NULL, NULL, NULL'
  return `${quote(metadata.embeddingProvider)}, ${quote(metadata.embeddingModel)}, ${metadata.embeddingDimensions}, ${quote(metadata.embeddingInputType)}, ${quote(metadata.embeddingSourceFingerprint)}, ${metadata.embeddedAt}, ${quote(metadata.embeddingStatus)}`
}

function cosineSimilarity(left: number[], right: number[]): number {
  let dot = 0
  let leftNorm = 0
  let rightNorm = 0
  const length = Math.min(left.length, right.length)
  for (let index = 0; index < length; index++) {
    dot += left[index]! * right[index]!
    leftNorm += left[index]! * left[index]!
    rightNorm += right[index]! * right[index]!
  }
  if (leftNorm === 0 || rightNorm === 0)
    return 0
  return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm))
}

function rowToFragment(row: MemoryRow): MemoryFragment {
  const sessionIds = stringValue(row.session_ids_json, '[]')
  let parsedSessionIds: string[] = []
  try {
    const parsed = JSON.parse(sessionIds) as unknown
    if (Array.isArray(parsed))
      parsedSessionIds = parsed.filter((value): value is string => typeof value === 'string')
  }
  catch {
    parsedSessionIds = []
  }

  const vector = readRowVector(row)
  const sourceContext = parseMemorySourceContext(parseJson(row.source_context_json))
  const scope = rowScope(row)
  const embeddingMetadata = rowEmbeddingMetadata(row)
  const reviewStatus = stringValue(row.review_status, '')
  const factStatus = stringValue(row.fact_status, '')
  return {
    id: stringValue(row.id),
    content: stringValue(row.content),
    memoryType: stringValue(row.memory_type) as MemoryFragment['memoryType'],
    category: stringValue(row.category),
    importance: numberValue(row.importance, 5),
    emotionalImpact: numberValue(row.emotional_impact),
    createdAt: numberValue(row.created_at),
    lastAccessed: numberValue(row.last_accessed),
    accessCount: numberValue(row.access_count, 1),
    valence: numberValue(row.valence),
    arousal: numberValue(row.arousal),
    halfLifeHours: numberValue(row.half_life_hours, 24),
    sessionIds: parsedSessionIds,
    triggerPattern: row.trigger_pattern == null ? null : stringValue(row.trigger_pattern),
    lastIntrudedAt: row.last_intruded_at == null ? null : numberValue(row.last_intruded_at),
    ...(reviewStatus ? { reviewStatus: reviewStatus as MemoryReviewStatus } : {}),
    ...(factStatus ? { factStatus: factStatus as MemoryFragment['factStatus'] } : {}),
    ...(row.supersedes_id == null ? {} : { supersedesId: stringValue(row.supersedes_id) }),
    ...(row.conflict_group == null ? {} : { conflictGroup: stringValue(row.conflict_group) }),
    ...(row.origin_id == null ? {} : { originId: stringValue(row.origin_id) }),
    ...(scope ? { scope } : {}),
    ...(embeddingMetadata),
    contentVector: Array.isArray(vector) ? vector.filter((value): value is number => typeof value === 'number') : undefined,
    ...(sourceContext ? { sourceContext } : {}),
  }
}

function rowToDreamIdea(row: MemoryRow): MemoryDreamIdea {
  const vector = readRowVector(row)
  return {
    scope: rowScope(row),
    id: stringValue(row.id),
    content: stringValue(row.content),
    sourceType: stringValue(row.source_type, 'dream'),
    sourceId: row.source_id == null ? null : stringValue(row.source_id),
    status: stringValue(row.status, 'new') as MemoryDreamIdeaStatus,
    excitement: numberValue(row.excitement, 5),
    createdAt: numberValue(row.created_at),
    updatedAt: numberValue(row.updated_at),
    contentVector: Array.isArray(vector) ? vector.filter((value): value is number => typeof value === 'number') : undefined,
  }
}

export interface PersistedPlanRecord {
  id: string
  spec: PlanSpec
  state: PlanState
  status: PlanStepStatus
  /** Origin chat session of a session-horizon plan; long goals are global. */
  sessionId?: string
  createdAt: number
  updatedAt: number
}

export interface PlanPersistenceRepository {
  savePlan: (plan: PersistedPlanRecord) => Promise<void>
  loadPlans: () => Promise<PersistedPlanRecord[]>
  softDeletePlan: (id: string, deletedAt?: number) => Promise<void>
}

export type DuckDbMemoryRepository = MemoryRepository & PlanPersistenceRepository

const PLAN_STATUSES = new Set<PlanStepStatus>(['pending', 'in_progress', 'completed', 'failed', 'skipped', 'blocked', 'paused', 'cancelled'])
const PLAN_LANES = new Set(['coding', 'desktop', 'browser_dom', 'terminal', 'human', 'mcp', 'websocket', 'conversation'])
const PLAN_EVIDENCE_SOURCES = new Set(['tool_result', 'verification_gate', 'human_approval'])
const PLAN_STATE_EVIDENCE_SOURCES = new Set(['tool_result', 'verification_gate', 'human_approval', 'runtime_trace'])

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string')
}

function isPlanSpec(value: unknown): value is PlanSpec {
  if (!isRecord(value) || typeof value.goal !== 'string' || (value.horizon !== 'session' && value.horizon !== 'long') || !Array.isArray(value.steps))
    return false
  if (value.deadline !== undefined && (typeof value.deadline !== 'number' || !Number.isFinite(value.deadline)))
    return false
  if (value.scope !== undefined && (!isRecord(value.scope) || typeof value.scope.userId !== 'string' || typeof value.scope.characterId !== 'string'))
    return false
  if (value.workspaceRoot !== undefined && typeof value.workspaceRoot !== 'string')
    return false
  return value.steps.every(step => isRecord(step)
    && typeof step.id === 'string'
    && typeof step.lane === 'string'
    && PLAN_LANES.has(step.lane)
    && typeof step.intent === 'string'
    && stringArray(step.allowedTools)
    && Array.isArray(step.expectedEvidence)
    && step.expectedEvidence.every(evidence => isRecord(evidence)
      && typeof evidence.source === 'string'
      && PLAN_EVIDENCE_SOURCES.has(evidence.source)
      && typeof evidence.description === 'string')
    && (step.riskLevel === 'low' || step.riskLevel === 'medium' || step.riskLevel === 'high')
    && typeof step.approvalRequired === 'boolean')
}

function isPlanState(value: unknown): value is PlanState {
  return isRecord(value)
    && (value.currentStepId === undefined || typeof value.currentStepId === 'string')
    && stringArray(value.completedSteps)
    && stringArray(value.failedSteps)
    && stringArray(value.skippedSteps)
    && stringArray(value.blockers)
    && Array.isArray(value.evidenceRefs)
    && value.evidenceRefs.every(evidence => isRecord(evidence)
      && typeof evidence.stepId === 'string'
      && typeof evidence.source === 'string'
      && PLAN_STATE_EVIDENCE_SOURCES.has(evidence.source)
      && typeof evidence.summary === 'string')
    && (value.lastReplanReason === undefined || typeof value.lastReplanReason === 'string')
    && (value.longGoal === undefined || isLongGoalState(value.longGoal))
}

function isLongGoalState(value: unknown): boolean {
  if (!isRecord(value)
    || !['executable', 'running', 'waiting-condition', 'waiting-user', 'paused', 'completed', 'cancelled', 'failed'].includes(String(value.lifecycle))
    || typeof value.constraintVersion !== 'number'
    || !Number.isInteger(value.constraintVersion)
    || value.constraintVersion < 1) {
    return false
  }
  if (value.nextReviewAt !== undefined && (typeof value.nextReviewAt !== 'number' || !Number.isFinite(value.nextReviewAt))) {
    return false
  }
  if (value.waitReason !== undefined && typeof value.waitReason !== 'string') {
    return false
  }
  if (value.lastEnvironment !== undefined && !isLongGoalEnvironmentSnapshot(value.lastEnvironment))
    return false
  if (value.pendingQuestion !== undefined && (!isRecord(value.pendingQuestion)
    || typeof value.pendingQuestion.requestId !== 'string'
    || typeof value.pendingQuestion.question !== 'string'
    || (value.pendingQuestion.choices !== undefined && !stringArray(value.pendingQuestion.choices))
    || typeof value.pendingQuestion.askedAt !== 'number'
    || !Number.isFinite(value.pendingQuestion.askedAt))) {
    return false
  }
  if (value.activeRun !== undefined && !isLongGoalRunRecord(value.activeRun))
    return false
  if (value.lastRun !== undefined && !isLongGoalRunRecord(value.lastRun))
    return false
  if (value.lastTransition !== undefined && !isLongGoalTransitionRecord(value.lastTransition))
    return false
  return true
}

function isLongGoalRunRecord(value: unknown): value is LongGoalRunRecord {
  return isRecord(value)
    && typeof value.taskId === 'string'
    && typeof value.flowId === 'string'
    && typeof value.sessionId === 'string'
    && typeof value.startedAt === 'number'
    && Number.isFinite(value.startedAt)
    && (value.endedAt === undefined || (typeof value.endedAt === 'number' && Number.isFinite(value.endedAt)))
    && (value.outcome === undefined || ['completed', 'blocked', 'failed', 'cancelled', 'budget', 'no-progress'].includes(String(value.outcome)))
}

function isLongGoalEnvironmentSnapshot(value: unknown): boolean {
  return isRecord(value)
    && typeof value.providerId === 'string'
    && typeof value.modelId === 'string'
    && typeof value.workspaceRoot === 'string'
    && stringArray(value.toolNames)
}

function isLongGoalTransitionRecord(value: unknown): value is LongGoalTransitionRecord {
  return isRecord(value)
    && ['executable', 'running', 'waiting-condition', 'waiting-user', 'paused', 'completed', 'cancelled', 'failed'].includes(String(value.lifecycle))
    && typeof value.reason === 'string'
    && ['user', 'scheduler', 'flow', 'system'].includes(String(value.source))
    && typeof value.constraintVersion === 'number'
    && Number.isInteger(value.constraintVersion)
    && value.constraintVersion >= 1
    && typeof value.timestamp === 'number'
    && Number.isFinite(value.timestamp)
    && (value.taskId === undefined || typeof value.taskId === 'string')
    && (value.flowId === undefined || typeof value.flowId === 'string')
}

function createId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
}

/** Creates the browser DuckDB fallback for the storage-neutral memory contract. */
export function createDuckDbMemoryRepository(db: MemoryDbExecutor): DuckDbMemoryRepository {
  async function search(input: {
    embedding: number[]
    now?: number
    mood?: MemoryMood
    limit?: number
    similarityThreshold?: number
    weights?: Partial<MemoryScoreWeights>
    embeddingMetadata?: MemoryEmbeddingQueryMetadata
    scope?: MemoryScope
    linkedUserIds?: string[]
  }): Promise<ScoredMemoryFragment[]> {
    const limit = input.limit ?? 3
    const threshold = input.similarityThreshold ?? DEFAULT_MEMORY_SIMILARITY_THRESHOLD
    // Ranking happens in JS, not SQL: the embedding space can change between
    // models (768/1024/1536), so the query compares against rows whose stored
    // vector has the same dimension as the query embedding and leaves rows
    // from other spaces alone until the space migration re-embeds them.
    const metadataFilter = input.embeddingMetadata
      ? `
        AND embedding_provider = ${quote(input.embeddingMetadata.embeddingProvider)}
        AND embedding_model = ${quote(input.embeddingMetadata.embeddingModel)}
        AND embedding_dimensions = ${input.embeddingMetadata.embeddingDimensions}
        AND embedding_input_type = 'document'
        AND embedding_source_fingerprint = ${quote(input.embeddingMetadata.embeddingSourceFingerprint)}
        AND embedding_status = 'active'
      `
      : ''
    const result = await db.execute(`
      SELECT id, content, memory_type, category, importance, emotional_impact,
        valence, arousal, half_life_hours, session_ids_json, trigger_pattern,
        last_intruded_at, created_at, last_accessed, access_count, review_status,
        fact_status, supersedes_id, conflict_group, origin_id, scope_json, content_vector_json,
        content_vector_768, content_vector_1024, content_vector_1536, source_context_json, embedding_provider,
        embedding_model, embedding_dimensions, embedding_input_type,
        embedding_source_fingerprint, embedded_at, embedding_status
      FROM memory_fragments
      WHERE deleted_at IS NULL
        AND (review_status IS NULL OR review_status = 'approved')
        AND (fact_status IS NULL OR fact_status = 'active')
        AND memory_type != 'muscle'
        ${metadataFilter}
    `)

    const now = input.now ?? Date.now()
    return rowsFromResult(result)
      .map(row => rowToFragment(row))
      .filter(fragment => !input.scope || isMemoryScopeVisible(fragment.scope, input.scope, input.linkedUserIds ?? []))
      .filter(fragment => !!fragment.contentVector && fragment.contentVector.length === input.embedding.length)
      .map((fragment) => {
        const similarity = cosineSimilarity(input.embedding, fragment.contentVector!)
        return scoreMemoryFragment({
          fragment,
          similarity,
          now,
          mood: input.mood,
          weights: input.weights,
        })
      })
      .filter(scored => scored.similarity > threshold)
      .sort((left, right) => right.score - left.score)
      .slice(0, limit)
  }

  async function insert(input: Parameters<MemoryRepository['insert']>[0]): Promise<MemoryFragment> {
    if (!input.embedding)
      throw new Error('Memory inserts require an embedding')

    const now = input.now ?? Date.now()
    const id = createId()
    const metadata = input.embeddingMetadata ?? {
      embeddingProvider: 'unknown',
      embeddingModel: 'unknown',
      embeddingDimensions: input.embedding.length,
      embeddingInputType: 'document' as const,
      embeddingSourceFingerprint: 'unknown',
      embeddedAt: now,
      embeddingStatus: 'stale' as const,
    }
    const triggerPattern = input.triggerPattern ?? null
    // Extraction inputs are model-authored JSON; a missing or non-finite mood
    // or importance value would otherwise interpolate a literal `NaN` into
    // the SQL and fail DuckDB's binder. numberValue defaults them to the same
    // neutral values rowToFragment reads back.
    const importance = Math.max(1, Math.min(10, numberValue(input.importance, 5)))
    const valence = Math.max(-1, Math.min(1, numberValue(input.valence)))
    const arousal = Math.max(0, Math.min(1, numberValue(input.arousal)))
    await db.execute(`
      INSERT INTO memory_fragments (
        id, content, memory_type, category, importance, emotional_impact,
        valence, arousal, half_life_hours, session_ids_json, trigger_pattern,
        created_at, last_accessed, access_count, review_status, fact_status, supersedes_id, conflict_group, origin_id, scope_json, content_vector_json, source_context_json,
        embedding_provider, embedding_model, embedding_dimensions, embedding_input_type, embedding_source_fingerprint, embedded_at, embedding_status
      ) VALUES (
        ${quote(id)}, ${quote(input.content.trim())}, ${quote(input.memoryType)},
        ${quote(input.category)}, ${importance}, 0,
        ${valence}, ${arousal},
        ${input.memoryType === 'muscle' ? 1e9 : input.halfLifeHours ?? 24}, ${jsonLiteral(input.sessionId ? [input.sessionId] : [])},
        ${triggerPattern == null ? 'NULL' : quote(triggerPattern)},
        ${now}, ${now}, 1, ${quote(input.reviewStatus ?? 'pending')}, ${quote(input.factStatus ?? 'active')},
        ${input.supersedesId == null ? 'NULL' : quote(input.supersedesId)},
        ${input.conflictGroup == null ? 'NULL' : quote(input.conflictGroup)},
        ${input.originId == null ? 'NULL' : quote(input.originId)},
        ${jsonLiteral(input.scope ?? {})},
        ${jsonLiteral(input.embedding)}, ${jsonLiteral(input.sourceContext ?? {})},
        ${embeddingColumns(metadata)}
      )
    `)
    // Tags are required on the MemoryExtraction contract but model-authored
    // producers may omit them; the fragment row is already inserted at this
    // point, so failing here would leave the caller reporting an error for a
    // fragment that is actually persisted.
    for (const tag of input.tags ?? []) {
      await db.execute(`
        INSERT INTO memory_tags (id, memory_id, tag, created_at)
        VALUES (${quote(createId())}, ${quote(id)}, ${quote(tag)}, ${now})
      `)
    }
    if (input.episodic) {
      await db.execute(`
        INSERT INTO memory_episodic (id, memory_id, event_type, participants, location, created_at)
        VALUES (
          ${quote(createId())}, ${quote(id)}, ${quote(input.episodic.eventType)},
          ${jsonLiteral(input.episodic.participants)}, ${quote(input.episodic.location ?? '')}, ${now}
        )
      `)
    }

    return {
      id,
      content: input.content.trim(),
      memoryType: input.memoryType,
      category: input.category,
      importance,
      emotionalImpact: 0,
      createdAt: now,
      lastAccessed: now,
      accessCount: 1,
      valence,
      arousal,
      halfLifeHours: input.memoryType === 'muscle' ? 1e9 : input.halfLifeHours ?? 24,
      sessionIds: input.sessionId ? [input.sessionId] : [],
      triggerPattern,
      lastIntrudedAt: null,
      reviewStatus: input.reviewStatus ?? 'pending',
      factStatus: input.factStatus ?? 'active',
      supersedesId: input.supersedesId ?? null,
      conflictGroup: input.conflictGroup ?? null,
      originId: input.originId ?? null,
      ...(input.scope ? { scope: input.scope } : {}),
      ...metadata,
      contentVector: input.embedding,
      ...(input.sourceContext ? { sourceContext: input.sourceContext } : {}),
    }
  }

  async function recordAccess(input: { memoryIds: string[], sessionId?: string, now?: number }): Promise<void> {
    const now = input.now ?? Date.now()
    for (const id of input.memoryIds) {
      const rows = rowsFromResult(await db.execute(`SELECT session_ids_json FROM memory_fragments WHERE id = ${quote(id)} AND deleted_at IS NULL`))
      const current = rows[0] ? rowToFragment({ id, ...rows[0] }).sessionIds : []
      const sessionIds = input.sessionId && !current.includes(input.sessionId) ? [...current, input.sessionId] : current
      await db.execute(`
        UPDATE memory_fragments
        SET access_count = access_count + 1,
            last_accessed = ${now},
            session_ids_json = ${jsonLiteral(sessionIds)}
        WHERE id = ${quote(id)} AND deleted_at IS NULL
      `)
    }
  }

  async function promoteEligible(input: { minAccessCount?: number, minSessionCount?: number, halfLifeHours?: number, scope?: MemoryScope } = {}): Promise<string[]> {
    const fragments = await list({ memoryType: 'short_term', limit: 10_000, scope: input.scope })
    const eligible = fragments.filter(fragment => fragment.factStatus !== 'superseded'
      && fragment.factStatus !== 'disputed'
      && shouldPromoteMemory(fragment, input))
    for (const fragment of eligible) {
      await db.execute(`
        UPDATE memory_fragments
        SET memory_type = 'long_term', half_life_hours = ${input.halfLifeHours ?? 4_320}
        WHERE id = ${quote(fragment.id)} AND deleted_at IS NULL
      `)
    }
    return eligible.map(fragment => fragment.id)
  }

  async function list(input: { memoryType?: MemoryFragment['memoryType'], reviewStatus?: MemoryReviewStatus, limit?: number, scope?: MemoryScope, shareable?: boolean, linkedUserIds?: string[] } = {}): Promise<MemoryFragment[]> {
    const typeFilter = input.memoryType ? `AND memory_type = ${quote(input.memoryType)}` : ''
    const statusFilter = input.reviewStatus ? `AND review_status = ${quote(input.reviewStatus)}` : ''
    // Social candidates are eligible facts with a usable source context. The
    // predicate runs in SQL so an old eligible fact outside a top-N page can
    // still surface (ACC-20260911 #12). NULL review/fact status counts as
    // actionable, matching `isActionableMemoryFragment`.
    const shareableFilter = input.shareable
      ? `
        AND (review_status IS NULL OR review_status = 'approved')
        AND (fact_status IS NULL OR fact_status = 'active')
        AND json_extract_string(source_context_json, '$.sourceType') IS NOT NULL
        AND (json_extract_string(source_context_json, '$.sourceEventId') IS NOT NULL
          OR json_extract_string(source_context_json, '$.messageId') IS NOT NULL)
      `
      : ''
    const result = await db.execute(`
      SELECT id, content, memory_type, category, importance, emotional_impact,
        valence, arousal, half_life_hours, session_ids_json, trigger_pattern,
        last_intruded_at, created_at, last_accessed, access_count, review_status,
        fact_status, supersedes_id, conflict_group, origin_id, scope_json, content_vector_json,
        content_vector_768, content_vector_1024, content_vector_1536, source_context_json, embedding_provider,
        embedding_model, embedding_dimensions, embedding_input_type,
        embedding_source_fingerprint, embedded_at, embedding_status
      FROM memory_fragments
      WHERE deleted_at IS NULL ${typeFilter} ${statusFilter} ${shareableFilter}
      ORDER BY last_accessed DESC
      LIMIT ${input.limit ?? 100}
    `)
    return rowsFromResult(result)
      .map(rowToFragment)
      .filter(fragment => !input.scope || isMemoryScopeVisible(fragment.scope, input.scope, input.linkedUserIds ?? []))
  }

  async function update(id: string, patch: Parameters<MemoryRepository['update']>[1]): Promise<MemoryFragment | undefined> {
    const assignments: string[] = []
    if (patch.content !== undefined)
      assignments.push(`content = ${quote(patch.content.trim())}`)
    if (patch.category !== undefined)
      assignments.push(`category = ${quote(patch.category)}`)
    if (patch.memoryType !== undefined)
      assignments.push(`memory_type = ${quote(patch.memoryType)}`)
    if (patch.halfLifeHours !== undefined)
      assignments.push(`half_life_hours = ${numberValue(patch.halfLifeHours, 24)}`)
    if (patch.importance !== undefined)
      assignments.push(`importance = ${Math.max(1, Math.min(10, patch.importance))}`)
    if (patch.valence !== undefined)
      assignments.push(`valence = ${Math.max(-1, Math.min(1, patch.valence))}`)
    if (patch.arousal !== undefined)
      assignments.push(`arousal = ${Math.max(0, Math.min(1, patch.arousal))}`)
    if (patch.triggerPattern !== undefined)
      assignments.push(`trigger_pattern = ${patch.triggerPattern == null ? 'NULL' : quote(patch.triggerPattern)}`)
    if (patch.lastIntrudedAt !== undefined)
      assignments.push(`last_intruded_at = ${patch.lastIntrudedAt == null ? 'NULL' : String(patch.lastIntrudedAt)}`)
    if (patch.reviewStatus !== undefined)
      assignments.push(`review_status = ${quote(patch.reviewStatus)}`)
    if (patch.factStatus !== undefined)
      assignments.push(`fact_status = ${quote(patch.factStatus)}`)
    if (patch.supersedesId !== undefined)
      assignments.push(`supersedes_id = ${patch.supersedesId == null ? 'NULL' : quote(patch.supersedesId)}`)
    if (patch.conflictGroup !== undefined)
      assignments.push(`conflict_group = ${patch.conflictGroup == null ? 'NULL' : quote(patch.conflictGroup)}`)
    if (patch.contentVector !== undefined)
      assignments.push(`content_vector_json = ${jsonLiteral(patch.contentVector)}`)
    if (patch.embeddingMetadata !== undefined) {
      const metadata = patch.embeddingMetadata
      if (metadata === null) {
        assignments.push('embedding_provider = NULL', 'embedding_model = NULL', 'embedding_dimensions = NULL', 'embedding_input_type = NULL', 'embedding_source_fingerprint = NULL', 'embedded_at = NULL', 'embedding_status = NULL')
      }
      else {
        assignments.push(`embedding_provider = ${quote(metadata.embeddingProvider)}`, `embedding_model = ${quote(metadata.embeddingModel)}`, `embedding_dimensions = ${metadata.embeddingDimensions}`, `embedding_input_type = ${quote(metadata.embeddingInputType)}`, `embedding_source_fingerprint = ${quote(metadata.embeddingSourceFingerprint)}`, `embedded_at = ${metadata.embeddedAt}`, `embedding_status = ${quote(metadata.embeddingStatus)}`)
      }
    }
    else if (patch.embeddingProvider !== undefined || patch.embeddingModel !== undefined || patch.embeddingDimensions !== undefined || patch.embeddingInputType !== undefined || patch.embeddingSourceFingerprint !== undefined || patch.embeddedAt !== undefined || patch.embeddingStatus !== undefined) {
      if (patch.embeddingProvider !== undefined)
        assignments.push(`embedding_provider = ${patch.embeddingProvider == null ? 'NULL' : quote(patch.embeddingProvider)}`)
      if (patch.embeddingModel !== undefined)
        assignments.push(`embedding_model = ${patch.embeddingModel == null ? 'NULL' : quote(patch.embeddingModel)}`)
      if (patch.embeddingDimensions !== undefined)
        assignments.push(`embedding_dimensions = ${patch.embeddingDimensions == null ? 'NULL' : String(patch.embeddingDimensions)}`)
      if (patch.embeddingInputType !== undefined)
        assignments.push(`embedding_input_type = ${patch.embeddingInputType == null ? 'NULL' : quote(patch.embeddingInputType)}`)
      if (patch.embeddingSourceFingerprint !== undefined)
        assignments.push(`embedding_source_fingerprint = ${patch.embeddingSourceFingerprint == null ? 'NULL' : quote(patch.embeddingSourceFingerprint)}`)
      if (patch.embeddedAt !== undefined)
        assignments.push(`embedded_at = ${patch.embeddedAt == null ? 'NULL' : String(patch.embeddedAt)}`)
      if (patch.embeddingStatus !== undefined)
        assignments.push(`embedding_status = ${patch.embeddingStatus == null ? 'NULL' : quote(patch.embeddingStatus)}`)
    }

    if (assignments.length === 0)
      return (await list({ limit: 10_000 })).find(fragment => fragment.id === id)

    await db.execute(`UPDATE memory_fragments SET ${assignments.join(', ')} WHERE id = ${quote(id)} AND deleted_at IS NULL`)
    return (await list({ limit: 10_000 })).find(fragment => fragment.id === id)
  }

  async function remove(id: string): Promise<void> {
    await db.execute(`UPDATE memory_fragments SET deleted_at = ${Date.now()} WHERE id = ${quote(id)} AND deleted_at IS NULL`)
  }

  async function addDreamIdea(input: Parameters<MemoryRepository['addDreamIdea']>[0]): Promise<MemoryDreamIdea> {
    const content = input.content.trim()
    if (!content)
      throw new Error('Dream ideas must not be empty')
    const now = input.now ?? Date.now()
    const id = createId()
    await db.execute(`
      INSERT INTO memory_short_term_ideas (
        id, content, source_type, source_id, status, excitement,
        created_at, updated_at, content_vector_json, scope_json
      ) VALUES (
        ${quote(id)}, ${quote(content)}, ${quote(input.sourceType ?? 'dream')},
        ${input.sourceId == null ? 'NULL' : quote(input.sourceId)},
        'new', ${Math.max(0, Math.min(10, input.excitement ?? 5))},
        ${now}, ${now}, ${input.embedding ? jsonLiteral(input.embedding) : 'NULL'}, ${input.scope ? jsonLiteral(input.scope) : 'NULL'}
      )
    `)
    return {
      id,
      content,
      sourceType: input.sourceType ?? 'dream',
      scope: input.scope ? { ...input.scope } : undefined,
      sourceId: input.sourceId ?? null,
      status: 'new',
      excitement: Math.max(0, Math.min(10, input.excitement ?? 5)),
      createdAt: now,
      updatedAt: now,
      ...(input.embedding ? { contentVector: input.embedding } : {}),
    }
  }

  async function listDreamIdeas(input: Parameters<MemoryRepository['listDreamIdeas']>[0] = {}): Promise<MemoryDreamIdea[]> {
    const statusFilter = input.status ? `AND status = ${quote(input.status)}` : ''
    const scopeFilter = input.scope
      ? `AND json_extract_string(scope_json, '$.userId') = ${quote(input.scope.userId)} AND json_extract_string(scope_json, '$.characterId') = ${quote(input.scope.characterId)}`
      : ''
    const result = await db.execute(`
      SELECT id, content, source_type, source_id, status, excitement,
        created_at, updated_at, content_vector_json, scope_json
      FROM memory_short_term_ideas
      WHERE deleted_at IS NULL ${statusFilter} ${scopeFilter}
      ORDER BY updated_at DESC
      LIMIT ${input.limit ?? 100}
    `)
    return rowsFromResult(result).map(rowToDreamIdea)
  }

  async function updateDreamIdea(id: string, patch: Partial<Pick<MemoryDreamIdea, 'content' | 'status' | 'excitement' | 'contentVector'>>): Promise<MemoryDreamIdea | undefined> {
    const assignments: string[] = []
    if (patch.content !== undefined) {
      const content = patch.content.trim()
      if (!content)
        throw new Error('Dream ideas must not be empty')
      assignments.push(`content = ${quote(content)}`)
    }
    if (patch.status !== undefined)
      assignments.push(`status = ${quote(patch.status)}`)
    if (patch.excitement !== undefined)
      assignments.push(`excitement = ${Math.max(0, Math.min(10, patch.excitement))}`)
    if (patch.contentVector !== undefined)
      assignments.push(`content_vector_json = ${jsonLiteral(patch.contentVector)}`)
    if (assignments.length > 0) {
      assignments.push(`updated_at = ${Date.now()}`)
      await db.execute(`UPDATE memory_short_term_ideas SET ${assignments.join(', ')} WHERE id = ${quote(id)} AND deleted_at IS NULL`)
    }
    return (await listDreamIdeas({ limit: 10_000 })).find(idea => idea.id === id)
  }

  async function savePlan(plan: PersistedPlanRecord): Promise<void> {
    const completedCurrentSteps = plan.spec.steps.filter(step => plan.state.completedSteps.includes(step.id)).length
    const progress = plan.spec.steps.length === 0 ? 0 : Math.round(completedCurrentSteps / plan.spec.steps.length * 100)
    const currentIntent = plan.spec.steps.find(step => step.id === plan.state.currentStepId)?.intent ?? plan.spec.goal
    await db.execute(`
      INSERT INTO memory_long_term_goals (
        id, title, description, priority, progress, deadline, status,
        parent_goal_id, category, created_at, updated_at, deleted_at,
        spec_json, state_json, horizon, session_id
      ) VALUES (
        ${quote(plan.id)}, ${quote(plan.spec.goal)}, ${quote(currentIntent)}, 5, ${progress},
        ${plan.spec.deadline ?? 'NULL'}, ${quote(plan.status)},
        NULL, 'plan', ${plan.createdAt}, ${plan.updatedAt}, NULL,
        ${jsonLiteral(plan.spec)}, ${jsonLiteral(plan.state)}, ${quote(plan.spec.horizon)},
        ${plan.sessionId ? quote(plan.sessionId) : 'NULL'}
      )
      ON CONFLICT (id) DO UPDATE SET
        title = excluded.title,
        description = excluded.description,
        progress = excluded.progress,
        deadline = excluded.deadline,
        status = excluded.status,
        updated_at = excluded.updated_at,
        deleted_at = NULL,
        spec_json = excluded.spec_json,
        state_json = excluded.state_json,
        horizon = excluded.horizon,
        session_id = excluded.session_id
    `)
  }

  async function loadPlans(): Promise<PersistedPlanRecord[]> {
    const result = await db.execute(`
      SELECT id, spec_json, state_json, status, created_at, updated_at, deadline, session_id
      FROM memory_long_term_goals
      WHERE category = 'plan' AND deleted_at IS NULL
      ORDER BY updated_at ASC
    `)
    return rowsFromResult(result).flatMap((row) => {
      const specValue = parseJson(row.spec_json)
      const stateValue = parseJson(row.state_json)
      if (!isPlanSpec(specValue) || !isPlanState(stateValue))
        return []
      const deadline = row.deadline == null ? undefined : numberValue(row.deadline)
      const spec = deadline === undefined || specValue.deadline !== undefined
        ? specValue
        : { ...specValue, deadline }
      const statusValue = stringValue(row.status, 'pending')
      return [{
        id: stringValue(row.id),
        spec,
        state: stateValue,
        status: PLAN_STATUSES.has(statusValue as PlanStepStatus) ? statusValue as PlanStepStatus : 'pending',
        sessionId: stringValue(row.session_id) || undefined,
        createdAt: numberValue(row.created_at),
        updatedAt: numberValue(row.updated_at),
      }]
    })
  }

  async function softDeletePlan(id: string, deletedAt = Date.now()): Promise<void> {
    await db.execute(`UPDATE memory_long_term_goals SET deleted_at = ${deletedAt}, updated_at = ${deletedAt} WHERE id = ${quote(id)} AND category = 'plan' AND deleted_at IS NULL`)
  }

  return {
    search,
    insert,
    recordAccess,
    promoteEligible,
    list,
    update,
    remove,
    addDreamIdea,
    listDreamIdeas,
    updateDreamIdea,
    savePlan,
    loadPlans,
    softDeletePlan,
  }
}
