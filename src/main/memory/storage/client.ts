import { randomUUID } from 'node:crypto'
import type { Clock } from '../../clock'
import type { MemoryDbExecutor, MemoryDbTransaction } from '../airi/repository/interaction-repository'
import type { MemoryDatabaseChannel } from './protocol'

/** The complete transaction callback holds the queue. Calls from other tasks and
 * checkpoints wait outside it, so unrelated writes cannot be committed/rolled back. */
export function createMemoryDatabaseClient(channel: MemoryDatabaseChannel, clock: Clock) {
  let tail: Promise<unknown> = Promise.resolve()
  let closing = false
  let state: 'opening' | 'ready' | 'failed' | 'closed' = 'opening'
  let checkpointAt: number | null = null
  let pending = 0
  const serial = <T>(run: () => Promise<T>): Promise<T> => {
    pending++
    const result = tail.then(run)
    tail = result.then(() => undefined, () => undefined)
    return result.finally(() => { pending-- })
  }
  const assertOpen = () => { if (closing || state !== 'ready') throw new Error('MEMORY_DATABASE_UNAVAILABLE') }
  const executor: MemoryDbExecutor = {
    execute: sql => {
      assertOpen()
      return serial(() => channel.request({ kind: 'execute', sql }))
    },
  }
  const transaction: MemoryDbTransaction = action => {
    assertOpen()
    return serial(async () => {
      const transactionId = randomUUID()
      await channel.request({ kind: 'begin', transactionId })
      let live = true
      const scoped: MemoryDbExecutor = { execute: sql => {
        if (!live) return Promise.reject(new Error('MEMORY_TRANSACTION_CLOSED'))
        return channel.request({ kind: 'execute', sql, transactionId })
      } }
      try {
        const result = await action(scoped)
        live = false
        await channel.request({ kind: 'commit', transactionId })
        return result
      } catch (error) {
        live = false
        // Never mask a rollback failure: this owner is no longer safe to write.
        try { await channel.request({ kind: 'rollback', transactionId }) }
        catch { state = 'failed' }
        throw error
      }
    })
  }
  return {
    ...executor,
    transaction,
    async open(path: string) {
      if (state !== 'opening') throw new Error('MEMORY_DATABASE_ALREADY_OPENED')
      return serial(async () => {
        try { await channel.request({ kind: 'open', path }); state = 'ready' }
        catch (error) { state = 'failed'; throw error }
      })
    },
    checkpoint() {
      assertOpen()
      return serial(async () => {
        await channel.request({ kind: 'checkpoint' })
        checkpointAt = clock.nowMs()
      })
    },
    close() {
      if (closing) return tail
      closing = true
      return serial(async () => {
        try { await channel.request({ kind: 'close' }); checkpointAt = clock.nowMs(); state = 'closed' }
        catch (error) { state = 'failed'; throw error }
      })
    },
    status: () => ({ state, checkpointAt, pending }),
    failed: () => { state = 'failed' },
  }
}

export type MemoryDatabaseClient = ReturnType<typeof createMemoryDatabaseClient>
