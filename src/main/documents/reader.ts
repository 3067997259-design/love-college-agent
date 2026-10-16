import { spawn } from 'node:child_process'
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
    // Run the bundled Electron Node runtime in a separate process. Native PDF addons must not
    // share Electron's main-process heap. Never inherit provider/developer configuration.
    const worker = spawn(process.execPath, ['--max-old-space-size=192', join(__dirname, 'documentWorker.cjs')], { windowsHide: true,
      env: { ELECTRON_RUN_AS_NODE: '1', SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, TMP: process.env.TMP },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'], serialization: 'advanced' })
    worker.stdout?.resume(); worker.stderr?.resume()
    let settled = false
    const finish = (value?: ExtractedDocument) => {
      if (settled) return; settled = true; cancel(); signal.removeEventListener('abort', aborted); worker.kill()
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
    if (signal.aborted) finish(); else worker.send(bytes, (error) => { if (error) finish() })
  })
}
