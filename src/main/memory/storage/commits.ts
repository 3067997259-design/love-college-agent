import { createHash, randomUUID } from 'node:crypto'
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { Clock } from '../../clock'
import type { MemoryFragment, MemoryScope } from '../airi/core'
import { isSameMemoryScope } from '../airi/core'
import type { MemoryDbExecutor, MemoryInteractionRepository } from '../airi/repository/interaction-repository'
import { createDuckDbMemoryRepository } from '../airi/repository/local-memory'
import type { MemoryDatabaseClient } from './client'

export interface MemoryCommitIdentity { operationId: string; kind: string; input: unknown }
export interface MemoryMirrorChange { originId: string; version: string; fragment?: MemoryFragment; deleted: boolean }
export type MemoryCommitPoint = 'intent' | 'before-commit' | 'committed' | 'published'
interface CommitEvent { operationId: string; kind: string; digest: string; phase: 'intent' | 'published' | 'not-applied'; atMs: number }
interface CommitRow { operation_id: string; kind: string; digest: string; result_json: string }
const quote = (value: string) => `'${value.replaceAll("'", "''")}'`
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value) ?? 'null').digest('hex')

/** Framed, append-only private log. A crash-torn frame is preserved; the next
 * record starts with a fresh RS, so recovery never deletes or reinterprets it. */
function openCommitLog(path: string) {
  const events: CommitEvent[] = []
  if (existsSync(path)) {
    for (const frame of readFileSync(path, 'utf8').split('\x1e')) {
      if (!frame || !frame.endsWith('\n')) continue
      const record = JSON.parse(frame) as { event: CommitEvent; checksum: string }
      if (!record.event || record.checksum !== digest(record.event)) throw new Error('MEMORY_COMMIT_LOG_CORRUPT')
      events.push(record.event)
    }
  }
  return {
    events,
    append(event: CommitEvent) {
      mkdirSync(dirname(path), { recursive: true })
      const fd = openSync(path, 'a', 0o600)
      try { writeFileSync(fd, `\x1e${JSON.stringify({ event, checksum: digest(event) })}\n`); fsyncSync(fd) }
      finally { closeSync(fd) }
      events.push(event)
    },
  }
}

const writes = new Set(['insert', 'update', 'remove', 'recordAccess', 'promoteEligible', 'updateEmbedding', 'saveOperation', 'addDreamIdea', 'updateDreamIdea'])

/** Owns fact + receipt + mirror-intent commits. Neither models nor network run
 * inside its transaction. A successful return requires a durable published log
 * receipt; a failed publication is recovered by ID, never by repeating a write. */
export async function createMemoryCommitCoordinator(options: {
  database: MemoryDatabaseClient; clock: Clock; scope: MemoryScope; logPath: string
  interrupt?: (point: MemoryCommitPoint, operationId: string) => void
}) {
  const { database, clock, scope } = options
  const log = openCommitLog(options.logPath)
  await database.execute(`CREATE TABLE IF NOT EXISTS lca_memory_commits (
    operation_id VARCHAR PRIMARY KEY, kind VARCHAR NOT NULL, digest VARCHAR NOT NULL,
    result_json VARCHAR NOT NULL, committed_at BIGINT NOT NULL)`)
  await database.execute(`CREATE TABLE IF NOT EXISTS lca_memory_mirror_dirty (
    origin_id VARCHAR PRIMARY KEY, version VARCHAR NOT NULL, deleted BOOLEAN NOT NULL, changed_at BIGINT NOT NULL)`)
  let tail: Promise<unknown> = Promise.resolve()
  const serial = <T>(action: () => Promise<T>) => {
    const task = tail.then(action)
    tail = task.then(() => undefined, () => undefined)
    return task
  }
  const event = (row: Pick<CommitRow, 'operation_id' | 'kind' | 'digest'>, phase: CommitEvent['phase']) => {
    const existing = log.events.find(item => item.operationId === row.operation_id && item.phase === phase && item.digest === row.digest)
    if (!existing) log.append({ operationId: row.operation_id, kind: row.kind, digest: row.digest, phase, atMs: clock.nowMs() })
  }
  const recover = () => serial(async () => {
    const rows = await database.execute('SELECT operation_id, kind, digest FROM lca_memory_commits') as CommitRow[]
    const committed = new Map(rows.map(row => [row.operation_id, row]))
    for (const row of rows) event(row, 'published')
    for (const item of [...log.events]) {
      if (item.phase === 'intent' && !committed.has(item.operationId))
        event({ operation_id: item.operationId, kind: item.kind, digest: item.digest }, 'not-applied')
    }
    return { committed: rows.length, published: rows.length }
  })
  await recover()

  const trackedRepository = (executor: MemoryDbExecutor): MemoryInteractionRepository => {
    const base = createDuckDbMemoryRepository(executor, undefined, clock)
    const mark = async (id: string, deleted = false, before?: MemoryFragment) => {
      const fragment = deleted ? before : await base.get(id)
      if (!fragment || !isSameMemoryScope(fragment.scope, scope)) return
      if (!deleted && fragment.memoryType !== 'long_term') return
      await executor.execute(`INSERT INTO lca_memory_mirror_dirty VALUES (${quote(id)}, ${quote(randomUUID())}, ${deleted}, ${clock.nowMs()})
        ON CONFLICT (origin_id) DO UPDATE SET version = excluded.version, deleted = excluded.deleted, changed_at = excluded.changed_at`)
    }
    const tracked: MemoryInteractionRepository = new Proxy(base, {
      get(target, key: keyof MemoryInteractionRepository) {
        if (key === 'transaction') return <T>(action: (tx: MemoryInteractionRepository) => Promise<T>) => action(tracked)
        const method = target[key]
        if (typeof method !== 'function') return method
        if (!writes.has(key)) return method
        return async (...args: unknown[]) => {
          const id = typeof args[0] === 'string' ? args[0] : undefined
          const before = id ? await base.get(id) : undefined
          if (before && !isSameMemoryScope(before.scope, scope)) throw new Error('MEMORY_SCOPE_MISMATCH')
          if (key === 'insert' && !isSameMemoryScope((args[0] as { scope?: MemoryScope }).scope, scope)) throw new Error('MEMORY_SCOPE_MISMATCH')
          const result: unknown = await Reflect.apply(method, target, args)
          if (key === 'insert') await mark((result as MemoryFragment).id)
          else if (key === 'remove' && id) await mark(id, true, before)
          else if ((key === 'update' || key === 'updateEmbedding') && id) await mark(id)
          else if (key === 'promoteEligible') for (const promoted of result as string[]) await mark(promoted)
          else if (key === 'recordAccess') for (const accessed of (args[0] as { memoryIds: string[] }).memoryIds) await mark(accessed)
          return result
        }
      },
    })
    return tracked
  }
  const commit = <T>(identity: MemoryCommitIdentity, action: (tx: MemoryInteractionRepository, executor: MemoryDbExecutor) => Promise<T>): Promise<T> => serial(async () => {
    if (!identity.operationId || !identity.kind) throw new Error('MEMORY_COMMIT_ID_REQUIRED')
    const fingerprint = digest({ kind: identity.kind, scope, input: identity.input })
    const previous = log.events.find(item => item.operationId === identity.operationId)
    if (previous && previous.digest !== fingerprint) throw new Error('MEMORY_COMMIT_ID_CONFLICT')
    const row = { operation_id: identity.operationId, kind: identity.kind, digest: fingerprint }
    const existing = await database.execute(`SELECT * FROM lca_memory_commits WHERE operation_id = ${quote(identity.operationId)}`) as CommitRow[]
    if (existing[0]) {
      if (existing[0].digest !== fingerprint) throw new Error('MEMORY_COMMIT_ID_CONFLICT')
      event(row, 'published')
      return (JSON.parse(existing[0].result_json) as { value: T }).value
    }
    event(row, 'intent')
    options.interrupt?.('intent', identity.operationId)
    const result = await database.transaction(async executor => {
      const value = await action(trackedRepository(executor), executor)
      await executor.execute(`INSERT INTO lca_memory_commits VALUES (${quote(identity.operationId)}, ${quote(identity.kind)}, ${quote(fingerprint)}, ${quote(JSON.stringify({ value }))}, ${clock.nowMs()})`)
      options.interrupt?.('before-commit', identity.operationId)
      return value
    })
    options.interrupt?.('committed', identity.operationId)
    event(row, 'published')
    options.interrupt?.('published', identity.operationId)
    return result
  })
  const base = createDuckDbMemoryRepository(database, database.transaction, clock)
  const repository: MemoryInteractionRepository = new Proxy(base, {
    get(target, key: keyof MemoryInteractionRepository) {
      if (key === 'transaction') return <T>(action: (tx: MemoryInteractionRepository) => Promise<T>) => commit({ operationId: randomUUID(), kind: 'transaction', input: null }, action)
      const method = target[key]
      if (typeof method !== 'function') return method
      if (!writes.has(key)) return (...args: unknown[]) => serial(() => Reflect.apply(method, target, args) as Promise<unknown>)
      return (...args: unknown[]) => commit({ operationId: randomUUID(), kind: key, input: args }, tx => Reflect.apply(tx[key], tx, args) as Promise<unknown>)
    },
  })
  const mirrorChanges = () => serial(async (): Promise<MemoryMirrorChange[]> => {
    const rows = await database.execute('SELECT origin_id, version, deleted FROM lca_memory_mirror_dirty ORDER BY changed_at, origin_id') as { origin_id: string; version: string; deleted: boolean }[]
    const changes: MemoryMirrorChange[] = []
    for (const row of rows) {
      const fragment = row.deleted ? undefined : await base.get(row.origin_id)
      changes.push({ originId: row.origin_id, version: row.version, deleted: row.deleted || !fragment, fragment })
    }
    return changes
  })
  return {
    repository, commit, recover, mirrorChanges,
    acknowledgeMirrorChange: (change: Pick<MemoryMirrorChange, 'originId' | 'version'>) => serial(async () => {
      await database.execute(`DELETE FROM lca_memory_mirror_dirty WHERE origin_id = ${quote(change.originId)} AND version = ${quote(change.version)}`)
    }),
    receipt: (id: string, identity?: Pick<MemoryCommitIdentity, 'kind' | 'input'>) => serial(async () => {
      const rows = await database.execute(`SELECT operation_id, kind, digest FROM lca_memory_commits WHERE operation_id = ${quote(id)}`) as CommitRow[]
      if (rows[0] && identity && rows[0].digest !== digest({ kind: identity.kind, scope, input: identity.input })) throw new Error('MEMORY_COMMIT_ID_CONFLICT')
      if (rows[0]) { event(rows[0], 'published'); return { operationId: id, state: 'published' as const } }
      return { operationId: id, state: log.events.some(item => item.operationId === id) ? 'not-applied' as const : 'unknown' as const }
    }),
    idle: () => tail,
  }
}

export type MemoryCommitCoordinator = Awaited<ReturnType<typeof createMemoryCommitCoordinator>>
