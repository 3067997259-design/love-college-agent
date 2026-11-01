import { createHash } from 'node:crypto'
import type { Clock } from '../../clock'
import type { ContinuityOwner } from '../../../shared/continuity'
import type { MemoryScope } from './core'
import { isSameMemoryScope } from './core'
import type { MemoryHostPort, MemoryHostStatusLike } from './runtime'
import { connectMemoryRepository, ensureMemorySchema, type MemoryPgvectorConnection } from './pgvector/repository'

/** An archive restore receives a new epoch before reconnecting. Old in-flight
 * effects can reach only the old namespace, never restored facts. */
export function memoryMirrorNamespace(owner: ContinuityOwner, epoch: string) {
  if (!owner.userId || !owner.characterId || !owner.dataRootId || !epoch) throw new Error('MEMORY_MIRROR_OWNER_REQUIRED')
  return `lca_memory_${createHash('sha256').update(JSON.stringify([owner.userId, owner.characterId, owner.dataRootId, epoch])).digest('hex').slice(0, 32)}`
}

/** Private main port, isolated by profile, character and restore epoch. The
 * upstream pgvector repository and all vector columns remain authoritative. */
export function createMemoryMirrorHost(options: {
  clock: Clock; owner: ContinuityOwner; epoch: string; held(): boolean
  connect?: typeof connectMemoryRepository; ensureSchema?: typeof ensureMemorySchema
}) {
  const namespace = memoryMirrorNamespace(options.owner, options.epoch)
  const scope = { userId: options.owner.userId, characterId: options.owner.characterId }
  let connection: MemoryPgvectorConnection | undefined
  let status: MemoryHostStatusLike = { status: 'unconfigured' }
  let tail: Promise<unknown> = Promise.resolve()
  let disposed = false
  let generation = 0
  const serial = <T>(action: () => Promise<T>) => {
    const task = tail.then(action)
    tail = task.then(() => undefined, () => undefined)
    return task
  }
  const assertScope = (candidate?: MemoryScope) => { if (!isSameMemoryScope(scope, candidate)) throw new Error('MEMORY_MIRROR_SCOPE_MISMATCH') }
  const use = <T>(action: (connection: MemoryPgvectorConnection) => Promise<T>): Promise<T> => {
    const current = generation
    return serial(async () => {
      if (disposed || current !== generation || options.held() || !connection || status.status !== 'ready') throw new Error('MEMORY_MIRROR_UNAVAILABLE')
      try { return await action(connection) }
      catch { status = { status: 'error', error: 'MEMORY_MIRROR_FAILED' }; throw new Error('MEMORY_MIRROR_FAILED') }
    })
  }
  const port: MemoryHostPort = {
    configure: ({ connectionString }) => {
      generation++
      return serial(async () => {
        if (disposed || options.held()) return { status: 'error', error: 'MEMORY_MIRROR_HELD' }
        try {
          await connection?.close(); connection = undefined
          if (!connectionString) { status = { status: 'unconfigured' }; return status }
          const url = new URL(connectionString)
          if (!['postgres:', 'postgresql:'].includes(url.protocol)) throw new Error('INVALID_CONNECTION')
          await (options.ensureSchema ?? ensureMemorySchema)(connectionString, namespace)
          connection = (options.connect ?? connectMemoryRepository)(connectionString, options.clock, namespace)
          status = { status: 'ready' }
        } catch { status = { status: 'error', error: 'MEMORY_MIRROR_CONFIGURATION_FAILED' } }
        return { ...status }
      })
    },
    getStatus: async () => ({ ...status }),
    list: params => { assertScope(params?.scope); return use(host => host.repository.list({ ...params, memoryType: params?.memoryType as 'long_term' | undefined, reviewStatus: params?.reviewStatus as 'approved' | undefined, scope })) },
    search: params => { assertScope(params.scope); return use(host => host.repository.search({ ...params, scope })) },
    insert: params => {
      assertScope(params.scope)
      return use(async host => {
        const result = await host.repository.insert({ ...params, memoryType: params.memoryType as 'long_term', importance: params.importance ?? 5, valence: params.valence ?? 0,
          arousal: params.arousal ?? 0, tags: [], reviewStatus: params.reviewStatus as 'approved', factStatus: params.factStatus as 'active', scope })
        return { id: result.id, originId: result.originId ?? undefined }
      })
    },
    update: params => use(host => host.repository.updateByOriginId(params.originId, { ...params.patch, contentVector: params.patch.embedding,
      reviewStatus: params.patch.reviewStatus as 'approved' | undefined, factStatus: params.patch.factStatus as 'active' | undefined })),
    remove: params => use(host => host.repository.removeByOriginId(params.originId)),
  }
  return { port, namespace, async close() { disposed = true; generation++; await serial(async () => { await connection?.close(); connection = undefined; status = { status: 'unconfigured' } }) } }
}
