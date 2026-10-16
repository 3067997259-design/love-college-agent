import { createHash } from 'node:crypto'
import type { JournalRecord } from '../../journal/schema'
import type { LifeWorkItem } from '../../../shared'
import { draftSchema, materialSchema, workItemSchema } from './schema'
export const workHash = (text: string) => createHash('sha256').update(text).digest('hex')
export const workPath = (workId: string, step: number) => `自主作品/${workId}/${step}.md`
/** Validate private replay inputs before they can be restored into the writable desk. */
export function workRecords(rows: readonly JournalRecord[]) {
  const materials = new Map<string, ReturnType<typeof materialSchema.parse>>()
  const jobs = new Map<string, LifeWorkItem>()
  const drafts = new Map<string, ReturnType<typeof draftSchema.parse>>()
  const committed = new Map<string, ReturnType<typeof draftSchema.parse>[]>()
  let owner: { userId: string; characterId: string } | undefined
  for (const row of rows) {
    if (row.type === 'session/header') owner = row
    if (row.type === 'life/material') {
      const material = materialSchema.parse(row.material)
      if (workHash(material.text) !== material.sha256 || material.id !== material.sha256 || material.path !== `合成材料/${material.id}.md`) throw new Error('WORK_INVALID')
      materials.set(material.id, material)
    }
    if (row.type === 'life/work-state') {
      const job = workItemSchema.parse(row.job)
      const checkpoints = committed.get(job.id) ?? []; const last = checkpoints.at(-1); const prior = jobs.get(job.id)
      if (!owner || job.id !== workHash(JSON.stringify([owner.userId, owner.characterId, job.dayKey, job.kind])) || !materials.has(job.materialId)
        || job.completedSteps !== checkpoints.length || job.status === 'completed' && (checkpoints.length !== 3 || job.completedAtMs === null)
        || job.output?.sha256 !== last?.sha256 || job.output?.path !== last?.path || job.output && job.output.byteLength !== Buffer.byteLength(last!.text)
        || prior && (prior.materialId !== job.materialId || prior.source !== job.source || prior.createdAtMs !== job.createdAtMs)) throw new Error('WORK_INVALID')
      jobs.set(job.id, job)
    }
    if (row.type === 'life/work-draft') {
      const draft = draftSchema.parse(row.draft)
      if (!jobs.has(draft.workId) || draft.step !== (committed.get(draft.workId)?.length ?? 0) + 1 || draft.path !== workPath(draft.workId, draft.step) || workHash(draft.text) !== draft.sha256 || drafts.has(draft.id)) throw new Error('WORK_INVALID')
      drafts.set(draft.id, draft)
    }
    if (row.type === 'life/work-commit') {
      const draft = drafts.get(row.draftId); if (!draft || draft.workId !== row.workId) throw new Error('WORK_INVALID')
      const checkpoints = committed.get(row.workId) ?? []
      if (draft.step !== checkpoints.length + 1) throw new Error('WORK_INVALID')
      checkpoints.push(draft); committed.set(row.workId, checkpoints)
    }
  }
  return { materials, jobs, drafts, committed }
}
