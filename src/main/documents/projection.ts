import type { JournalRecord } from '../journal/schema'
import type { AttachmentRecord, DocumentJob } from './schema'
import type { CampusArtifact } from '../campus/schema'
import type { z } from 'zod'
import type { documentCompletedSchema } from './schema'

export function projectDocuments(records: readonly JournalRecord[]) {
  const jobs: DocumentJob[] = []; const attachments: AttachmentRecord[] = []; const completed: z.infer<typeof documentCompletedSchema>[] = []
  const artifacts: CampusArtifact[] = []
  for (const row of records) {
    if (row.type === 'document/job') {
      const index = jobs.findIndex((job) => job.view.id === row.job.view.id)
      if (index < 0) jobs.push(structuredClone(row.job)); else {
        if ((jobs[index].sourceRef !== null && jobs[index].sourceRef !== row.job.sourceRef) || jobs[index].attachmentId !== row.job.attachmentId || jobs[index].attempt > row.job.attempt) throw new Error('DOCUMENT_REVISION_INVALID')
        jobs[index] = structuredClone(row.job)
      }
    } else if (row.type === 'document/attachment') {
      if (!attachments.some((attachment) => attachment.view.id === row.attachment.view.id)) attachments.push(row.attachment)
    } else if (row.type === 'document/completed') {
      const job = jobs.find((job) => job.view.id === row.documentId)
      if (!job || job.attempt !== row.attempt || job.view.status !== 'processing') throw new Error('DOCUMENT_COMPLETION_INVALID')
      job.view = { ...job.view, status: 'ready', updatedAtMs: row.atMs, pageCount: row.facts.pageCount, deadlineIso: row.facts.deadlineIso }
      completed.push({ sharedWithMain: row.sharedWithMain, documentId: row.documentId, attempt: row.attempt, artifact: row.artifact, facts: row.facts }); artifacts.push(row.artifact)
    }
  }
  return structuredClone({ jobs, attachments, completed, artifacts })
}
