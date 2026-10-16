import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { AppCommand, HeartFlowView, PublicErrorCode } from '../../shared'
import type { Clock } from '../clock'
import type { SessionStore } from '../store/session'
import type { ContextMessage } from '../journal/schema'
import { contentHash, createDesk, deskPathSchema } from './desk'
import type { HarnessTool } from '../harness/tools'
import instructions from './instructions.json'
import { flowContexts, normalContextAllowedSeqs } from './context'
import { appliedDeskChanges } from './changes'
import codingSkill from './coding-skill.json'
import { flowExitSummary } from './summary'

type Prepared = { messages: readonly ContextMessage[]; eligibleIndexes: readonly number[] }
export function createHeartFlow(options: { store: SessionStore; clock: Clock; desk: ReturnType<typeof createDesk>; booth: boolean; busy(): boolean; changed(): void;
  prepare(id: string, signal: AbortSignal): Promise<Prepared>; entered?(): void; emit(id: string, summary: string): void; run(code: string, signal: AbortSignal): Promise<string> }) {
  const { store, desk } = options; const rows = () => store.history?.() ?? store.records()
  let pending: { id: string; code: string; hash: string; resolve?(value: string): void } | undefined; let running: AbortController | undefined; let enabled = true
  let lastRun: HeartFlowView['lastRun']; let opening = false
  const open = () => { const list = rows(); return list.findLast((row) => row.type === 'flow/open' && !list.some((other) => other.type === 'flow/close' && other.id === row.id)) as Extract<ReturnType<typeof rows>[number], { type: 'flow/open' }> | undefined }
  const mode = () => { const flow = open(); const updated = rows().findLast((row) => row.type === 'flow/mode' && row.id === flow?.id); return updated?.type === 'flow/mode' ? updated.mode : flow?.mode ?? 'plan' }
  const changes = () => appliedDeskChanges(rows())
  const safe = (write = false) => { if (!enabled || !open() || store.projection().lightsOut || write && mode() !== 'execute') throw new Error('FLOW_UNAVAILABLE') }
  const cancel = () => { if (pending) { store.append({ type: 'flow/run', id: pending.id, flowId: open()?.id ?? 'interrupted', status: 'denied', codeHash: pending.hash }); pending.resolve?.('execution-denied'); pending = undefined }; running?.abort() }
  // A saved request/approval never authorizes a process after restart.
  const runs = rows().filter((row) => row.type === 'flow/run')
  for (const row of runs) if ((row.status === 'requested' || row.status === 'approved') && !runs.some((other) => other.id === row.id && other.seq > row.seq)) store.append({ type: 'flow/run', id: row.id, flowId: row.flowId, codeHash: row.codeHash, status: 'interrupted' })
  for (const row of rows()) if (row.type === 'desk/change' && row.pending && !rows().some((other) => other.type === 'desk/settled' && other.id === row.id)) {
    let matches = false; try { matches = contentHash(desk.read(row.path)) === contentHash(row.after) } catch { /* Broken file containment is not a committed change. */ }
    store.append({ type: 'desk/settled', id: row.id, status: matches ? 'applied' : 'failed' })
  }
  const write = (path: string, text: string | null, undoes?: string) => {
    safe(true); const before = desk.read(path); const id = randomUUID()
    // Snapshot is durable before touching disk. Recovery/undo uses the exact expected after version.
    store.append({ type: 'desk/change', id, flowId: open()!.id, path, before, after: text, pending: true, ...(undoes ? { undoes } : {}) })
    try { desk.write(path, text) } catch { store.append({ type: 'desk/settled', id, status: 'failed' }); throw new Error('DESK_WRITE_FAILED') }
    store.append({ type: 'desk/settled', id, status: 'applied' }); options.changed(); return id
  }
  const requestRun = (code: string) => { safe(true); if (options.booth || pending || running || code.length > 10_000 || !code.trim()) throw new Error('FLOW_UNAVAILABLE'); const id = randomUUID(); pending = { id, code, hash: contentHash(code) }; store.append({ type: 'flow/run', id, flowId: open()!.id, status: 'requested', codeHash: pending.hash }); options.changed(); return id }
  const compact = () => {
    const flow = open()!; const work = rows().filter((row) => row.seq > flow.seq && row.type === 'desk/change')
    store.append({ type: 'flow/compact', id: flow.id, throughSeq: store.records().at(-1)!.seq, summary: JSON.stringify({ changes: work.slice(-25).map((row) => row.type === 'desk/change' ? { id: row.id, path: row.path } : null) }) }); options.changed()
  }
  const exit = () => {
    safe(); if (options.busy()) throw new Error('FLOW_UNAVAILABLE'); cancel(); const flow = open()!
    const evidence = changes().filter((row) => row.flowId === flow.id).map((row) => ({ changeId: row.id, path: row.path, current: contentHash(desk.read(row.path)) === contentHash(row.after), undo: !!row.undoes }))
    const completedRuns = rows().flatMap((row) => row.type === 'flow/run' && row.flowId === flow.id && (row.status === 'completed' || row.status === 'failed') ? [{ id: row.id, status: row.status }] : [])
    const summary = flowExitSummary(flow.id, evidence, completedRuns)
    store.append({ type: 'flow/close', id: flow.id, summary }); options.emit('flow:' + flow.id, summary); options.changed()
  }
  return {
    active: () => !!open(),
    messages: () => {
      const combined = flowContexts(store, false); const activeFlow = open(); const activeSpan = combined.spans.find((span) => span.id === activeFlow?.id)
      const positions = new Map(store.records().flatMap((row) => row.type === 'user/message' || row.type === 'assistant/message' ? [[row.id, combined.positions.get(store.scope.sessionId + ':' + row.seq) ?? -1] as const] : []))
      return store.projection().messages.filter((message) => { const position = positions.get(message.id) ?? -1; return activeSpan ? position > activeSpan.start : !combined.spans.some((span) => position > span.start && (span.end < 0 || position < span.end)) })
    },
    normalEntriesAllowed: (seqs: readonly number[]) => normalContextAllowedSeqs(store, seqs),
    view: (): HeartFlowView => ({ activeId: open()?.id ?? null, mode: mode(), execution: options.booth ? 'disabled' : 'javascript-sandbox', ...(pending ? { pending: { id: pending.id, code: pending.code } } : {}), files: desk.list(),
      changes: changes().filter((row) => row.flowId === open()?.id && !row.undoes).slice(-50).map((row) => ({ id: row.id, path: row.path, undone: changes().some((other) => other.undoes === row.id) })),
      sessions: rows().filter((row) => row.type === 'flow/open').slice(-30).map((row) => { const closed = rows().find((other) => other.type === 'flow/close' && other.id === row.id); return { id: row.id, startedAtMs: row.atMs, endedAtMs: closed?.atMs ?? null, summary: closed?.type === 'flow/close' ? closed.summary : null } }), ...(lastRun ? { lastRun } : {}) }),
    prepareContext: async (id: string, signal: AbortSignal): Promise<Prepared> => {
      const flow = open(); if (!flow) {
        return options.prepare(id, signal)
      }
      const combined = flowContexts(store); const checkpointIndex = combined.rows.findLastIndex((row) => row.type === 'flow/compact' && row.id === flow.id); const checkpoint = combined.rows[checkpointIndex]
      const threshold = checkpointIndex >= 0 ? checkpointIndex : combined.spans.find((span) => span.id === flow.id)!.start
      const work = combined.context.filter((entry) => entry.position > threshold && combined.rows[entry.position]?.type !== 'context/inject')
      const messages: ContextMessage[] = [...flow.prefix, ...(checkpoint?.type === 'flow/compact' ? [{ role: 'user' as const, content: checkpoint.summary }] : []), ...work.map((entry) => entry.message)]
      if (JSON.stringify(messages).length > 80_000) { compact(); return { messages: [...flow.prefix, { role: 'user', content: instructions.compacted }], eligibleIndexes: [] } }
      return { messages, eligibleIndexes: [] }
    },
    dispatch: (command: AppCommand): PublicErrorCode | undefined => {
      try {
        if (command.type === 'flow.enter') {
          if (open() || opening || options.busy() || store.projection().lightsOut) return 'unavailable'
          opening = true
          void options.prepare('flow-entry', new AbortController().signal).then((prepared) => {
            if (options.busy() || store.projection().lightsOut) return
            const policies = prepared.messages.filter((message) => message.role === 'system')
            const chat = store.projection().messages.slice(-12).map((message) => ({ role: message.role, text: message.text.slice(0, 500) }))
            store.append({ type: 'flow/open', id: randomUUID(), mode: 'plan', prefix: [...policies, { role: 'system', content: instructions.policy }, { role: 'system', content: JSON.stringify({ builtinCodingSkill: codingSkill }) }, { role: 'user', content: JSON.stringify({ conversationReference: chat }) }] })
            options.entered?.()
          }).catch(() => {}).finally(() => { opening = false; options.changed() }); return
        }
        safe()
        if (command.type === 'flow.exit') { exit(); return }
        if (command.type === 'flow.mode') { if (options.busy()) return 'unavailable'; store.append({ type: 'flow/mode', id: open()!.id, mode: command.mode }); options.changed(); return }
        if (command.type === 'flow.compact') { if (options.busy()) return 'unavailable'; compact(); return }
        if (command.type === 'flow.undo') {
          if (options.busy() || pending || running) return 'unavailable'
          const change = changes().find((row) => row.id === command.changeId && row.flowId === open()!.id && !row.undoes)
          if (!change || changes().some((row) => row.undoes === change.id) || contentHash(desk.read(change.path)) !== contentHash(change.after)) return 'invalid-command'
          write(change.path, change.before, change.id); return
        }
        if (command.type === 'flow.run') { requestRun(command.code); return }
        if (command.type === 'flow.approve') {
          if (!pending || pending.id !== command.approvalId || running) return 'invalid-command'
          if (command.allow && (options.booth || mode() !== 'execute')) return 'permission-denied'
          const job = pending; pending = undefined
          store.append({ type: 'flow/run', id: job.id, flowId: open()!.id, status: command.allow ? 'approved' : 'denied', codeHash: job.hash })
          if (!command.allow) { job.resolve?.('execution-denied'); options.changed(); return }
          if (options.booth || mode() !== 'execute') return 'permission-denied'
          const abort = new AbortController(); running = abort; const flowId = open()!.id
          void options.run(job.code, abort.signal).then((output) => { lastRun = { ok: true, output }; store.append({ type: 'flow/run', id: job.id, flowId, status: 'completed', codeHash: job.hash }); job.resolve?.(output) }, () => { lastRun = { ok: false, output: 'execution-failed' }; store.append({ type: 'flow/run', id: job.id, flowId, status: 'failed', codeHash: job.hash }); job.resolve?.('execution-failed') }).finally(() => { running = undefined; options.changed() }); return
        }
        return 'invalid-command'
      } catch { return 'unavailable' }
    },
    read: (path: string) => { safe(); return desk.read(path) }, write,
    list: () => { safe(); return desk.list() },
    execute: async (code: string, signal: AbortSignal) => {
      signal.throwIfAborted(); requestRun(code)
      return await new Promise<string>((resolve) => { pending!.resolve = resolve; const stop = () => { cancel(); resolve('execution-cancelled') }; signal.addEventListener('abort', stop, { once: true }); const settle = resolve; pending!.resolve = (value) => { signal.removeEventListener('abort', stop); settle(value) }; if (signal.aborted) stop() })
    },
    stateChanged: () => { if (store.projection().lightsOut) cancel() },
    setEnabled: (value: boolean) => { enabled = value; if (!value) cancel(); options.changed() }, close: cancel,
  }
}
export type HeartFlowService = ReturnType<typeof createHeartFlow>

export function deskTools(flow: HeartFlowService): HarnessTool[] {
  const spec = { path: deskPathSchema, text: z.string().max(64_000) }
  const entries = [
    { name: 'desk_read', schema: z.strictObject({ path: spec.path }), run: (input: { path: string }) => ({ text: flow.read(input.path) }) },
    { name: 'desk_write', schema: z.strictObject(spec), run: (input: { path: string; text: string }) => ({ changeId: flow.write(input.path, input.text) }) },
    { name: 'desk_edit', schema: z.strictObject({ path: spec.path, oldText: z.string().min(1).max(64000), newText: z.string().max(64000) }), run: (input: { path: string; oldText: string; newText: string }) => { const text = flow.read(input.path); if (text === null || text.split(input.oldText).length !== 2) throw new Error('EXACT_MATCH_REQUIRED'); return { changeId: flow.write(input.path, text.replace(input.oldText, input.newText)) } } },
    { name: 'desk_find', schema: z.strictObject({ contains: z.string().max(100) }), run: (input: { contains: string }) => ({ files: flow.list().filter((file) => file.path.includes(input.contains)).slice(0, 100) }) },
    { name: 'desk_grep', schema: z.strictObject({ text: z.string().min(1).max(100) }), run: (input: { text: string }) => ({ matches: flow.list().filter((file) => file.byteLength <= 64000).slice(0, 100).flatMap((file) => { try { return flow.read(file.path)?.includes(input.text) ? [file.path] : [] } catch { return [] } }) }) },
  ]
  const tools: HarnessTool[] = entries.map((entry) => ({ definition: { name: entry.name, description: instructions.tools[entry.name as keyof typeof instructions.tools], parameters: z.toJSONSchema(entry.schema) }, templateId: entry.name, validate: (input) => entry.schema.safeParse(input).success,
    run: async (input) => { const output = entry.run(input as never); return { ok: true, raw: output, visible: output } } }))
  const schema = z.strictObject({ code: z.string().min(1).max(10000) })
  tools.push({ definition: { name: 'run_javascript', description: instructions.tools.run_javascript, parameters: z.toJSONSchema(schema) }, templateId: 'desk.run', validate: (input) => schema.safeParse(input).success,
    run: async (input, context) => { const output = await flow.execute(schema.parse(input).code, context.signal); return { ok: !output.startsWith('execution-'), raw: { output }, visible: { output } } } })
  return tools
}
