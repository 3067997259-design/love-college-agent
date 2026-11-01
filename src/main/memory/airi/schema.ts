// Adapted from AIRI (MIT). Pinned source and modifications: vendor/airi-memory/README.md
// Upstream: packages/stage-ui/src/composables/use-duck-db.ts
import type { MemoryDbExecutor } from './repository/interaction-repository'

export async function initializeMemorySchema(db: MemoryDbExecutor): Promise<void> {
  await db.execute(`
    CREATE TABLE IF NOT EXISTS memory_fragments (
      id VARCHAR PRIMARY KEY,
      content VARCHAR NOT NULL,
      memory_type VARCHAR NOT NULL,
      category VARCHAR NOT NULL,
      importance INTEGER NOT NULL DEFAULT 5,
      emotional_impact INTEGER NOT NULL DEFAULT 0,
      valence DOUBLE NOT NULL DEFAULT 0,
      arousal DOUBLE NOT NULL DEFAULT 0,
      half_life_hours DOUBLE NOT NULL DEFAULT 24,
      session_ids_json VARCHAR NOT NULL DEFAULT '[]',
      trigger_pattern VARCHAR,
      last_intruded_at BIGINT,
      created_at BIGINT NOT NULL,
      last_accessed BIGINT NOT NULL,
      access_count INTEGER NOT NULL DEFAULT 1,
      content_vector_768 FLOAT[768],
      content_vector_1024 FLOAT[1024],
      content_vector_1536 FLOAT[1536],
      source_context_json VARCHAR NOT NULL DEFAULT '{}',
      review_status VARCHAR NOT NULL DEFAULT 'pending',
      fact_status VARCHAR NOT NULL DEFAULT 'active',
      supersedes_id VARCHAR,
      conflict_group VARCHAR,
      origin_id VARCHAR,
      scope_json VARCHAR NOT NULL DEFAULT '{}',
      deleted_at BIGINT,
      embedding_provider VARCHAR,
      embedding_model VARCHAR,
      embedding_dimensions INTEGER,
      embedding_input_type VARCHAR,
      embedding_source_fingerprint VARCHAR,
      embedded_at BIGINT,
      embedding_status VARCHAR
    )
  `)
  await db.execute(`
    ALTER TABLE memory_fragments
    ADD COLUMN IF NOT EXISTS source_context_json VARCHAR
  `)
  await db.execute(`
    UPDATE memory_fragments
    SET source_context_json = '{}'
    WHERE source_context_json IS NULL
  `)
  await db.execute(`
    ALTER TABLE memory_fragments
    ADD COLUMN IF NOT EXISTS review_status VARCHAR
  `)
  // Existing rows predate the review gate and remain approved. New
  // repository inserts use pending when a caller omits status. DuckDB
  // cannot add a constrained column, so the migration backfills it.
  await db.execute(`
    UPDATE memory_fragments
    SET review_status = 'approved'
    WHERE review_status IS NULL
  `)
  await db.execute(`
    ALTER TABLE memory_fragments
    ADD COLUMN IF NOT EXISTS fact_status VARCHAR
  `)
  await db.execute(`
    UPDATE memory_fragments
    SET fact_status = 'active'
    WHERE fact_status IS NULL
  `)
  await db.execute(`
    ALTER TABLE memory_fragments
    ADD COLUMN IF NOT EXISTS supersedes_id VARCHAR
  `)
  await db.execute(`
    ALTER TABLE memory_fragments
    ADD COLUMN IF NOT EXISTS conflict_group VARCHAR
  `)
  await db.execute(`
    ALTER TABLE memory_fragments
    ADD COLUMN IF NOT EXISTS origin_id VARCHAR
  `)
  await db.execute(`
    ALTER TABLE memory_fragments
    ADD COLUMN IF NOT EXISTS scope_json VARCHAR
  `)
  await db.execute(`
    UPDATE memory_fragments
    SET scope_json = '{}'
    WHERE scope_json IS NULL
  `)
  // Embeddings live in a JSON column so the vector space can change
  // between embedding models (768/1024/1536) without schema churn;
  // similarity is computed against rows of the matching dimension.
  await db.execute(`
    ALTER TABLE memory_fragments
    ADD COLUMN IF NOT EXISTS content_vector_json VARCHAR
  `)
  await db.execute(`
    ALTER TABLE memory_fragments
    ADD COLUMN IF NOT EXISTS content_vector_1024 FLOAT[1024]
  `)
  await db.execute(`
    ALTER TABLE memory_fragments
    ADD COLUMN IF NOT EXISTS content_vector_1536 FLOAT[1536]
  `)
  await db.execute(`
    ALTER TABLE memory_fragments
    ADD COLUMN IF NOT EXISTS embedding_provider VARCHAR
  `)
  await db.execute(`
    ALTER TABLE memory_fragments
    ADD COLUMN IF NOT EXISTS embedding_model VARCHAR
  `)
  await db.execute(`
    ALTER TABLE memory_fragments
    ADD COLUMN IF NOT EXISTS embedding_dimensions INTEGER
  `)
  await db.execute(`
    ALTER TABLE memory_fragments
    ADD COLUMN IF NOT EXISTS embedding_input_type VARCHAR
  `)
  await db.execute(`
    ALTER TABLE memory_fragments
    ADD COLUMN IF NOT EXISTS embedding_source_fingerprint VARCHAR
  `)
  await db.execute(`
    ALTER TABLE memory_fragments
    ADD COLUMN IF NOT EXISTS embedded_at BIGINT
  `)
  await db.execute(`
    ALTER TABLE memory_fragments
    ADD COLUMN IF NOT EXISTS embedding_status VARCHAR
  `)
  // MI-2 adds presentation without rewriting bodies, approval, or vectors.
  // Explicit defaults also apply when an older snapshot restores by name.
  for (const column of ['title VARCHAR DEFAULT \'\'', 'summary VARCHAR DEFAULT \'\'', 'revision BIGINT DEFAULT 1', 'summary_revision BIGINT DEFAULT 0', 'pinned BOOLEAN DEFAULT FALSE', 'pin_order BIGINT DEFAULT 0'])
    await db.execute(`ALTER TABLE memory_fragments ADD COLUMN IF NOT EXISTS ${column}`)
  await db.execute(`CREATE TABLE IF NOT EXISTS memory_operations (
    operation_id VARCHAR PRIMARY KEY, user_id VARCHAR NOT NULL, character_id VARCHAR NOT NULL,
    session_id VARCHAR NOT NULL, created_at BIGINT NOT NULL, operation_json VARCHAR NOT NULL
  )`)
  await db.execute(`
    CREATE TABLE IF NOT EXISTS memory_tags (
      id VARCHAR PRIMARY KEY,
      memory_id VARCHAR NOT NULL,
      tag VARCHAR NOT NULL,
      created_at BIGINT NOT NULL,
      deleted_at BIGINT
    )
  `)
  await db.execute(`
    CREATE TABLE IF NOT EXISTS memory_episodic (
      id VARCHAR PRIMARY KEY,
      memory_id VARCHAR NOT NULL,
      event_type VARCHAR NOT NULL,
      participants VARCHAR NOT NULL DEFAULT '[]',
      location VARCHAR NOT NULL DEFAULT '',
      created_at BIGINT NOT NULL,
      deleted_at BIGINT
    )
  `)
  await db.execute(`
    CREATE TABLE IF NOT EXISTS memory_long_term_goals (
      id VARCHAR PRIMARY KEY,
      session_id VARCHAR,
      title VARCHAR NOT NULL,
      description VARCHAR NOT NULL,
      priority INTEGER NOT NULL DEFAULT 5,
      progress INTEGER NOT NULL DEFAULT 0,
      deadline BIGINT,
      status VARCHAR NOT NULL DEFAULT 'planned',
      parent_goal_id VARCHAR,
      category VARCHAR NOT NULL DEFAULT 'personal',
      created_at BIGINT NOT NULL,
      updated_at BIGINT NOT NULL,
      deleted_at BIGINT
    )
  `)
  await db.execute(`
    ALTER TABLE memory_long_term_goals
    ADD COLUMN IF NOT EXISTS spec_json VARCHAR
  `)
  await db.execute(`
    ALTER TABLE memory_long_term_goals
    ADD COLUMN IF NOT EXISTS state_json VARCHAR
  `)
  await db.execute(`
    ALTER TABLE memory_long_term_goals
    ADD COLUMN IF NOT EXISTS horizon VARCHAR
  `)
  await db.execute(`
    ALTER TABLE memory_long_term_goals
    ADD COLUMN IF NOT EXISTS session_id VARCHAR
  `)
  await db.execute(`
    CREATE TABLE IF NOT EXISTS memory_short_term_ideas (
      id VARCHAR PRIMARY KEY,
      content VARCHAR NOT NULL,
      source_type VARCHAR NOT NULL DEFAULT 'dream',
      source_id VARCHAR,
      status VARCHAR NOT NULL DEFAULT 'new',
      excitement INTEGER NOT NULL DEFAULT 5,
      created_at BIGINT NOT NULL,
      updated_at BIGINT NOT NULL,
      content_vector_768 FLOAT[768],
      deleted_at BIGINT
    )
  `)
  await db.execute(`
    ALTER TABLE memory_short_term_ideas
    ADD COLUMN IF NOT EXISTS content_vector_json VARCHAR
  `)
  // Existing ideas retain unknown ownership; never assign them to the
  // character that happens to open this database during migration.
  await db.execute(`ALTER TABLE memory_short_term_ideas ADD COLUMN IF NOT EXISTS scope_json VARCHAR`)
}
