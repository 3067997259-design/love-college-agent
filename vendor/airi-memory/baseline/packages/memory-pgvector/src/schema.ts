import type { MemoryScope } from '@proj-airi/memory-core'

import { sql } from 'drizzle-orm'
import { bigint, index, integer, jsonb, pgTable, real, text, uniqueIndex, uuid, vector } from 'drizzle-orm/pg-core'

/** Postgres tables owned by the memory module. */
export const memoryFragmentsTable = pgTable('memory_fragments', {
  id: uuid().primaryKey().defaultRandom(),
  content: text().notNull(),
  memory_type: text().notNull(),
  category: text().notNull(),
  importance: integer().notNull().default(5),
  emotional_impact: integer().notNull().default(0),
  valence: real().notNull().default(0),
  arousal: real().notNull().default(0),
  half_life_hours: real().notNull().default(24),
  session_ids: jsonb().$type<string[]>().notNull().default([]),
  trigger_pattern: text(),
  last_intruded_at: bigint({ mode: 'number' }),
  review_status: text().notNull().default('pending'),
  fact_status: text().notNull().default('active'),
  supersedes_id: text(),
  conflict_group: text(),
  origin_id: text(),
  scope: jsonb().$type<MemoryScope>(),
  embedding_provider: text(),
  embedding_model: text(),
  embedding_dimensions: integer(),
  embedding_input_type: text(),
  embedding_source_fingerprint: text(),
  embedded_at: bigint({ mode: 'number' }),
  embedding_status: text(),
  created_at: bigint({ mode: 'number' }).notNull().default(0),
  last_accessed: bigint({ mode: 'number' }).notNull().default(0),
  access_count: integer().notNull().default(1),
  metadata: jsonb().$type<Record<string, unknown>>().notNull().default({}),
  content_vector_1536: vector({ dimensions: 1536 }),
  content_vector_1024: vector({ dimensions: 1024 }),
  content_vector_768: vector({ dimensions: 768 }),
  deleted_at: bigint({ mode: 'number' }),
}, table => [
  index('memory_items_content_vector_1536_index').using('hnsw', table.content_vector_1536.op('vector_cosine_ops')),
  index('memory_items_content_vector_1024_index').using('hnsw', table.content_vector_1024.op('vector_cosine_ops')),
  index('memory_items_content_vector_768_index').using('hnsw', table.content_vector_768.op('vector_cosine_ops')),
  index('memory_items_memory_type_index').on(table.memory_type),
  index('memory_items_category_index').on(table.category),
  index('memory_items_importance_index').on(table.importance),
  index('memory_items_created_at_index').on(table.created_at),
  index('memory_items_last_accessed_index').on(table.last_accessed),
  // Declared to mirror the authoritative DDL in `ensureMemorySchema`; the
  // insert conflict target repeats this predicate to infer the index.
  uniqueIndex('memory_items_origin_id_unique_index').on(table.origin_id).where(sql`${table.origin_id} IS NOT NULL AND ${table.deleted_at} IS NULL`),
])

export const memoryTagsTable = pgTable('memory_tags', {
  id: uuid().primaryKey().defaultRandom(),
  memory_id: uuid().notNull().references(() => memoryFragmentsTable.id, { onDelete: 'cascade' }),
  tag: text().notNull(),
  created_at: bigint({ mode: 'number' }).notNull().default(0),
  deleted_at: bigint({ mode: 'number' }),
}, table => [
  index('memory_tags_memory_id_index').on(table.memory_id),
  index('memory_tags_tag_index').on(table.tag),
])

export const memoryEpisodicTable = pgTable('memory_episodic', {
  id: uuid().primaryKey().defaultRandom(),
  memory_id: uuid().notNull().references(() => memoryFragmentsTable.id, { onDelete: 'cascade' }),
  event_type: text().notNull(),
  participants: jsonb().$type<string[]>().notNull().default([]),
  location: text().default(''),
  created_at: bigint({ mode: 'number' }).notNull().default(0),
  deleted_at: bigint({ mode: 'number' }),
}, table => [
  index('memory_episodic_memory_id_index').on(table.memory_id),
  index('memory_episodic_event_type_index').on(table.event_type),
])

export const memoryLongTermGoalsTable = pgTable('memory_long_term_goals', {
  id: uuid().primaryKey().defaultRandom(),
  title: text().notNull(),
  description: text().notNull(),
  priority: integer().notNull().default(5),
  progress: integer().notNull().default(0),
  deadline: bigint({ mode: 'number' }),
  status: text().notNull().default('planned'),
  parent_goal_id: uuid(),
  category: text().notNull().default('personal'),
  created_at: bigint({ mode: 'number' }).notNull().default(0),
  updated_at: bigint({ mode: 'number' }).notNull().default(0),
  deleted_at: bigint({ mode: 'number' }),
}, table => [
  index('memory_long_term_goals_priority_index').on(table.priority),
  index('memory_long_term_goals_status_index').on(table.status),
  index('memory_long_term_goals_deadline_index').on(table.deadline),
  index('memory_long_term_goals_parent_goal_id_index').on(table.parent_goal_id),
])

export const memoryShortTermIdeasTable = pgTable('memory_short_term_ideas', {
  id: uuid().primaryKey().defaultRandom(),
  content: text().notNull(),
  source_type: text().notNull().default('dream'),
  source_id: text(),
  status: text().notNull().default('new'),
  excitement: integer().notNull().default(5),
  created_at: bigint({ mode: 'number' }).notNull().default(0),
  updated_at: bigint({ mode: 'number' }).notNull().default(0),
  content_vector_1536: vector({ dimensions: 1536 }),
  content_vector_1024: vector({ dimensions: 1024 }),
  content_vector_768: vector({ dimensions: 768 }),
  deleted_at: bigint({ mode: 'number' }),
}, table => [
  index('memory_short_term_ideas_source_type_index').on(table.source_type),
  index('memory_short_term_ideas_status_index').on(table.status),
  index('memory_short_term_ideas_excitement_index').on(table.excitement),
  index('memory_short_term_ideas_content_vector_1536_index').using('hnsw', table.content_vector_1536.op('vector_cosine_ops')),
  index('memory_short_term_ideas_content_vector_1024_index').using('hnsw', table.content_vector_1024.op('vector_cosine_ops')),
  index('memory_short_term_ideas_content_vector_768_index').using('hnsw', table.content_vector_768.op('vector_cosine_ops')),
])

export const memorySchema = {
  memoryFragmentsTable,
  memoryTagsTable,
  memoryEpisodicTable,
  memoryLongTermGoalsTable,
  memoryShortTermIdeasTable,
}
