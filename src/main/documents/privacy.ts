import { z } from 'zod'
import type { Clock } from '../clock'
import { redactFixed, redactSecrets } from '../privacy/redact'
import { dateFromQuote } from '../mail/privacy'
import { DocumentFailure } from './reader'
import { ModelFailure } from '../model/types'
import { MemoryFailure } from '../memory/model'
import type { DocumentFormat, DocumentScenarioId } from '../../shared'

export interface DocumentPrivacyInput { text: string; format: DocumentFormat; pageCount: number | null }
export interface DocumentPrivacyModel { readonly isolated?: boolean; readonly source: 'real' | 'fake'; readonly ready: boolean; organize(input: DocumentPrivacyInput, signal: AbortSignal): Promise<unknown> }
const outputSchema = z.strictObject({ markdown: z.string().min(1).max(100_000), deadline: z.strictObject({ iso: z.iso.datetime({ offset: true }), quote: z.string().min(1).max(300) }).nullable() })
/** Long output is user-only. The caller may publish only deadlineIso; never markdown or quotes. */
export async function organizeDocument(input: DocumentPrivacyInput, model: DocumentPrivacyModel | null, clock: Clock, signal: AbortSignal) {
  if (!model?.ready) throw new DocumentFailure(model?.isolated === false ? 'not-configured' : 'privacy-unavailable')
  const local = new AbortController(); const combined = AbortSignal.any([signal, local.signal]); const cancel = clock.after(90_000, () => local.abort())
  let remove = () => {}
  let result: unknown
  try {
    const aborted = new Promise<never>((_resolve, reject) => {
      const listener = () => reject(new Error('PRIVACY_STOPPED')); combined.addEventListener('abort', listener, { once: true }); remove = () => combined.removeEventListener('abort', listener)
      if (combined.aborted) listener()
    })
    result = await Promise.race([model.organize({ ...input, text: (model.isolated === false ? redactSecrets : redactFixed)(input.text) }, combined), aborted])
  } catch (error) {
    if (signal.aborted) throw new DocumentFailure('operation-cancelled')
    if (model.isolated !== false) throw new DocumentFailure('privacy-unavailable')
    if (error instanceof MemoryFailure && error.code === 'budget-exceeded') throw new DocumentFailure('budget-exceeded')
    const kind = error instanceof ModelFailure ? error.kind : 'network'
    throw new DocumentFailure(kind === 'configuration' ? 'configuration-failed' : kind === 'quota' ? 'quota-exhausted' : kind === 'upstream' ? 'upstream-busy' : kind === 'invalid-output' ? 'invalid-model-output' : kind === 'content-filtered' ? 'content-filtered' : 'connection-failed')
  }
  finally { cancel(); remove() }
  if (combined.aborted) throw new DocumentFailure(signal.aborted ? 'operation-cancelled' : model.isolated === false ? 'connection-failed' : 'privacy-unavailable')
  try {
    const output = outputSchema.parse(result)
    let deadlineIso: string | null = null
    if (output.deadline) {
      if (!input.text.includes(output.deadline.quote) || !/\d{4}(?:\s*年|-)/.test(output.deadline.quote) || redactFixed(output.deadline.quote) !== output.deadline.quote) throw new Error('UNGROUNDED_DATE')
      deadlineIso = dateFromQuote(output.deadline.quote, 0, clock)
      if (clock.parse(deadlineIso) !== clock.parse(output.deadline.iso)) throw new Error('DATE_MISMATCH')
    }
    const markdown = (model.isolated === false ? redactSecrets : redactFixed)(output.markdown)
    if (!markdown.trim() || markdown.includes('\0')) throw new Error('INVALID_DOCUMENT')
    return { markdown, deadlineIso }
  } catch { throw new DocumentFailure(model.isolated === false ? 'invalid-model-output' : 'privacy-invalid-output') }
}
export function createFakeDocumentModel(clock: Clock) {
  let scenario: DocumentScenarioId = 'ready'
  const model: DocumentPrivacyModel = { source: 'fake', ready: true, organize: async (input, signal) => {
    signal.throwIfAborted()
    if (scenario === 'privacy-failure') throw new Error('SYNTHETIC_FILTER_FAILED')
    if (scenario === 'malicious') return { markdown: 'UNTRUSTED_PRIVATE_OUTPUT', deadline: null, instruction: 'not an allowed field' }
    const quote = input.text.match(/\d{4}\s*年\s*\d{1,2}\s*月\s*\d{1,2}\s*日(?:\s*[（(][^）)]*[）)])?\s*\d{1,2}:\d{2}|\d{4}-\d{2}-\d{2}[ T]\d{1,2}:\d{2}/)?.[0]
    return { markdown: '# 合成资料整理（fake）\n\n这是开发用确定性排版，不代表真实模型的整理质量。\n\n## 核对材料\n\n' + input.text + '\n\nUSER_ONLY_DOCUMENT_RESULT\n',
      deadline: quote ? { iso: dateFromQuote(quote, 0, clock), quote } : null }
  } }
  return { model, scenario: () => scenario, select: (value: DocumentScenarioId) => { scenario = value } }
}
