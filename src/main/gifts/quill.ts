import type { QuillView } from '../../shared'
import type { Clock } from '../clock'
import type { SessionStore } from '../store/session'
import type { Scheduler } from '../scheduler'
import type { ArtifactStore } from '../artifacts/store'
import type { MemoryRepository } from '../memory/repository'
import { memoryDigest, seenFragments } from '../memory/seen'
import { sourceRef } from '../memory/model'
import type { JournalRecord } from '../journal/schema'
import type { CampusArtifact } from '../campus/schema'
import type { HarnessTool } from '../harness/tools'

interface WorkProof { id: string; source: 'mail' | 'document'; artifacts: CampusArtifact[]; summary: string }

export function projectQuill(records: readonly JournalRecord[]): QuillView | undefined {
  const first = records.find((row) => row.type === 'quill/ready'); if (!first || first.type !== 'quill/ready') return
  const given = records.find((row) => row.type === 'quill/given' && row.id === first.id)
  return { id: first.id, kind: 'quill', state: given ? 'given' : 'ready', createdAtMs: first.atMs, givenAtMs: given?.atMs ?? null, sourceMemoryId: first.sourceMemoryId, sourceEventId: first.sourceEventId }
}
/** First gift is a deterministic consequence of a real local delivery, then-seen evidence, and rest. No persona text or Rodin call. */
export function createQuillService(options: { clock: Clock; store: SessionStore; scheduler: Scheduler; artifacts: ArtifactStore; memory: MemoryRepository;
  emit(source: 'mail' | 'document', text: string, id: string): void; changed(): void; isBusy(): boolean }) {
  let disposed = false
  const records = () => options.store.history?.() ?? options.store.records()
  const read = () => projectQuill(records())
  const reconcile = () => {
    if (disposed || options.store.projection().lightsOut) return
    const rows = records(); let quill = projectQuill(rows)
    if (!quill) {
      const proof = rows.flatMap((row): WorkProof[] => row.type === 'campus/exported' ? [{ id: 'campus:' + row.candidateId + ':' + row.revision, source: 'mail', artifacts: row.artifacts, summary: '已导出确认事项的日历和整理文件' }]
        : row.type === 'document/completed' ? [{ id: 'document:' + row.documentId + ':' + row.attempt, source: 'document' as const, artifacts: [row.artifact], summary: '已生成资料整理文件' }] : []).find((proof) => {
          try { for (const artifact of proof.artifacts) options.artifacts.read(artifact); return true } catch { return false }
        })
      if (!proof) return
      const eventBase = 'first-work:' + memoryDigest(proof.id)
      const emitted = rows.filter((row) => row.type === 'inbox/event' && (row.id === eventBase || row.id.startsWith(eventBase + ':')))
      const dropped = new Set(rows.flatMap((row) => row.type === 'inbox/drop' ? row.ids : []))
      const existing = emitted.findLast((row) => row.type === 'inbox/event' && !dropped.has(row.id))
      const eventId = existing?.type === 'inbox/event' ? existing.id : eventBase + ':' + emitted.length
      const visibleReceipt = 'work-' + memoryDigest(proof.id).slice(0, 16)
      const visibleFact = JSON.stringify({ workCompleted: visibleReceipt, summary: proof.summary, artifactCount: proof.artifacts.length })
      if (!existing) options.emit(proof.source, visibleFact, eventId)
      const fragment = seenFragments(records()).find((fragment) => fragment.text.includes(visibleReceipt) && fragment.text.includes(proof.summary))
      if (!fragment) return
      const scope = options.store.scope; const sourceMemoryId = 'mem:' + memoryDigest(JSON.stringify([scope.userId, scope.characterId, 'experience', proof.summary]))
      options.memory.append({ type: 'memory/batch', batchId: memoryDigest('first-work:' + proof.id), keys: [], source: proof.artifacts[0].view.source,
        entries: [{ id: sourceMemoryId, text: proof.summary, kind: 'experience', topic: null, supersedes: [], sources: [sourceRef(fragment)] }] })
      options.store.append({ type: 'quill/ready', id: 'quill:' + memoryDigest(JSON.stringify([scope.userId, scope.characterId])), sourceMemoryId, sourceEventId: eventId })
      quill = read(); options.changed()
    }
    const state = options.store.projection()
    if (quill?.state === 'ready' && state.mode === 'rest' && state.pomodoro.phase !== 'focus' && !options.isBusy()) {
      options.store.append({ type: 'quill/given', id: quill.id }); options.changed()
    }
  }
  options.scheduler.schedule('quill.first-gift', options.clock.nowMs() + 1000, reconcile, { everyMs: 1000 })
  return { read, reconcile, dispose: () => { disposed = true; options.scheduler.cancel('quill.first-gift') } }
}
export type QuillService = ReturnType<typeof createQuillService>
export function quillTools(service: QuillService): HarnessTool[] {
  return [{ definition: { name: 'get_first_gift', description: 'Read the actual first-gift status and its source memory. Ready is not yet given. The prebuilt quill is not a live Rodin result.', parameters: { type: 'object', properties: {}, additionalProperties: false } },
    templateId: 'gift.read', validate: (input) => Object.keys(input).length === 0, run: async (_input, { signal }) => {
      signal.throwIfAborted(); const gift = service.read(); const visible = JSON.parse(JSON.stringify({ gift: gift ?? null })) as Record<string, never>; return { ok: true, raw: visible, visible }
    } }]
}
