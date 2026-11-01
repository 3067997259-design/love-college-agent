// Native adaptation of AIRI use-duck-db snapshot contract (MIT).
// See vendor/airi-memory/increment/packages/stage-ui/src/composables/use-duck-db.ts.
import { existsSync, mkdirSync, readFileSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type { MemoryDatabaseClient } from './client'
import { parseMemoryOperation } from '../airi/repository/interaction-repository'
import type { MemoryDbExecutor } from '../airi/repository/interaction-repository'
import { isSameMemoryScope, type MemoryScope } from '../airi/core'

export interface MemorySnapshotEntry { path: string; domain: 'memory'; data: Uint8Array }
const tables = ['memory_fragments', 'memory_tags', 'memory_episodic', 'memory_long_term_goals', 'memory_short_term_ideas', 'memory_operations'] as const
const commits = ['lca_memory_commits', 'lca_memory_mirror_dirty'] as const
const quote = (value: string) => `'${value.replaceAll("'", "''")}'`
const textColumns: Record<string, string> = {
  memory_fragments: 'content,title,summary,trigger_pattern,source_context_json,scope_json,origin_id,embedding_provider,embedding_model,embedding_source_fingerprint',
  memory_tags: 'tag', memory_episodic: 'event_type,participants,location',
  memory_long_term_goals: 'title,description,spec_json,state_json,category', memory_short_term_ideas: 'content,source_type,source_id,scope_json',
  memory_operations: 'operation_json', lca_memory_commits: 'result_json', lca_memory_mirror_dirty: 'origin_id',
}

function containsCredential(value: unknown, credentials: readonly string[], depth = 0): boolean {
  if (depth > 20) return true
  if (typeof value === 'string') {
    if (credentials.some(secret => value.includes(secret))) return true
    if (/^[{["]/.test(value)) { try { return containsCredential(JSON.parse(value), credentials, depth + 1) } catch { return false } }
  } else if (value && typeof value === 'object') return Object.values(value).some(item => containsCredential(item, credentials, depth + 1))
  return false
}

async function assertOwner(database: MemoryDbExecutor, scope?: MemoryScope) {
  if (!scope) return
  for (const table of ['memory_fragments', 'memory_short_term_ideas']) {
    const rows = await database.execute(`SELECT scope_json FROM ${table}`) as { scope_json: string }[]
    for (const row of rows) if (!isSameMemoryScope(JSON.parse(row.scope_json), scope)) throw new Error('MEMORY_SNAPSHOT_SCOPE_MISMATCH')
  }
  const operations = await database.execute('SELECT user_id, character_id FROM memory_operations') as { user_id: string; character_id: string }[]
  if (operations.some(row => row.user_id !== scope.userId || row.character_id !== scope.characterId)) throw new Error('MEMORY_SNAPSHOT_SCOPE_MISMATCH')
  for (const table of ['memory_tags', 'memory_episodic']) {
    const orphans = await database.execute(`SELECT count(*) AS count FROM ${table} child LEFT JOIN memory_fragments parent ON child.memory_id = parent.id WHERE parent.id IS NULL`) as { count: bigint }[]
    if (Number(orphans[0]?.count)) throw new Error('MEMORY_SNAPSHOT_ORPHAN')
  }
}

/** No database bytes or paths leave main. Parquet import stays transactional,
 * preserves all upstream columns and accepts the pinned five-table legacy form. */
export function createMemorySnapshots(database: MemoryDatabaseClient, temporaryRoot: string, includeCommits = false, scope?: MemoryScope, credentials: readonly string[] = []) {
  const ownedTables = includeCommits ? [...tables, ...commits] : [...tables]
  // Windows mkdtemp retains a shorter path limit than mkdir. Restore staging
  // adds owner/transaction directories, so use an exclusive UUID directory.
  const scratch = () => { mkdirSync(temporaryRoot, { recursive: true }); const root = join(temporaryRoot, randomUUID()); mkdirSync(root); return root }
  const clean = (root: string, files: string[]) => { for (const file of files) if (existsSync(file)) unlinkSync(file); rmdirSync(root) }
  return {
    async exportSnapshot(): Promise<MemorySnapshotEntry[]> {
      const root = scratch(); const files: string[] = []
      try {
        return await database.transaction(async tx => {
          await assertOwner(tx, scope)
          const secrets = credentials.filter(value => value.length >= 8)
          // Parquet compression can hide a key from a byte-level ZIP guard.
          // Inspect native text columns before encoding, never print them.
          if (secrets.length) for (const table of ownedTables) {
            const rows = await tx.execute(`SELECT ${textColumns[table]} FROM ${table}`)
            if (containsCredential(rows, secrets)) throw new Error('MEMORY_ARCHIVE_CREDENTIAL_FORBIDDEN')
          }
          const entries: MemorySnapshotEntry[] = []
          for (const table of ownedTables) {
            const path = join(root, `${table}.parquet`)
            files.push(path)
            await tx.execute(`COPY ${table} TO ${quote(path)} (FORMAT PARQUET)`)
            entries.push({ path: `memory/${table}.parquet`, domain: 'memory', data: new Uint8Array(readFileSync(path)) })
          }
          entries.push({ path: 'memory/schema.json', domain: 'memory', data: new TextEncoder().encode(JSON.stringify({ version: includeCommits ? 3 : 2 })) })
          return entries
        })
      } finally { clean(root, files) }
    },
    async importSnapshot(entries: readonly MemorySnapshotEntry[]): Promise<void> {
      const schema = entries.find(entry => entry.path === 'memory/schema.json')
      const version = schema ? (JSON.parse(new TextDecoder().decode(schema.data)) as { version: number }).version : 1
      if (![1, 2, 3].includes(version) || version === 3 && !includeCommits || schema && new TextDecoder().decode(schema.data) !== JSON.stringify({ version })) throw new Error('Unsupported memory snapshot version')
      const importing = version === 3 ? [...tables, ...commits] : version === 2 ? [...tables] : tables.filter(table => table !== 'memory_operations')
      const expected = [...importing.map(table => `memory/${table}.parquet`), ...(schema ? ['memory/schema.json'] : [])]
      if (entries.length !== expected.length || expected.some(path => entries.filter(entry => entry.domain === 'memory' && entry.path === path).length !== 1)) throw new Error('Memory backup must contain exactly one file for every owned table.')
      const root = scratch(); const files: string[] = []
      try {
        await database.transaction(async tx => {
          for (const table of ownedTables) {
            const rows = await tx.execute(`SELECT count(*) AS count FROM ${table}`) as { count: bigint }[]
            if (Number(rows[0]?.count) !== 0) throw new Error('Memory restore requires an empty profile database.')
          }
          for (const table of importing) {
            const path = join(root, `${table}.parquet`)
            writeFileSync(path, entries.find(entry => entry.path === `memory/${table}.parquet`)!.data, { flag: 'wx', mode: 0o600 }); files.push(path)
            if (version === 3) {
              const original = await tx.execute(`DESCRIBE ${table}`) as { column_name: string }[]
              const incoming = await tx.execute(`DESCRIBE SELECT * FROM read_parquet(${quote(path)})`) as { column_name: string }[]
              if (JSON.stringify(original.map(row => row.column_name).sort()) !== JSON.stringify(incoming.map(row => row.column_name).sort())) throw new Error('MEMORY_SNAPSHOT_COLUMNS_MISMATCH')
            }
            await tx.execute(`INSERT INTO ${table} BY NAME SELECT * FROM read_parquet(${quote(path)})`)
          }
          const receipts = await tx.execute('SELECT * FROM memory_operations') as Record<string, unknown>[]
          for (const row of receipts) {
            const operation = parseMemoryOperation(JSON.parse(String(row.operation_json)))
            if (operation.operationId !== row.operation_id || operation.scope.userId !== row.user_id || operation.scope.characterId !== row.character_id || operation.sessionId !== row.session_id) throw new Error('Memory receipt index does not match its owner')
          }
          if (version === 3) {
            const rows = await tx.execute('SELECT * FROM lca_memory_commits') as Record<string, unknown>[]
            for (const row of rows) {
              if (!row.operation_id || !row.kind || !/^[a-f0-9]{64}$/.test(String(row.digest))) throw new Error('Invalid memory commit receipt')
              const value: unknown = JSON.parse(String(row.result_json))
              if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid memory commit result')
            }
          }
          await assertOwner(tx, scope)
        })
        await database.checkpoint()
      } finally { clean(root, files) }
    },
  }
}
