import { Worker } from 'node:worker_threads'
import { join } from 'node:path'
import type { Clock } from '../clock'
import type { DocumentFormat, PublicErrorCode } from '../../shared'

export const MAX_FILE_BYTES = 10 * 1024 * 1024
export class DocumentFailure extends Error { constructor(readonly code: PublicErrorCode) { super('DOCUMENT_OPERATION_FAILED') } }
export interface ExtractedDocument { text: string; pageCount: number | null }
export async function extractDocument(bytes: Uint8Array, format: DocumentFormat, clock: Clock, signal: AbortSignal): Promise<ExtractedDocument> {
  if (!bytes.length || bytes.length > MAX_FILE_BYTES) throw new DocumentFailure('file-too-large')
  signal.throwIfAborted()
  if (format !== 'pdf') {
    try {
      const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
      if (!text.trim() || text.length > 120_000 || text.includes('\0')) throw new Error('TEXT_INVALID')
      return { text, pageCount: null }
    } catch { throw new DocumentFailure('document-parse-failed') }
  }
  if (Buffer.from(bytes.subarray(0, 5)).toString() !== '%PDF-') throw new DocumentFailure('document-parse-failed')
  return new Promise<ExtractedDocument>((resolve, reject) => {
    const worker = new Worker(join(__dirname, 'documentWorker.cjs'), { resourceLimits: { maxOldGenerationSizeMb: 128, stackSizeMb: 4 }, stdout: true, stderr: true })
    worker.stdout?.resume(); worker.stderr?.resume()
    let settled = false
    const finish = (value?: ExtractedDocument) => {
      if (settled) return; settled = true; cancel(); signal.removeEventListener('abort', aborted); void worker.terminate()
      if (value) resolve(value); else reject(new DocumentFailure(signal.aborted ? 'unavailable' : 'document-parse-failed'))
    }
    const aborted = () => finish()
    const cancel = clock.after(15_000, () => finish())
    signal.addEventListener('abort', aborted, { once: true })
    worker.once('message', (result: { ok: boolean; text?: unknown; pageCount?: unknown }) => {
      if (result.ok && typeof result.text === 'string' && result.text.trim() && result.text.length <= 120_000 && Number.isInteger(result.pageCount) && Number(result.pageCount) >= 1 && Number(result.pageCount) <= 60) finish({ text: result.text, pageCount: Number(result.pageCount) })
      else finish()
    })
    worker.once('error', () => finish()); worker.once('exit', () => finish())
    if (signal.aborted) finish(); else worker.postMessage(bytes)
  })
}
