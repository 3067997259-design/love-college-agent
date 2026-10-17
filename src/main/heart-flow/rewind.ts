import { randomUUID, createHash } from 'node:crypto'
import { z } from 'zod'
import type { AppCommand, FlowRewindView, PublicErrorCode } from '../../shared'
import type { Clock } from '../clock'
import type { SessionStore } from '../store/session'
import { appliedDeskChanges } from './changes'
import { contentHash } from './desk'

export const rewindSchema = z.strictObject({
  id: z.string().uuid(), flowId: z.string().min(1).max(128), changeId: z.string().uuid(), createdAtMs: z.number().int().nonnegative(),
  status: z.enum(['awaiting-confirmation', 'running', 'completed', 'failed', 'cancelled', 'interrupted']),
  paths: z.array(z.string().min(1).max(180)).min(1).max(300), changeCount: z.number().int().min(1).max(500), appliedFiles: z.number().int().min(0).max(300),
  error: z.enum(['conflict', 'write-failed', 'unavailable']).optional(),
})
type Edit = { path: string; before: string | null; after: string | null; rewinds: string[] }
type Rows = ReturnType<SessionStore['records']>
export function planRewind(rows: Rows, flowId: string, changeId: string, read: (path: string) => string | null) {
  const changes = appliedDeskChanges(rows).filter((row) => row.flowId === flowId)
  const index = changes.findIndex((row) => row.id === changeId && !row.undoes && !row.rewindId)
  if (index < 0) throw new Error('REWIND_INVALID')
  const range = changes.slice(index); if (range.length > 500) throw new Error('REWIND_LIMIT')
  const edits = new Map<string, Edit>()
  for (const change of range) {
    const key = process.platform === 'win32' ? change.path.toUpperCase() : change.path
    const edit = edits.get(key)
    if (edit && edit.path !== change.path) throw new Error('REWIND_PATH_ALIAS')
    if (edit && contentHash(edit.before) !== contentHash(change.before)) throw new Error('REWIND_UNRECORDED_CHANGE')
    const next = edit ?? { path: change.path, before: change.before, after: change.before, rewinds: [] }
    next.before = change.after
    if (!change.undoes && !change.rewindId) next.rewinds.push(change.id)
    edits.set(key, next)
  }
  if (edits.size > 300) throw new Error('REWIND_LIMIT')
  for (const edit of edits.values()) if (contentHash(read(edit.path)) !== contentHash(edit.before)) throw new Error('REWIND_CONFLICT')
  const fingerprint = createHash('sha256').update(JSON.stringify(range.map((row) => [row.id, row.path, contentHash(row.before), contentHash(row.after), row.undoes ?? null, row.rewindId ?? null]))).digest('hex')
  return { flowId, changeId, fingerprint, changeCount: range.length, edits: [...edits.values()].reverse() }
}
export function createFlowRewind(options: { store: SessionStore; clock: Clock; flowId(): string | null; allowed(): boolean; read(path: string): string | null;
  write(edit: Edit, id: string): void; changed(): void; fatal?(): void }) {
  const rows = () => options.store.history?.() ?? options.store.records()
  type Plan = ReturnType<typeof planRewind>
  type Job = { plan: Plan; state: z.infer<typeof rewindSchema>; publishing: boolean }
  let job: Job | undefined
  const count = (id: string) => appliedDeskChanges(rows()).filter((row) => row.rewindId === id).length
  const save = (state: z.infer<typeof rewindSchema>) => { options.store.append({ type: 'flow/rewind', ...state }); options.changed() }
  // Reconcile durable per-file outcomes first; never replay a saved approval or remaining writes.
  const latest = new Map(rows().flatMap((row) => row.type === 'flow/rewind' ? [[row.id, row] as const] : []))
  for (const row of latest.values()) if (row.status === 'running' || row.status === 'awaiting-confirmation') {
    save({ ...rewindSchema.parse({ id: row.id, flowId: row.flowId, changeId: row.changeId, createdAtMs: row.createdAtMs, status: 'interrupted', paths: row.paths, changeCount: row.changeCount, appliedFiles: count(row.id) }) })
  }
  const finish = (current: Job, status: FlowRewindView['status'], error?: FlowRewindView['error']) => {
    current.publishing = false; current.state = { ...current.state, status, appliedFiles: count(current.state.id), ...(error ? { error } : {}) }; save(current.state)
  }
  const cancel = () => { if (job && ['awaiting-confirmation', 'running'].includes(job.state.status)) finish(job, 'cancelled') }
  const run = async (current: Job) => {
    for (const edit of current.plan.edits) {
      if (current.state.status !== 'running') return
      if (!options.allowed() || options.flowId() !== current.plan.flowId) { finish(current, 'cancelled'); return }
      try {
        if (contentHash(options.read(edit.path)) !== contentHash(edit.before)) { finish(current, 'failed', 'conflict'); return }
        current.publishing = true; options.write(edit, current.state.id); current.publishing = false
      } catch { finish(current, 'failed', 'write-failed'); return }
      if (current.state.status !== 'running') return
      current.state.appliedFiles = count(current.state.id); save(current.state)
      await new Promise<void>((done) => options.clock.after(0, done))
    }
    if (current.state.status === 'running') finish(current, 'completed')
  }
  return {
    cancel,
    active: () => job?.state.status === 'running',
    publishing: (id: string) => job?.state.status === 'running' && job.state.id === id && job.publishing,
    view: (): FlowRewindView | undefined => {
      const row = rows().findLast((row) => row.type === 'flow/rewind' && row.flowId === options.flowId())
      if (row?.type !== 'flow/rewind') return
      return { id: row.id, changeId: row.changeId, createdAtMs: row.createdAtMs, status: row.status, paths: row.paths, changeCount: row.changeCount, appliedFiles: row.appliedFiles, ...(row.error ? { error: row.error } : {}) }
    },
    dispatch: (command: AppCommand): PublicErrorCode | undefined => {
      if (command.type === 'flow.rewind.cancel') { if (!job || job.state.id !== command.rewindId || !['awaiting-confirmation', 'running'].includes(job.state.status)) return 'invalid-command'; cancel(); return }
      if (!options.allowed() || !options.flowId() || job?.state.status === 'running') return 'unavailable'
      if (command.type === 'flow.rewind.prepare') {
        let plan: Plan; try { plan = planRewind(rows(), options.flowId()!, command.changeId, options.read) } catch { return 'invalid-command' }
        cancel(); job = { plan, publishing: false, state: { id: randomUUID(), flowId: plan.flowId, changeId: plan.changeId, createdAtMs: options.clock.nowMs(), status: 'awaiting-confirmation', paths: plan.edits.map((edit) => edit.path), changeCount: plan.changeCount, appliedFiles: 0 } }
        save(job.state); return
      }
      if (command.type !== 'flow.rewind.apply' || !job || job.state.status !== 'awaiting-confirmation' || job.state.id !== command.rewindId) return 'invalid-command'
      const current = job
      try { if (planRewind(rows(), current.plan.flowId, current.plan.changeId, options.read).fingerprint !== current.plan.fingerprint) throw new Error('REWIND_CHANGED') }
      catch { finish(current, 'failed', 'conflict'); return 'invalid-command' }
      current.state.status = 'running'; save(current.state)
      void run(current).catch(() => { current.publishing = false; options.fatal?.() }); return
    },
  }
}
