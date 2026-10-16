import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { DelegateView } from '../../shared'
import type { Clock } from '../clock'
import type { SessionStore } from '../store/session'
import { contentHash } from '../heart-flow/desk'
import type { HarnessTool, ToolResult } from '../harness/tools'
import { delegateInput, delegateOutput, type DelegateModel } from './schema'
import prompts from './prompts.json'
import { calendarDay } from '../life/service'

export function createDelegates(options: { store: SessionStore; clock: Clock; model: DelegateModel | null; flowId(): string | null; read(path: string): string | null; changed(): void }) {
  const { store, clock } = options; const rows = () => store.history?.() ?? store.records()
  const states = new Map<string, DelegateView>(); const outputs = new Map<string, z.infer<typeof delegateOutput>>()
  const workers = new Map<string, { abort: AbortController; promise: Promise<void> }>(); let closed = false
  for (const row of rows()) { if (row.type === 'delegate/state') states.set(row.view.id, structuredClone(row.view)); if (row.type === 'delegate/result') outputs.set(row.id, structuredClone(row.output)) }
  const save = (view: DelegateView) => { view.updatedAtMs = clock.nowMs(); store.append({ type: 'delegate/state', view }); options.changed() }
  for (const view of states.values()) if (view.status === 'running') { view.status = 'cancelled'; view.error = 'interrupted'; save(view) }
  const permitted = (flowId: string) => !closed && options.flowId() === flowId && !store.projection().lightsOut
  const cancel = (id: string) => { const entry = workers.get(id); if (!entry) return false; entry.abort.abort(); return true }
  const cancelAll = () => { for (const entry of workers.values()) entry.abort.abort() }
  const start = (input: z.infer<typeof delegateInput>, signal: AbortSignal): string => {
    signal.throwIfAborted(); const flowId = options.flowId()
    if (!flowId || !permitted(flowId) || !options.model || workers.size >= 3) throw new Error('DELEGATE_UNAVAILABLE')
    const attempts = rows().filter((row) => row.type === 'delegate/state' && row.view.status === 'running' && calendarDay(clock, row.atMs) === calendarDay(clock)).length
    if (attempts >= 12) throw new Error('DELEGATE_BUDGET')
    const parsed = delegateInput.parse(input)
    const sources = parsed.paths.map((path) => { const text = options.read(path); if (text === null) throw new Error('DELEGATE_SOURCE_MISSING'); return { path, text, sha256: contentHash(text) } })
    if (Buffer.byteLength(JSON.stringify(sources)) > 32000) throw new Error('DELEGATE_SOURCE_TOO_LARGE')
    const id = randomUUID(); const abort = new AbortController(); const onAbort = () => abort.abort(); signal.addEventListener('abort', onAbort, { once: true })
    const view: DelegateView = { id, flowId, status: 'running', source: options.model.source, sourceCount: sources.length, createdAtMs: clock.nowMs(), updatedAtMs: clock.nowMs() }
    states.set(id, view); save(view)
    const promise = Promise.resolve().then(async () => {
      let timedOut = false; let remove = () => {}; const stop = clock.after(30000, () => { timedOut = true; abort.abort() })
      try {
        abort.signal.throwIfAborted()
        const response = await Promise.race([options.model!.read({ task: parsed.task, sources }, abort.signal), new Promise<never>((_resolve, reject) => {
          const aborted = () => reject(new Error('DELEGATE_CANCELLED')); abort.signal.addEventListener('abort', aborted, { once: true }); remove = () => abort.signal.removeEventListener('abort', aborted); if (abort.signal.aborted) aborted()
        })])
        abort.signal.throwIfAborted(); if (!permitted(flowId)) throw new Error('DELEGATE_EXPIRED')
        const output = delegateOutput.parse(response)
        if (new Set(output.refs.map((ref) => ref.path)).size !== output.refs.length || output.refs.some((ref) => !sources.some((source) => source.path === ref.path && source.sha256 === ref.sha256))) throw new Error('DELEGATE_BAD_REFERENCE')
        store.append({ type: 'delegate/result', id, flowId, output }); outputs.set(id, output); view.status = 'completed'
      } catch { view.status = abort.signal.aborted ? 'cancelled' : 'failed'; view.error = timedOut ? 'timeout' : abort.signal.aborted ? 'cancelled' : 'invalid-output' }
      finally { stop(); remove(); signal.removeEventListener('abort', onAbort); workers.delete(id); save(view) }
    })
    workers.set(id, { abort, promise }); return id
  }
  const result = async (id: string, wait: boolean, signal: AbortSignal): Promise<Record<string, ToolResult['raw']> & { status: DelegateView['status'] }> => {
    signal.throwIfAborted(); const view = states.get(id)
    if (!view || !permitted(view.flowId)) throw new Error('DELEGATE_UNAVAILABLE')
    if (wait && workers.has(id)) {
      let remove = () => {}
      try { await Promise.race([workers.get(id)!.promise, new Promise<never>((_resolve, reject) => { const stop = () => { cancel(id); reject(new Error('DELEGATE_CANCELLED')) }; signal.addEventListener('abort', stop, { once: true }); remove = () => signal.removeEventListener('abort', stop); if (signal.aborted) stop() })]) } finally { remove() }
    }
    signal.throwIfAborted(); if (!permitted(view.flowId)) throw new Error('DELEGATE_EXPIRED')
    const output = outputs.get(id)
    if (view.status !== 'completed' || !output) return { id, status: view.status, ...(view.error ? { error: view.error } : {}) }
    return { id, status: view.status, conclusion: output.conclusion, refs: output.refs.map((ref) => { let current = false; try { current = contentHash(options.read(ref.path)) === ref.sha256 } catch { /* Explicitly expose a stale/missing source. */ }; return { ...ref, current } }), trust: 'unreviewed', memoryAuthority: 'parent-only' }
  }
  const requestSchema = z.strictObject({ delegateId: z.string().uuid(), wait: z.boolean().optional() })
  const tools: HarnessTool[] = [
    { definition: { name: 'delegate_readonly', description: prompts.start, parameters: z.toJSONSchema(delegateInput) }, templateId: 'desk.delegate', validate: (input) => delegateInput.safeParse(input).success,
      run: async (input, context) => { const value = { delegateId: start(delegateInput.parse(input), context.signal), status: 'running', readonly: true }; return { ok: true, raw: value, visible: value } } },
    { definition: { name: 'delegate_result', description: prompts.result, parameters: z.toJSONSchema(requestSchema) }, templateId: 'desk.delegate.result', validate: (input) => requestSchema.safeParse(input).success,
      run: async (input, context) => { const parsed = requestSchema.parse(input); const value = await result(parsed.delegateId, parsed.wait ?? true, context.signal); return { ok: value.status === 'completed', raw: value, visible: value } } },
  ]
  return { start, result, tools, cancel, cancelAll,
    views: (flowId?: string) => structuredClone([...states.values()].filter((view) => !flowId || view.flowId === flowId).slice(-30)),
    idle: async () => { await Promise.all([...workers.values()].map((entry) => entry.promise)) },
    close: async () => { closed = true; cancelAll(); await Promise.all([...workers.values()].map((entry) => entry.promise)) },
  }
}
export type DelegatesService = ReturnType<typeof createDelegates>
