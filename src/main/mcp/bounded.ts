import type { Clock } from '../clock'
import type { PublicErrorCode } from '../../shared'

export class McpFailure extends Error { constructor(readonly code: PublicErrorCode) { super('MCP_OPERATION_FAILED') } }
export async function boundedMcp<T>(clock: Clock, parent: AbortSignal, work: (signal: AbortSignal) => Promise<T>, timeoutMs = 30_000): Promise<T> {
  parent.throwIfAborted(); const abort = new AbortController()
  let remove = () => {}; let timedOut = false
  const stop = clock.after(timeoutMs, () => { timedOut = true; abort.abort() })
  const forward = () => abort.abort(); parent.addEventListener('abort', forward, { once: true })
  try {
    return await Promise.race([work(abort.signal), new Promise<never>((_resolve, reject) => {
      const aborted = () => reject(new McpFailure(timedOut ? 'connection-failed' : 'operation-cancelled'))
      remove = () => abort.signal.removeEventListener('abort', aborted); abort.signal.addEventListener('abort', aborted, { once: true }); if (abort.signal.aborted) aborted()
    })])
  } finally { stop(); remove(); parent.removeEventListener('abort', forward) }
}
