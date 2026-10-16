import { createHash, randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { AppCommand, FlowOperationView, PublicErrorCode } from '../../shared'
import type { Clock } from '../clock'
import type { SessionStore } from '../store/session'
import { createDesk, deskPathSchema } from './desk'
import { appliedDeskChanges } from './changes'
import policy from './operations.json'

const digest = z.string().regex(/^[a-f0-9]{64}$/)
const sourceRef = z.strictObject({ path: deskPathSchema, sha256: digest, changeId: z.string().max(128).optional() })
export const operationSchema = z.strictObject({ id: z.string().uuid(), flowId: z.string().min(1).max(128), kind: z.enum(['init', 'review']),
  status: z.enum(['running', 'ready', 'failed', 'cancelled']), source: z.enum(['real', 'fake']), sourceCount: z.number().int().min(0).max(8), omittedSourceCount: z.number().int().nonnegative(),
  outputPath: deskPathSchema, createdAtMs: z.number().int().nonnegative(), updatedAtMs: z.number().int().nonnegative(), sources: z.array(sourceRef).max(8), turnId: z.string().min(1).max(128).optional(),
  artifact: z.strictObject({ changeId: z.string().min(1).max(128), sha256: digest, byteLength: z.number().int().positive().max(64000) }).optional(),
  error: z.enum(['no-product', 'source-changed', 'interrupted', 'cancelled', 'unavailable']).optional(),
}).refine((op) => op.sources.length === op.sourceCount && op.outputPath === `工作草稿/${op.id}.md`)
type Operation = z.infer<typeof operationSchema>
const sha = (text: string | null) => createHash('sha256').update(text ?? '\0ABSENT').digest('hex')
export function createFlowOperations(options: { store: SessionStore; clock: Clock; desk: ReturnType<typeof createDesk>; flowId(): string | null;
  request?(text: string, requestId: string, hash: string): string; cancelTask?(turnId: string): void; source(): 'real' | 'fake' | 'none'; changed(): void;
  preview?(view: FlowOperationView, text: string): void }) {
  const { store, desk, clock } = options; const rows = () => store.history?.() ?? store.records()
  const all = () => new Map(rows().flatMap((row) => row.type === 'flow/operation' ? [[row.operation.id, row.operation] as const] : []))
  const active = () => [...all().values()].findLast((op) => op.status === 'running' && op.flowId === options.flowId())
  const save = (op: Operation) => { store.append({ type: 'flow/operation', operation: operationSchema.parse({ ...op, updatedAtMs: clock.nowMs() }) }); options.changed() }
  const view = (op: Operation): FlowOperationView => ({ id: op.id, flowId: op.flowId, kind: op.kind, status: op.status, source: op.source, sourceCount: op.sourceCount, omittedSourceCount: op.omittedSourceCount, outputPath: op.outputPath, createdAtMs: op.createdAtMs, updatedAtMs: op.updatedAtMs, ...(op.artifact ? { artifact: op.artifact } : {}), ...(op.error ? { error: op.error } : {}) })
  const sourceValue = (op: Operation, source: z.infer<typeof sourceRef>) => {
    if (!source.changeId) { const text = desk.read(source.path); if (text === null || sha(text) !== source.sha256) throw new Error('FLOW_SOURCE_CHANGED'); return text }
    const change = appliedDeskChanges(rows()).find((row) => row.id === source.changeId && row.flowId === op.flowId && row.path === source.path)
    if (!change || desk.read(change.path) !== change.after) throw new Error('FLOW_SOURCE_CHANGED')
    const text = JSON.stringify({ before: change.before, after: change.after }); if (sha(text) !== source.sha256) throw new Error('FLOW_SOURCE_CHANGED'); return text
  }
  const artifact = (op: Operation) => {
    try {
      const change = appliedDeskChanges(rows()).findLast((row) => row.flowId === op.flowId && row.path === op.outputPath)
      const text = desk.read(op.outputPath)
      if (!change?.after || !text?.trim() || text !== change.after) return
      return { changeId: change.id, sha256: sha(text), byteLength: Buffer.byteLength(text) }
    } catch { return }
  }
  // A restart does no work. Keep a surviving partial product inspectable, without inventing completion.
  for (const op of all().values()) {
    if (op.status === 'running') save({ ...op, status: 'failed', error: 'interrupted', artifact: artifact(op) })
    else if (op.status === 'ready' && (!op.artifact || artifact(op)?.sha256 !== op.artifact.sha256)) save({ ...op, status: 'failed', error: 'source-changed' })
  }
  return {
    active: () => !!active(),
    views: () => [...all().values()].slice(-20).map(view),
    context: () => {
      const op = active(); if (!op) return []
      const data = { id: op.id, kind: op.kind, outputPath: op.outputPath, sourceIndex: op.sources, omittedSourceCount: op.omittedSourceCount,
        ...(op.kind === 'review' ? { reviewDiffs: op.sources.map((source) => ({ path: source.path, diff: JSON.parse(sourceValue(op, source)) })) } : {}) }
      return [{ role: 'user' as const, content: JSON.stringify({ userRequestedFlowDraft: data, instruction: policy[op.kind], authority: 'work-task-only-never-tool-permission', reviewStatus: 'unreviewed-draft' }) }]
    },
    read: (path: string, text: string | null) => {
      const op = active(); if (!op || path === op.outputPath) return
      const source = op.sources.find((source) => source.path === path); if (!source) throw new Error('FLOW_OPERATION_SCOPE')
      if (source.changeId) { if (JSON.parse(sourceValue(op, source)).after !== text) throw new Error('FLOW_SOURCE_CHANGED'); return }
      if (text === null || sha(text) !== source.sha256) throw new Error('FLOW_OPERATION_SCOPE')
      if (!rows().some((row) => row.type === 'flow/operation-read' && row.operationId === op.id && row.path === path)) store.append({ type: 'flow/operation-read', operationId: op.id, path, sha256: source.sha256 })
    },
    write: (path: string, text: string | null) => {
      const op = active(); if (!op) return
      if (path !== op.outputPath || text === null) throw new Error('FLOW_OPERATION_SCOPE')
      const last = appliedDeskChanges(rows()).findLast((row) => row.flowId === op.flowId && row.path === path)
      if (desk.read(path) !== (last?.after ?? null)) throw new Error('FLOW_OPERATION_CONFLICT')
    },
    list: (files: ReturnType<ReturnType<typeof createDesk>['list']>) => { const op = active(); return op ? files.filter((file) => file.path === op.outputPath || op.sources.some((source) => source.path === file.path)) : files },
    start: (kind: Operation['kind'], command: AppCommand, hash: string): PublicErrorCode | undefined => {
      const flowId = options.flowId(); const source = options.source(); if (!options.request || source === 'none') return 'not-configured'
      if (!flowId || active()) return 'unavailable'
      const id = z.string().uuid().safeParse(command.requestId).success ? command.requestId : randomUUID()
      if (all().has(id)) return 'invalid-command'
      try { if (desk.read(`工作草稿/${id}.md`) !== null) return 'unavailable' } catch { return 'unavailable' }
      const latest = new Map(appliedDeskChanges(rows()).filter((row) => row.flowId === flowId).map((row) => [row.path, row]))
      const paths = kind === 'init' ? desk.list().map((file) => file.path).filter((path) => !path.startsWith('工作草稿/')) : [...latest.keys()]
      if (kind === 'review' && !paths.length) return 'unavailable'
      const sources: Operation['sources'] = []; let bytes = 0
      for (const path of paths.sort()) {
        if (sources.length >= 8) break
        try {
          const current = desk.read(path); const change = latest.get(path)
          if (kind === 'review' && current !== change!.after || kind === 'init' && current === null) continue
          const text = kind === 'review' ? JSON.stringify({ before: change!.before, after: change!.after }) : current!
          if (bytes + Buffer.byteLength(text) > 24000) continue
          sources.push({ path, sha256: sha(text), ...(kind === 'review' ? { changeId: change!.id } : {}) }); bytes += Buffer.byteLength(text)
        } catch { /* Unreadable sources are counted as omitted, never guessed or overwritten. */ }
      }
      if (paths.length && !sources.length) return 'unavailable'
      const op: Operation = { id, flowId, kind, status: 'running', source, sourceCount: sources.length, omittedSourceCount: paths.length - sources.length,
        outputPath: `工作草稿/${id}.md`, createdAtMs: clock.nowMs(), updatedAtMs: clock.nowMs(), sources }
      save(op)
      try { const turnId = options.request('/' + kind, command.requestId, hash); save({ ...op, turnId }) }
      catch { save({ ...op, status: 'failed', error: 'unavailable' }); return 'unavailable' }
    },
    settled: () => {
      const op = active(); if (!op) return
      const end = rows().findLast((row) => row.type === 'turn/end' && row.turnId === op.turnId)
      if (!end || end.type !== 'turn/end') return
      let validSources: boolean
      try {
        for (const source of op.sources) sourceValue(op, source)
        if (op.kind === 'init') validSources = op.sources.every((source) => rows().some((row) => row.type === 'flow/operation-read' && row.operationId === op.id && row.path === source.path && row.sha256 === source.sha256))
        else validSources = rows().some((row) => row.type === 'model/seen' && row.turnId === op.turnId && row.messages.some((message) => message.content.includes(JSON.stringify(op.id)) && message.content.includes('reviewDiffs')))
      } catch { validSources = false }
      const product = artifact(op)
      save({ ...op, ...(product ? { artifact: product } : {}), status: end.reason === 'aborted' ? 'cancelled' : end.reason === 'completed' && product && validSources ? 'ready' : 'failed',
        ...(end.reason === 'aborted' ? { error: 'cancelled' as const } : !validSources ? { error: 'source-changed' as const } : !product ? { error: 'no-product' as const } : end.reason !== 'completed' ? { error: 'unavailable' as const } : {}) })
    },
    cancel: () => { const op = active(); if (op) { if (op.turnId) options.cancelTask?.(op.turnId); const product = artifact(op); save({ ...op, status: 'cancelled', error: 'cancelled', ...(product ? { artifact: product } : {}) }) } },
    open: (id: string): PublicErrorCode | undefined => {
      const op = all().get(id); if (!op?.artifact || !options.preview) return 'unavailable'
      const text = desk.read(op.outputPath); if (text === null || sha(text) !== op.artifact.sha256) return 'unavailable'
      options.preview(view(op), text)
    },
  }
}
export type FlowOperations = ReturnType<typeof createFlowOperations>
