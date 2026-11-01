import { app, utilityProcess } from 'electron'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type { Clock } from '../../clock'
import { systemClock } from '../../clock'
import { createMemoryDatabaseClient } from './client'
import type { MemoryDatabaseReply } from './protocol'

/** Main alone chooses the file and owns this channel. Renderer never receives it. */
export async function openUtilityMemoryDatabase(options: { path: string; clock: Clock; workerPath?: string; deadlineClock?: Clock }) {
  // Vite may split this lazy host into out/main/chunks. Resolve the worker
  // from the application root, including an installed app.asar, not the chunk.
  const child = utilityProcess.fork(options.workerPath ?? join(app.getAppPath(), 'out/main/memoryWorker.cjs'), [], {
    serviceName: 'LCA Memory Storage', stdio: 'pipe',
  })
  const deadlines = options.deadlineClock ?? systemClock
  let exited = false
  const pending = new Map<string, { resolve(value: unknown): void; reject(error: Error): void; cancel(): void }>()
  const fail = () => {
    exited = true
    if (client.status().state !== 'closed') client.failed()
    for (const request of pending.values()) { request.cancel(); request.reject(new Error('MEMORY_HOST_EXITED')) }
    pending.clear()
  }
  const client = createMemoryDatabaseClient({ request: request => new Promise((resolve, reject) => {
    if (exited) { reject(new Error('MEMORY_HOST_EXITED')); return }
    const id = randomUUID()
    const cancel = deadlines.after(60_000, () => {
      // An unobserved write is never retried. Killing closes the writer, then
      // operationId reconciliation on next open resolves its actual outcome.
      fail(); child.kill()
    })
    pending.set(id, { resolve, reject, cancel })
    try { child.postMessage({ id, request }) }
    catch { fail(); child.kill() }
  }) }, options.clock)
  child.on('message', (reply: MemoryDatabaseReply) => {
    const request = pending.get(reply.id)
    if (!request) return
    pending.delete(reply.id); request.cancel()
    if (reply.ok) request.resolve(reply.result)
    else request.reject(new Error('MEMORY_STORAGE_FAILED'))
  })
  child.once('exit', fail)
  // Drain native stderr without forwarding private SQL diagnostics to logs.
  child.stderr?.resume(); child.stdout?.resume()
  try { await client.open(options.path) }
  catch (error) { child.kill(); throw error }
  return {
    ...client,
    pid: () => child.pid,
    async close() { try { await client.close() } finally { child.kill() } },
  }
}
