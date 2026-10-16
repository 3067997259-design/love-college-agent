import { z } from 'zod'
import type { HarnessTool } from '../harness/tools'
import type { DocumentService } from './service'

export function documentTools(service: DocumentService): HarnessTool[] {
  return [{ definition: { name: 'get_processed_files', description: 'Read validated file metadata and status only. No source text, generated document content, private paths, or user-only file reader is available.', parameters: { type: 'object', properties: {}, additionalProperties: false } },
    templateId: 'document.status', validate: (input) => z.strictObject({}).safeParse(input).success,
    run: async () => {
      const files = service.view().jobs.map((job) => ({ documentId: job.id, fileName: job.displayName, format: job.format, status: job.status,
        pageCount: job.pageCount, deadlineIso: job.deadlineIso, source: job.source, trust: 'untrusted' }))
      const value = JSON.parse(JSON.stringify({ files })) as Record<string, never>
      return { ok: true, raw: value, visible: value }
    } }]
}
