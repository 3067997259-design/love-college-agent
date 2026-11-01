// Adapted from AIRI (MIT). Pinned source and modifications: vendor/airi-memory/README.md
// Upstream: packages/stage-ui/src/services/memory/local-memory.ts
import { randomUUID } from 'node:crypto'
import { systemClock, type Clock } from '../../../clock'
import type { MemoryDreamIdea, MemoryDreamIdeaStatus, MemoryEmbeddingMetadata, MemoryEmbeddingQueryMetadata, MemoryFragment, MemoryMood, MemoryOperation, MemoryRepository, MemoryReviewStatus, MemoryScope, MemoryScoreWeights, ScoredMemoryFragment } from '../core/index'

import type { MemoryDbExecutor, MemoryDbTransaction, MemoryInteractionRepository } from './interaction-repository'

import { DEFAULT_MEMORY_SIMILARITY_THRESHOLD, isMemoryScopeVisible, parseMemorySourceContext, scoreMemoryFragment, shouldPromoteMemory } from '../core/index'

import { parseMemoryOperation } from './interaction-repository'

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
    title: stringValue(row.title),
    summary: stringValue(row.summary),
    revision: numberValue(row.revision, 1),
    summaryRevision: numberValue(row.summary_revision),
    pinned: row.pinned === true,
    pinOrder: numberValue(row.pin_order),
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

/** Creates the browser DuckDB fallback for the storage-neutral memory contract. */
export function createDuckDbMemoryRepository(db: MemoryDbExecutor, runTransaction?: MemoryDbTransaction, clock: Pick<Clock, 'nowMs'> = systemClock): MemoryInteractionRepository {
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
        embedding_source_fingerprint, embedded_at, embedding_status, title, summary, revision, summary_revision, pinned, pin_order
      FROM memory_fragments
      WHERE deleted_at IS NULL
        AND (review_status IS NULL OR review_status = 'approved')
        AND (fact_status IS NULL OR fact_status = 'active')
        AND memory_type != 'muscle'
        ${metadataFilter}
    `)

    const now = input.now ?? clock.nowMs()
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
    const now = input.now ?? clock.nowMs()
    const id = randomUUID()
    const metadata = input.embedding
      ? input.embeddingMetadata ?? {
        embeddingProvider: 'unknown',
        embeddingModel: 'unknown',
        embeddingDimensions: input.embedding.length,
        embeddingInputType: 'document' as const,
        embeddingSourceFingerprint: 'unknown',
        embeddedAt: now,
        embeddingStatus: 'stale' as const,
      }
      : undefined
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
        embedding_provider, embedding_model, embedding_dimensions, embedding_input_type, embedding_source_fingerprint, embedded_at, embedding_status,
        title, summary, revision, summary_revision, pinned, pin_order
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
        ${input.embedding ? jsonLiteral(input.embedding) : 'NULL'}, ${jsonLiteral(input.sourceContext ?? {})},
        ${embeddingColumns(metadata)}, ${quote(input.title ?? '')}, ${quote(input.summary ?? '')},
        ${input.revision ?? 1}, ${input.summary ? input.summaryRevision ?? input.revision ?? 1 : 0}, ${input.pinned === true}, ${input.pinOrder ?? 0}
      )
    `)
    // Tags are required on the MemoryExtraction contract but model-authored
    // producers may omit them; the fragment row is already inserted at this
    // point, so failing here would leave the caller reporting an error for a
    // fragment that is actually persisted.
    for (const tag of input.tags ?? []) {
      await db.execute(`
        INSERT INTO memory_tags (id, memory_id, tag, created_at)
        VALUES (${quote(randomUUID())}, ${quote(id)}, ${quote(tag)}, ${now})
      `)
    }
    if (input.episodic) {
      await db.execute(`
        INSERT INTO memory_episodic (id, memory_id, event_type, participants, location, created_at)
        VALUES (
          ${quote(randomUUID())}, ${quote(id)}, ${quote(input.episodic.eventType)},
          ${jsonLiteral(input.episodic.participants)}, ${quote(input.episodic.location ?? '')}, ${now}
        )
      `)
    }

    return {
      id,
      content: input.content.trim(),
      title: input.title ?? '',
      summary: input.summary ?? '',
      revision: input.revision ?? 1,
      summaryRevision: input.summary ? input.summaryRevision ?? input.revision ?? 1 : 0,
      pinned: input.pinned === true,
      pinOrder: input.pinOrder ?? 0,
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
    const now = input.now ?? clock.nowMs()
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
    // Apply the same user/character visibility as isMemoryScopeVisible before
    // LIMIT. Newer rows from other scopes must not consume this scope's page.
    // Invalid or unowned scope JSON stays invisible, as in rowScope().
    const scopeFilter = input.scope
      ? `AND json_type(TRY_CAST(scope_json AS JSON), '$.userId') = 'VARCHAR'
        AND json_type(TRY_CAST(scope_json AS JSON), '$.characterId') = 'VARCHAR'
        AND json_extract_string(TRY_CAST(scope_json AS JSON), '$.userId') IN (${[input.scope.userId, ...input.linkedUserIds ?? []].map(quote).join(', ')})
        AND json_extract_string(TRY_CAST(scope_json AS JSON), '$.characterId') = ${quote(input.scope.characterId)}`
      : ''
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
        embedding_source_fingerprint, embedded_at, embedding_status, title, summary, revision, summary_revision, pinned, pin_order
      FROM memory_fragments
      WHERE deleted_at IS NULL ${typeFilter} ${statusFilter} ${shareableFilter} ${scopeFilter}
      ORDER BY last_accessed DESC
      LIMIT ${input.limit ?? 100}
    `)
    return rowsFromResult(result)
      .map(rowToFragment)
      .filter(fragment => !input.scope || isMemoryScopeVisible(fragment.scope, input.scope, input.linkedUserIds ?? []))
  }

  async function update(id: string, patch: Parameters<MemoryRepository['update']>[1]): Promise<MemoryFragment | undefined> {
    const assignments: string[] = []
    if (patch.title !== undefined)
      assignments.push(`title = ${quote(patch.title)}`)
    if (patch.summary !== undefined)
      assignments.push(`summary = ${quote(patch.summary)}`)
    if (patch.summaryRevision !== undefined)
      assignments.push(`summary_revision = ${numberValue(patch.summaryRevision)}`)
    if (patch.pinned !== undefined)
      assignments.push(`pinned = ${patch.pinned === true}`)
    if (patch.pinOrder !== undefined)
      assignments.push(`pin_order = ${numberValue(patch.pinOrder)}`)
    if (patch.revision !== undefined) {
      assignments.push(`revision = ${numberValue(patch.revision, 1)}`)
    }
    else if (patch.content !== undefined || patch.reviewStatus !== undefined || patch.factStatus !== undefined || patch.title !== undefined || patch.summary !== undefined) {
      assignments.push('revision = revision + 1')
      // Content edits invalidate old summaries. Review-only changes preserve
      // a summary already approved with that same body.
      if (patch.summaryRevision === undefined)
        assignments.push(patch.content !== undefined && patch.summary === undefined ? 'summary_revision = 0' : 'summary_revision = CASE WHEN summary_revision = revision THEN revision + 1 ELSE summary_revision END')
    }
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
    await db.execute(`UPDATE memory_fragments SET deleted_at = ${clock.nowMs()} WHERE id = ${quote(id)} AND deleted_at IS NULL`)
  }

  async function addDreamIdea(input: Parameters<MemoryRepository['addDreamIdea']>[0]): Promise<MemoryDreamIdea> {
    const content = input.content.trim()
    if (!content)
      throw new Error('Dream ideas must not be empty')
    const now = input.now ?? clock.nowMs()
    const id = randomUUID()
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
      assignments.push(`updated_at = ${clock.nowMs()}`)
      await db.execute(`UPDATE memory_short_term_ideas SET ${assignments.join(', ')} WHERE id = ${quote(id)} AND deleted_at IS NULL`)
    }
    return (await listDreamIdeas({ limit: 10_000 })).find(idea => idea.id === id)
  }

  async function get(id: string): Promise<MemoryFragment | undefined> {
    const [row] = rowsFromResult(await db.execute(`SELECT * FROM memory_fragments WHERE id = ${quote(id)} AND deleted_at IS NULL`))
    return row ? rowToFragment(row) : undefined
  }

  async function directory(scope: MemoryScope, linkedUserIds: readonly string[] = []): Promise<MemoryFragment[]> {
    const users = [scope.userId, ...linkedUserIds].map(quote).join(', ')
    const rows = rowsFromResult(await db.execute(`SELECT * FROM memory_fragments
      WHERE deleted_at IS NULL AND pinned = TRUE AND review_status = 'approved' AND fact_status = 'active'
      AND memory_type IN ('short_term', 'long_term')
      AND json_extract_string(scope_json, '$.userId') IN (${users})
      AND json_extract_string(scope_json, '$.characterId') = ${quote(scope.characterId)}
      ORDER BY pin_order, id`))
    return rows.map(rowToFragment)
  }

  async function operation(operationId: string): Promise<MemoryOperation | undefined> {
    const [row] = rowsFromResult(await db.execute(`SELECT operation_json FROM memory_operations WHERE operation_id = ${quote(operationId)}`))
    // The transaction owner is the only writer. Restore validates this table
    // before it can become active in an isolated profile.
    return row ? parseMemoryOperation(JSON.parse(stringValue(row.operation_json))) : undefined
  }

  async function operations(scope: MemoryScope, sessionId?: string): Promise<MemoryOperation[]> {
    const rows = rowsFromResult(await db.execute(`SELECT operation_json FROM memory_operations
      WHERE user_id = ${quote(scope.userId)} AND character_id = ${quote(scope.characterId)}
      ${sessionId ? `AND session_id = ${quote(sessionId)}` : ''} ORDER BY created_at DESC`))
    return rows.map(row => parseMemoryOperation(JSON.parse(stringValue(row.operation_json))))
  }

  async function operationForFragment(fragmentId: string): Promise<MemoryOperation | undefined> {
    const [row] = rowsFromResult(await db.execute(`SELECT operation_json FROM memory_operations WHERE json_extract_string(operation_json, '$.fragmentId') = ${quote(fragmentId)}`))
    return row ? parseMemoryOperation(JSON.parse(stringValue(row.operation_json))) : undefined
  }

  async function sourceOperations(scope: MemoryScope, sessionId: string, messageId: string): Promise<MemoryOperation[]> {
    // A later conversation can correct or forget an earlier fact. Its
    // durable receipt still covers that target's original source, including
    // soft-deleted targets. Both branches retain the same user and character.
    const rows = rowsFromResult(await db.execute(`SELECT operation.operation_json FROM memory_operations operation
      LEFT JOIN memory_fragments target ON target.id = json_extract_string(operation.operation_json, '$.proposal.targetId')
      WHERE operation.user_id = ${quote(scope.userId)} AND operation.character_id = ${quote(scope.characterId)}
      AND (
        (operation.session_id = ${quote(sessionId)} AND json_extract_string(operation.operation_json, '$.sourceContext.messageId') = ${quote(messageId)})
        OR (
          json_extract_string(target.scope_json, '$.userId') = ${quote(scope.userId)}
          AND json_extract_string(target.scope_json, '$.characterId') = ${quote(scope.characterId)}
          AND json_extract_string(target.source_context_json, '$.sessionId') = ${quote(sessionId)}
          AND json_extract_string(target.source_context_json, '$.messageId') = ${quote(messageId)}
        )
      )`))
    return rows.map(row => parseMemoryOperation(JSON.parse(stringValue(row.operation_json))))
  }

  async function sourceFacts(scope: MemoryScope, sessionId: string, messageId: string): Promise<MemoryFragment[]> {
    // Native review and deletion predate tool receipts. Keep their original
    // bodies available only to same-source suppression, including tombstones.
    // Ordinary pending extractions are excluded so this batch's own inserts
    // cannot invalidate the other independent candidates in that batch.
    const rows = rowsFromResult(await db.execute(`SELECT * FROM memory_fragments
      WHERE json_extract_string(scope_json, '$.userId') = ${quote(scope.userId)}
        AND json_extract_string(scope_json, '$.characterId') = ${quote(scope.characterId)}
        AND json_extract_string(source_context_json, '$.sessionId') = ${quote(sessionId)}
        AND json_extract_string(source_context_json, '$.messageId') = ${quote(messageId)}
        AND memory_type IN ('short_term', 'long_term')
        AND (review_status IN ('approved', 'rejected') OR fact_status IN ('superseded', 'disputed')
          OR deleted_at IS NOT NULL OR supersedes_id IS NOT NULL)
      ORDER BY id`))
    return rows.map(rowToFragment)
  }

  async function pendingMirrorOperations(): Promise<MemoryOperation[]> {
    const rows = rowsFromResult(await db.execute(`SELECT operation_json FROM memory_operations
      WHERE json_extract_string(operation_json, '$.mirrorPending') = 'true' ORDER BY created_at`))
    return rows.map(row => parseMemoryOperation(JSON.parse(stringValue(row.operation_json))))
  }

  async function saveOperation(value: MemoryOperation): Promise<void> {
    await db.execute(`INSERT INTO memory_operations (operation_id, user_id, character_id, session_id, created_at, operation_json)
      VALUES (${quote(value.operationId)}, ${quote(value.scope.userId)}, ${quote(value.scope.characterId)}, ${quote(value.sessionId)}, ${value.createdAt}, ${jsonLiteral(value)})
      ON CONFLICT (operation_id) DO UPDATE SET operation_json = excluded.operation_json`)
  }

  async function updateEmbedding(id: string, revision: number, vector: number[], metadata: MemoryEmbeddingMetadata): Promise<void> {
    await db.execute(`UPDATE memory_fragments SET content_vector_json = ${jsonLiteral(vector)},
      embedding_provider = ${quote(metadata.embeddingProvider)}, embedding_model = ${quote(metadata.embeddingModel)},
      embedding_dimensions = ${metadata.embeddingDimensions}, embedding_input_type = ${quote(metadata.embeddingInputType)},
      embedding_source_fingerprint = ${quote(metadata.embeddingSourceFingerprint)}, embedded_at = ${metadata.embeddedAt}, embedding_status = ${quote(metadata.embeddingStatus)}
      WHERE id = ${quote(id)} AND revision = ${revision} AND deleted_at IS NULL`)
  }

  async function transaction<T>(action: (repository: MemoryInteractionRepository) => Promise<T>): Promise<T> {
    if (!runTransaction)
      throw new Error('Memory interaction requires the database transaction owner')
    return runTransaction(executor => action(createDuckDbMemoryRepository(executor, undefined, clock)))
  }

  return {
    get,
    directory,
    operation,
    operationForFragment,
    sourceOperations,
    sourceFacts,
    pendingMirrorOperations,
    operations,
    saveOperation,
    updateEmbedding,
    transaction,
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
  }
}
