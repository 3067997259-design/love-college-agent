/** Internal main-to-utility protocol. Never exposed through preload or debug dispatch. */
export type MemoryDatabaseRequest =
  | { kind: 'open'; path: string }
  | { kind: 'execute'; sql: string; transactionId?: string }
  | { kind: 'begin' | 'commit' | 'rollback'; transactionId: string }
  | { kind: 'checkpoint' | 'close' }

export interface MemoryDatabaseChannel {
  request(request: MemoryDatabaseRequest): Promise<unknown>
}

export interface MemoryDatabaseReply {
  id: string
  ok: boolean
  result?: unknown
  /** No SQL, local path, or stored content in process failures. */
  error?: 'storage_failed' | 'invalid_request'
}
