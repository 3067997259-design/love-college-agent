import type { DuckDBWasmDrizzleDatabase } from '@proj-airi/drizzle-duckdb-wasm'

import type { DataBackupEntry } from '../services/data-backup'

import { errorMessageFrom } from '@moeru/std'
import { DBStorageType, drizzle, DuckDBAccessMode } from '@proj-airi/drizzle-duckdb-wasm'
import { getImportUrlBundles } from '@proj-airi/drizzle-duckdb-wasm/bundles/import-url-browser'
import { Mutex } from 'async-mutex'
import { readonly, shallowRef } from 'vue'

import { resolveMemoryWriteAccess } from '../services/memory/write-access'

const db = shallowRef<DuckDBWasmDrizzleDatabase | null>(null)
const mutex = new Mutex()
const MEMORY_DATABASE_PATH = 'airi-memory.duckdb'
const SNAPSHOT_TABLES = ['memory_fragments', 'memory_tags', 'memory_episodic', 'memory_long_term_goals', 'memory_short_term_ideas'] as const

export interface DuckDbPersistenceStatus {
  state: 'idle' | 'checkpointing' | 'complete' | 'error'
  pendingWrites: number
  lastCheckpointAt?: number
  error?: string
}

const persistenceStatus = shallowRef<DuckDbPersistenceStatus>({ state: 'idle', pendingWrites: 0 })

export function useDuckDb() {
  const checkpointDb = () => mutex.runExclusive(async () => {
    if (!db.value)
      return persistenceStatus.value
    persistenceStatus.value = { state: 'checkpointing', pendingWrites: 1, ...(persistenceStatus.value.lastCheckpointAt ? { lastCheckpointAt: persistenceStatus.value.lastCheckpointAt } : {}) }
    try {
      await db.value.execute('CHECKPOINT')
      const status: DuckDbPersistenceStatus = { state: 'complete', pendingWrites: 0, lastCheckpointAt: Date.now() }
      persistenceStatus.value = status
      return status
    }
    catch (error) {
      const status: DuckDbPersistenceStatus = {
        state: 'error',
        pendingWrites: 1,
        error: errorMessageFrom(error) ?? String(error),
        ...(persistenceStatus.value.lastCheckpointAt ? { lastCheckpointAt: persistenceStatus.value.lastCheckpointAt } : {}),
      }
      persistenceStatus.value = status
      throw error
    }
  })

  const closeDb = () => mutex.runExclusive(async () => {
    if (!db.value)
      return persistenceStatus.value
    try {
      // CHECKPOINT flushes committed writes to the OPFS-backed database before
      // the connection closes. A failed checkpoint must remain visible.
      persistenceStatus.value = { state: 'checkpointing', pendingWrites: 1, ...(persistenceStatus.value.lastCheckpointAt ? { lastCheckpointAt: persistenceStatus.value.lastCheckpointAt } : {}) }
      await db.value.execute('CHECKPOINT')
      await (await db.value.$client).close()
      persistenceStatus.value = { state: 'complete', pendingWrites: 0, lastCheckpointAt: Date.now() }
    }
    catch (error) {
      persistenceStatus.value = {
        state: 'error',
        pendingWrites: 1,
        error: errorMessageFrom(error) ?? String(error),
        ...(persistenceStatus.value.lastCheckpointAt ? { lastCheckpointAt: persistenceStatus.value.lastCheckpointAt } : {}),
      }
      console.error(`Error closing DuckDB: ${error}. Reference to the worker will be dropped regardless, but the cleanup may be incomplete.`)
      throw error
    }
    finally {
      db.value = null
    }
  })

  const getDb = () =>
    mutex.runExclusive(async () => {
      if (db.value)
        return db
      // Single-writer contract (MEMORY-DESIGN §1.4): OPFS permits exactly one
      // synchronous access handle per file, so the check must live at this —
      // the only OPFS entry point — rather than in each caller. Without it,
      // any window that opens the database directly (e.g. a component mounted
      // in a follower window) strips the leader's exclusive handle and its
      // next open fails with a createSyncAccessHandle conflict. Non-browser
      // contexts (Node consumers, unit tests) have no OPFS at all and keep
      // the unconditional open.
      const locationSearch = globalThis.location?.search
      if (locationSearch != null && resolveMemoryWriteAccess(locationSearch) === 'follower')
        throw new Error('Memory database is read-write only in the leader window (?synced-leader=true); this window must not open it.')
      let dbInstance
      try {
        // Omitting storage creates an in-memory database. OPFS keeps memory
        // fragments available after the renderer reloads or the app closes.
        dbInstance = drizzle({
          connection: {
            bundles: getImportUrlBundles(),
            storage: {
              type: DBStorageType.ORIGIN_PRIVATE_FS,
              path: MEMORY_DATABASE_PATH,
              accessMode: DuckDBAccessMode.READ_WRITE,
            },
          },
        })
        await dbInstance.execute(`
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
        await dbInstance.execute(`
          ALTER TABLE memory_fragments
          ADD COLUMN IF NOT EXISTS source_context_json VARCHAR
        `)
        await dbInstance.execute(`
          UPDATE memory_fragments
          SET source_context_json = '{}'
          WHERE source_context_json IS NULL
        `)
        await dbInstance.execute(`
          ALTER TABLE memory_fragments
          ADD COLUMN IF NOT EXISTS review_status VARCHAR
        `)
        // Existing rows predate the review gate and remain approved. New
        // repository inserts use pending when a caller omits status. DuckDB
        // cannot add a constrained column, so the migration backfills it.
        await dbInstance.execute(`
          UPDATE memory_fragments
          SET review_status = 'approved'
          WHERE review_status IS NULL
        `)
        await dbInstance.execute(`
          ALTER TABLE memory_fragments
          ADD COLUMN IF NOT EXISTS fact_status VARCHAR
        `)
        await dbInstance.execute(`
          UPDATE memory_fragments
          SET fact_status = 'active'
          WHERE fact_status IS NULL
        `)
        await dbInstance.execute(`
          ALTER TABLE memory_fragments
          ADD COLUMN IF NOT EXISTS supersedes_id VARCHAR
        `)
        await dbInstance.execute(`
          ALTER TABLE memory_fragments
          ADD COLUMN IF NOT EXISTS conflict_group VARCHAR
        `)
        await dbInstance.execute(`
          ALTER TABLE memory_fragments
          ADD COLUMN IF NOT EXISTS origin_id VARCHAR
        `)
        await dbInstance.execute(`
          ALTER TABLE memory_fragments
          ADD COLUMN IF NOT EXISTS scope_json VARCHAR
        `)
        await dbInstance.execute(`
          UPDATE memory_fragments
          SET scope_json = '{}'
          WHERE scope_json IS NULL
        `)
        // Embeddings live in a JSON column so the vector space can change
        // between embedding models (768/1024/1536) without schema churn;
        // similarity is computed against rows of the matching dimension.
        await dbInstance.execute(`
          ALTER TABLE memory_fragments
          ADD COLUMN IF NOT EXISTS content_vector_json VARCHAR
        `)
        await dbInstance.execute(`
          ALTER TABLE memory_fragments
          ADD COLUMN IF NOT EXISTS content_vector_1024 FLOAT[1024]
        `)
        await dbInstance.execute(`
          ALTER TABLE memory_fragments
          ADD COLUMN IF NOT EXISTS content_vector_1536 FLOAT[1536]
        `)
        await dbInstance.execute(`
          ALTER TABLE memory_fragments
          ADD COLUMN IF NOT EXISTS embedding_provider VARCHAR
        `)
        await dbInstance.execute(`
          ALTER TABLE memory_fragments
          ADD COLUMN IF NOT EXISTS embedding_model VARCHAR
        `)
        await dbInstance.execute(`
          ALTER TABLE memory_fragments
          ADD COLUMN IF NOT EXISTS embedding_dimensions INTEGER
        `)
        await dbInstance.execute(`
          ALTER TABLE memory_fragments
          ADD COLUMN IF NOT EXISTS embedding_input_type VARCHAR
        `)
        await dbInstance.execute(`
          ALTER TABLE memory_fragments
          ADD COLUMN IF NOT EXISTS embedding_source_fingerprint VARCHAR
        `)
        await dbInstance.execute(`
          ALTER TABLE memory_fragments
          ADD COLUMN IF NOT EXISTS embedded_at BIGINT
        `)
        await dbInstance.execute(`
          ALTER TABLE memory_fragments
          ADD COLUMN IF NOT EXISTS embedding_status VARCHAR
        `)
        await dbInstance.execute(`
          CREATE TABLE IF NOT EXISTS memory_tags (
            id VARCHAR PRIMARY KEY,
            memory_id VARCHAR NOT NULL,
            tag VARCHAR NOT NULL,
            created_at BIGINT NOT NULL,
            deleted_at BIGINT
          )
        `)
        await dbInstance.execute(`
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
        await dbInstance.execute(`
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
        await dbInstance.execute(`
          ALTER TABLE memory_long_term_goals
          ADD COLUMN IF NOT EXISTS spec_json VARCHAR
        `)
        await dbInstance.execute(`
          ALTER TABLE memory_long_term_goals
          ADD COLUMN IF NOT EXISTS state_json VARCHAR
        `)
        await dbInstance.execute(`
          ALTER TABLE memory_long_term_goals
          ADD COLUMN IF NOT EXISTS horizon VARCHAR
        `)
        await dbInstance.execute(`
          ALTER TABLE memory_long_term_goals
          ADD COLUMN IF NOT EXISTS session_id VARCHAR
        `)
        await dbInstance.execute(`
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
        await dbInstance.execute(`
          ALTER TABLE memory_short_term_ideas
          ADD COLUMN IF NOT EXISTS content_vector_json VARCHAR
        `)
        // Existing ideas retain unknown ownership; never assign them to the
        // character that happens to open this database during migration.
        await dbInstance.execute(`ALTER TABLE memory_short_term_ideas ADD COLUMN IF NOT EXISTS scope_json VARCHAR`)
        db.value = dbInstance
        return db
      }
      catch (error) {
        console.error(`Failed to init DuckDB ${error}, attempting to close it.`)
        await (await (dbInstance?.$client))?.close()
        throw error
      }
    })

  /**
   * Exports all owned tables from one read transaction. Parquet preserves IDs,
   * large integers and vector types without copying the live OPFS database.
   * The caller must also quiesce other domain owners for a profile snapshot.
   */
  async function exportSnapshot(): Promise<DataBackupEntry[]> {
    await getDb()
    return mutex.runExclusive(async () => {
      const client = await db.value!.$client
      const connection = await client.db.connect()
      const entries: DataBackupEntry[] = []
      const files: string[] = []
      const snapshotId = crypto.randomUUID()
      try {
        await connection.query('BEGIN TRANSACTION')
        for (const table of SNAPSHOT_TABLES) {
          const file = `backup-${snapshotId}-${table}.parquet`
          files.push(file)
          await connection.query(`COPY ${table} TO '${file}' (FORMAT PARQUET)`)
          entries.push({ path: `memory/${table}.parquet`, domain: 'memory', data: await client.db.copyFileToBuffer(file) })
        }
        await connection.query('COMMIT')
        return entries
      }
      catch (error) {
        await connection.query('ROLLBACK').catch(() => {})
        throw error
      }
      finally {
        await connection.close()
        for (const file of files)
          await client.db.dropFile(file)
      }
    })
  }

  /**
   * Restores the complete table set into an empty database only. All inserts
   * share one transaction; incompatible files leave the target tables empty.
   * The isolated profile must keep scheduling and outbox delivery disabled.
   */
  async function importSnapshot(entries: readonly DataBackupEntry[]): Promise<void> {
    const expected = SNAPSHOT_TABLES.map(table => `memory/${table}.parquet`)
    if (entries.length !== expected.length || expected.some(path => entries.filter(entry => entry.domain === 'memory' && entry.path === path).length !== 1))
      throw new Error('Memory backup must contain exactly one file for every owned table.')
    await getDb()
    await mutex.runExclusive(async () => {
      const client = await db.value!.$client
      const connection = await client.db.connect()
      const files: string[] = []
      const snapshotId = crypto.randomUUID()
      try {
        await connection.query('BEGIN TRANSACTION')
        for (const table of SNAPSHOT_TABLES) {
          const result = await connection.query(`SELECT count(*) AS count FROM ${table}`)
          if (Number(result.toArray()[0]?.count) !== 0)
            throw new Error('Memory restore requires an empty profile database.')
        }
        for (const table of SNAPSHOT_TABLES) {
          const entry = entries.find(entry => entry.path === `memory/${table}.parquet`)!
          const file = `restore-${snapshotId}-${table}.parquet`
          files.push(file)
          await client.db.registerFileBuffer(file, new Uint8Array(entry.data))
          // Column names, not archive column order, own the restore mapping.
          // Newly added nullable ownership stays unknown in older archives.
          await connection.query(`INSERT INTO ${table} BY NAME SELECT * FROM read_parquet('${file}')`)
        }
        await connection.query('COMMIT')
      }
      catch (error) {
        await connection.query('ROLLBACK').catch(() => {})
        throw error
      }
      finally {
        await connection.close()
        for (const file of files)
          await client.db.dropFile(file)
      }
      await db.value!.execute('CHECKPOINT')
    })
  }

  return {
    db,
    persistenceStatus: readonly(persistenceStatus),
    getDb,
    checkpointDb,
    closeDb,
    exportSnapshot,
    importSnapshot,
  }
}
