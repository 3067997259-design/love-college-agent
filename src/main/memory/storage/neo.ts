import { DuckDBInstance, type DuckDBConnection } from '@duckdb/node-api'
import { isAbsolute, dirname } from 'node:path'
import { mkdir } from 'node:fs/promises'
import { initializeMemorySchema } from '../airi/schema'
import type { MemoryDatabaseRequest } from './protocol'

/** One native connection, owned by one utility process. Transaction tokens prevent
 * unrelated statements from joining another caller's transaction. No in-memory fallback. */
export function createNativeMemoryDatabase() {
  let instance: DuckDBInstance | undefined
  let connection: DuckDBConnection | undefined
  let transactionId: string | undefined
  const execute = async (sql: string) => {
    if (!connection) throw new Error('MEMORY_DATABASE_CLOSED')
    return (await connection.runAndReadAll(sql)).getRowObjectsJS()
  }
  return {
    async request(request: MemoryDatabaseRequest): Promise<unknown> {
      if (request.kind === 'open') {
        if (instance || !isAbsolute(request.path)) throw new Error('MEMORY_DATABASE_INVALID_OPEN')
        await mkdir(dirname(request.path), { recursive: true })
        // Native IO and extension autoload remain inside the trusted database owner.
        instance = await DuckDBInstance.create(request.path, { threads: '2', autoinstall_known_extensions: 'false', autoload_known_extensions: 'false' })
        try {
          connection = await instance.connect()
          await initializeMemorySchema({ execute })
        } catch (error) {
          connection?.closeSync(); connection = undefined
          instance.closeSync(); instance = undefined
          throw error
        }
        return null
      }
      if (!connection) throw new Error('MEMORY_DATABASE_CLOSED')
      if (request.kind === 'execute') {
        if (request.transactionId !== transactionId) throw new Error('MEMORY_TRANSACTION_MISMATCH')
        return execute(request.sql)
      }
      if (request.kind === 'begin') {
        if (transactionId) throw new Error('MEMORY_TRANSACTION_ACTIVE')
        await execute('BEGIN TRANSACTION')
        transactionId = request.transactionId
        return null
      }
      if (request.kind === 'commit' || request.kind === 'rollback') {
        if (!transactionId || request.transactionId !== transactionId) throw new Error('MEMORY_TRANSACTION_MISMATCH')
        try { await execute(request.kind === 'commit' ? 'COMMIT' : 'ROLLBACK') }
        finally { transactionId = undefined }
        return null
      }
      if (transactionId) throw new Error('MEMORY_TRANSACTION_ACTIVE')
      await execute('CHECKPOINT')
      if (request.kind === 'close') {
        connection.closeSync(); connection = undefined
        instance!.closeSync(); instance = undefined
      }
      return null
    },
  }
}
