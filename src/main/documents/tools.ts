import { z } from 'zod'
import type { HarnessTool } from '../harness/tools'
import type { DocumentService } from './service'

export function documentTools(service: DocumentService): HarnessTool[] {
  return [{ definition: { name: 'get_processed_files', description: 'List uploaded files and processing status. To read an authorized original in this turn, use read_uploaded_file with its documentId. A receipt or ready status alone does not mean the source has been read.', parameters: { type: 'object', properties: {}, additionalProperties: false } },
    templateId: 'document.status', validate: (input) => z.strictObject({}).safeParse(input).success,
    run: async () => {
      const files = service.view().jobs.map((job) => ({ documentId: job.id, fileName: job.displayName, format: job.format, status: job.status,
        pageCount: job.pageCount, deadlineIso: job.deadlineIso, source: job.source, trust: 'untrusted' }))
      const value = JSON.parse(JSON.stringify({ files })) as Record<string, never>
      return { ok: true, raw: value, visible: value }
    } }, { definition: { name: 'read_uploaded_file', description: 'Request one uploaded file as source for the current turn. Only user-authorized main-model sources are allowed; isolated or cancelled files cannot be opened. The source is supplied separately after this tool returns, never in this status receipt.', parameters: { type: 'object', properties: { documentId: { type: 'string', minLength: 1, maxLength: 128 } }, required: ['documentId'], additionalProperties: false } },
    templateId: 'document.read', validate: (input) => z.strictObject({ documentId: z.string().min(1).max(128) }).safeParse(input).success,
    run: async (input, context) => { const error = service.requestMainSource(String(input.documentId), context.turnId); const value: Record<string, string | boolean> = error ? { error } : { documentId: String(input.documentId), sourceRequested: true }; return { ok: !error, raw: value, visible: value } } }]
}
