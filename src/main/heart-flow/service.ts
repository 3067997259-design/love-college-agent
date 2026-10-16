import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { AppCommand, HeartFlowView, PublicErrorCode, HeartFlowInspection, FlowOperationView } from '../../shared'
import type { Clock } from '../clock'
import type { SessionStore } from '../store/session'
import type { ContextMessage } from '../journal/schema'
import { contentHash, createDesk, deskPathSchema, validateDeskText } from './desk'
import type { HarnessTool } from '../harness/tools'
import instructions from './instructions.json'
import { flowContexts, normalContextAllowedSeqs } from './context'
import { appliedDeskChanges } from './changes'
import codingSkill from './coding-skill.json'
import { flowExitSummary } from './summary'
import { inspectHeartFlow } from './inspection'
import type { DelegatesService } from '../delegates/service'
import { goalSchema, projectFlowGoals } from './goals'
import { createFlowOperations } from './operations'
import { type DeskShadow, shadowViews } from './shadow'
import type { DeskComputer } from '../computer/service'
import type { FlowFetch } from '../web-fetch/service'

type Prepared = { messages: readonly ContextMessage[]; eligibleIndexes: readonly number[] }
export function createHeartFlow(options: { store: SessionStore; clock: Clock; desk: ReturnType<typeof createDesk>; booth: boolean; busy(): boolean; changed(): void;
  prepare(id: string, signal: AbortSignal): Promise<Prepared>; entered?(): void; inspect?(view: HeartFlowInspection): void; emit(id: string, summary: string): void; run(code: string, signal: AbortSignal): Promise<string>;
  requestDraft?(text: string, requestId: string, hash: string): string; cancelTask?(turnId: string): void; modelSource?(): 'real' | 'fake' | 'none'; previewDraft?(view: FlowOperationView, text: string): void; shadow?: DeskShadow }) {
  const { store, desk } = options; const rows = () => store.history?.() ?? store.records()
  let pending: { id: string; code: string; hash: string; resolve?(value: string): void } | undefined; let running: AbortController | undefined; let enabled = true
  let lastRun: HeartFlowView['lastRun']; let opening = false
  let delegates: DelegatesService | undefined
  let computer: DeskComputer | undefined
  let webFetch: FlowFetch | undefined
  const open = () => { const list = rows(); return list.findLast((row) => row.type === 'flow/open' && !list.some((other) => other.type === 'flow/close' && other.id === row.id)) as Extract<ReturnType<typeof rows>[number], { type: 'flow/open' }> | undefined }
  const mode = () => { const flow = open(); const updated = rows().findLast((row) => row.type === 'flow/mode' && row.id === flow?.id); return updated?.type === 'flow/mode' ? updated.mode : flow?.mode ?? 'plan' }
  const changes = () => appliedDeskChanges(rows())
  const goals = () => projectFlowGoals(rows())
  const linkGoal = (flowId: string) => { const goal = goals().current; if (goal?.status === 'active' && !goal.flowIds.includes(flowId)) store.append({ type: 'flow/goal-linked', goalId: goal.id, flowId }) }
  const goalContext = (): ContextMessage[] => { const goal = goals().current; return goal ? [{ role: 'user', content: JSON.stringify({ selectedWorkGoal: goal, authority: 'user-selected-work-data', completionMeaning: 'user-status-decision-only-not-tool-proof' }) }] : [] }
  const safe = (write = false) => { if (!enabled || !open() || store.projection().lightsOut || write && mode() !== 'execute') throw new Error('FLOW_UNAVAILABLE') }
  const cancel = () => { webFetch?.cancel(); computer?.close(); operations?.cancel(); delegates?.cancelAll(); if (pending) { store.append({ type: 'flow/run', id: pending.id, flowId: open()?.id ?? 'interrupted', status: 'denied', codeHash: pending.hash }); pending.resolve?.('execution-denied'); pending = undefined }; running?.abort() }
  // A saved request/approval never authorizes a process after restart.
  const runs = rows().filter((row) => row.type === 'flow/run')
  for (const row of runs) if ((row.status === 'requested' || row.status === 'approved') && runs.findLast((other) => other.id === row.id) === row) store.append({ type: 'flow/run', id: row.id, flowId: row.flowId, codeHash: row.codeHash, status: 'interrupted' })
  for (const row of rows()) if (row.type === 'desk/change' && row.pending && !rows().some((other) => other.type === 'desk/settled' && other.id === row.id)) {
    let matches = false; try { matches = contentHash(desk.read(row.path)) === contentHash(row.after) } catch { /* Broken file containment is not a committed change. */ }
    store.append({ type: 'desk/settled', id: row.id, status: matches ? 'applied' : 'failed' })
  }
  const write = (path: string, text: string | null, undoes?: string) => {
    safe(true); operations?.write(path, text); deskPathSchema.parse(path); validateDeskText(text); const before = desk.read(path); const id = randomUUID()
    // Snapshot is durable before touching disk. Recovery/undo uses the exact expected after version.
    store.append({ type: 'desk/change', id, flowId: open()!.id, path, before, after: text, pending: true, ...(undoes ? { undoes } : {}) })
    try { desk.write(path, text) } catch { store.append({ type: 'desk/settled', id, status: 'failed' }); throw new Error('DESK_WRITE_FAILED') }
    store.append({ type: 'desk/settled', id, status: 'applied' }); options.shadow?.record(changes().find((row) => row.id === id)!); options.changed(); return id
  }
  const requestRun = (code: string) => { safe(true); if (operations?.active() || options.booth || pending || running || code.length > 10_000 || !code.trim()) throw new Error('FLOW_UNAVAILABLE'); const id = randomUUID(); pending = { id, code, hash: contentHash(code) }; store.append({ type: 'flow/run', id, flowId: open()!.id, status: 'requested', codeHash: pending.hash }); options.changed(); return id }
  const compact = (focus?: string, retained?: { turnId: string; messages: readonly ContextMessage[] }) => {
    const flow = open()!; const work = changes().filter((row) => row.flowId === flow.id)
    const index = work.slice(-25).map((row) => ({ id: row.id, path: row.path }))
    // Bound the evidence index independently of filename lengths and preserve the user's focus as data.
    while (JSON.stringify(index).length > 4800) index.shift()
    const summary = JSON.stringify({ changes: index, focus: focus ?? null })
    store.append({ type: 'flow/compact', id: flow.id, throughSeq: store.records().at(-1)!.seq, summary, ...(focus ? { focus } : {}), ...(retained ? { retained: { turnId: retained.turnId, messages: [...retained.messages] } } : {}) }); options.changed()
    return summary
  }
  const exit = () => {
    safe(); if (options.busy()) throw new Error('FLOW_UNAVAILABLE'); cancel(); const flow = open()!
    const evidence = changes().filter((row) => row.flowId === flow.id).map((row) => ({ changeId: row.id, path: row.path, current: contentHash(desk.read(row.path)) === contentHash(row.after), undo: !!row.undoes }))
    const completedRuns = rows().flatMap((row) => row.type === 'flow/run' && row.flowId === flow.id && (row.status === 'completed' || row.status === 'failed') ? [{ id: row.id, status: row.status }] : [])
    const actions = rows().filter((row) => row.type === 'flow/computer-action' && row.flowId === flow.id); const observations = rows().filter((row) => row.type === 'flow/computer-frame' && row.flowId === flow.id).length
    const count = (status: 'dispatched' | 'denied' | 'failed' | 'cancelled') => actions.filter((row) => row.type === 'flow/computer-action' && row.status === status).length
    const requests = rows().filter((row) => row.type === 'flow/web-fetch' && row.flowId === flow.id); const webCount = (status: 'requested' | 'fetched' | 'denied' | 'failed' | 'cancelled') => requests.filter((row) => row.type === 'flow/web-fetch' && row.status === status).length
    const summary = flowExitSummary(flow.id, evidence, completedRuns, delegates?.views(flow.id).map(({ id, status }) => ({ id, status })), observations ? { dispatched: count('dispatched'), denied: count('denied'), failed: count('failed'), cancelled: count('cancelled'), observations } : undefined, requests.length ? { source: webFetch?.view().source ?? 'real', requested: webCount('requested'), fetched: webCount('fetched'), denied: webCount('denied'), failed: webCount('failed'), cancelled: webCount('cancelled') } : undefined)
    store.append({ type: 'flow/close', id: flow.id, summary }); options.emit('flow:' + flow.id, summary); options.changed()
  }
  const operations = createFlowOperations({ store, clock: options.clock, desk, flowId: () => open()?.id ?? null, request: options.requestDraft, cancelTask: options.cancelTask, source: () => options.modelSource?.() ?? 'none', changed: options.changed, preview: options.previewDraft })
  const draftContext = () => operations?.context() ?? []
  const inspect = (input: { section: HeartFlowInspection['section']; flowId?: string }) => {
    const result = inspectHeartFlow(store, desk, options.booth, { ...input, flowId: input.flowId ?? open()?.id ?? '' }); const receipts = shadowViews(store)
    return { ...result, changes: result.changes.map((change) => { const shadow = options.shadow?.view(change.id) ?? receipts.get(change.id); return { ...change, ...(shadow ? { shadow } : {}) } }) }
  }
  return {
    attachDelegates: (port: DelegatesService) => { delegates = port },
    attachComputer: (port: DeskComputer) => { computer = port },
    attachWebFetch: (port: FlowFetch) => { webFetch = port },
    stopChildren: () => { webFetch?.cancel(); computer?.close(); operations?.cancel(); delegates?.cancelAll() },
    settled: () => operations?.settled(),
    interruptDraft: () => { webFetch?.cancel(); computer?.interruptPending(); operations?.cancel() },
    active: () => !!open(),
    id: () => open()?.id ?? null,
    inspect,
    messages: () => {
      const combined = flowContexts(store, false); const activeFlow = open(); const activeSpan = combined.spans.find((span) => span.id === activeFlow?.id)
      const positions = new Map(store.records().flatMap((row) => row.type === 'user/message' || row.type === 'assistant/message' ? [[row.id, combined.positions.get(store.scope.sessionId + ':' + row.seq) ?? -1] as const] : []))
      return store.projection().messages.filter((message) => { const position = positions.get(message.id) ?? -1; return activeSpan ? position > activeSpan.start : !combined.spans.some((span) => position > span.start && (span.end < 0 || position < span.end)) })
    },
    normalEntriesAllowed: (seqs: readonly number[]) => normalContextAllowedSeqs(store, seqs),
      view: (): HeartFlowView => ({ activeId: open()?.id ?? null, mode: mode(), execution: options.booth ? 'disabled' : 'javascript-sandbox', ...(computer ? { computer: computer.view() } : {}), ...(webFetch ? { webFetch: webFetch.view() } : {}), ...(pending ? { pending: { id: pending.id, code: pending.code } } : {}), files: desk.list(), goals: goals().visible, goalId: goals().selected, operations: operations?.views() ?? [], ...(delegates ? { delegates: delegates.views(open()?.id) } : {}),
      changes: changes().filter((row) => row.flowId === open()?.id && !row.undoes).slice(-50).map((row) => ({ id: row.id, path: row.path, undone: changes().some((other) => other.undoes === row.id), ...((options.shadow?.view(row.id) ?? shadowViews(store).get(row.id)) ? { shadow: options.shadow?.view(row.id) ?? shadowViews(store).get(row.id) } : {}) })),
      sessions: rows().filter((row) => row.type === 'flow/open').slice(-30).map((row) => { const closed = rows().find((other) => other.type === 'flow/close' && other.id === row.id); return { id: row.id, startedAtMs: row.atMs, endedAtMs: closed?.atMs ?? null, summary: closed?.type === 'flow/close' ? closed.summary : null } }), ...(lastRun ? { lastRun } : {}) }),
    prepareContext: async (id: string, signal: AbortSignal): Promise<Prepared> => {
      const flow = open(); if (!flow) {
        return options.prepare(id, signal)
      }
      const combined = flowContexts(store); const checkpointIndex = combined.rows.findLastIndex((row) => row.type === 'flow/compact' && row.id === flow.id); const checkpoint = combined.rows[checkpointIndex]
      const threshold = checkpointIndex >= 0 ? checkpointIndex : combined.spans.find((span) => span.id === flow.id)!.start
      const work = combined.context.filter((entry) => entry.position > threshold && combined.rows[entry.position]?.type !== 'context/inject')
      const retained = checkpoint?.type === 'flow/compact' ? checkpoint.retained : undefined
      const messages: ContextMessage[] = [...flow.prefix, ...goalContext(), ...draftContext(), ...(checkpoint?.type === 'flow/compact' ? [{ role: 'user' as const, content: checkpoint.summary }, ...(retained?.messages ?? [])] : []), ...work.map((entry) => entry.message)]
      if (JSON.stringify(messages).length > 80_000) {
        const turnStart = combined.rows.findLastIndex((row) => row.type === 'turn/start' && row.turnId === id)
        const current = turnStart >= 0 ? work.filter((entry) => entry.position > turnStart).map((entry) => entry.message)
          : work.filter((entry) => entry.message.role === 'user').slice(-1).map((entry) => entry.message)
        const ongoing = [...(retained?.turnId === id ? retained.messages : []), ...current]
        if (ongoing.length > 200 || JSON.stringify([...flow.prefix, ...goalContext(), ...draftContext(), ...ongoing]).length > 90_000) throw new Error('FLOW_CONTEXT_TOO_LARGE')
        const summary = compact(undefined, { turnId: id, messages: ongoing })
        const compacted: ContextMessage[] = [...flow.prefix, ...goalContext(), ...draftContext(), { role: 'user', content: instructions.compacted }, { role: 'user', content: summary }, ...ongoing]
        if (JSON.stringify(compacted).length > 96_000) throw new Error('FLOW_CONTEXT_TOO_LARGE')
        return { messages: compacted, eligibleIndexes: [] }
      }
      return { messages, eligibleIndexes: [] }
    },
    dispatch: (command: AppCommand, signature = contentHash(JSON.stringify(command))): PublicErrorCode | undefined => {
      try {
        if (command.type === 'flow.computer.close') return computer?.dispatch(command)
        if (command.type === 'flow.operation.open') return operations ? operations.open(command.operationId) : 'unavailable'
        if (command.type === 'flow.goal.set' || command.type === 'flow.goal.select' || command.type === 'flow.goal.status') {
          if (!enabled || store.projection().lightsOut) return 'unavailable'
          const state = goals()
          if (command.type === 'flow.goal.set') {
            const old = command.goalId ? state.all.get(command.goalId) : undefined
            if (command.goalId && !old) return 'invalid-command'
            const goal = goalSchema.parse({ id: old?.id ?? randomUUID(), text: command.text, status: 'active', confirmedBy: 'user' })
            cancel(); store.append({ type: 'flow/goal', goal }); store.append({ type: 'flow/goal-selected', goalId: goal.id })
          } else {
            const goal = state.all.get(command.goalId); if (!goal) return 'invalid-command'
            if (command.type === 'flow.goal.select') { if (goal.status !== 'active') return 'invalid-command'; cancel(); store.append({ type: 'flow/goal-selected', goalId: goal.id }) }
            else { if (state.selected === goal.id) cancel(); store.append({ type: 'flow/goal', goal: { id: goal.id, text: goal.text, status: command.status, confirmedBy: 'user' } }) }
          }
          if (open()) linkGoal(open()!.id); options.changed(); return
        }
        if (command.type === 'flow.inspect') {
          if (!options.inspect) return 'unavailable'
          options.inspect(inspect({ section: command.section, flowId: command.flowId })); return
        }
        if (command.type === 'flow.resume') {
          if (!enabled || open() || opening || options.busy() || store.projection().lightsOut) return 'unavailable'
          const source = rows().find((row) => row.type === 'flow/open' && row.id === command.flowId)
          const closed = rows().find((row) => row.type === 'flow/close' && row.id === command.flowId)
          if (source?.type !== 'flow/open' || closed?.type !== 'flow/close') return 'unavailable'
          const reference: ContextMessage = { role: 'user', content: JSON.stringify({ resumedFlow: source.id, evidenceReference: closed.summary, verifyCurrentFilesWithDeskTools: true, priorApprovalsExpired: true }) }
          // Reuse only the original stable prefix, not raw tool results or any old execution authorization.
          const prefix = source.resumedFrom ? source.prefix.slice(0, -1) : source.prefix
          if (prefix.length >= 200 || JSON.stringify(prefix).length > 70000) return 'unavailable'
          const id = randomUUID(); store.append({ type: 'flow/open', id, mode: 'plan', prefix: [...prefix, reference], resumedFrom: source.id }); linkGoal(id); options.entered?.(); options.changed(); return
        }
        if (command.type === 'flow.enter') {
          if (!enabled || open() || opening || options.busy() || store.projection().lightsOut) return 'unavailable'
          opening = true
          void options.prepare('flow-entry', new AbortController().signal).then((prepared) => {
            if (!enabled || options.busy() || store.projection().lightsOut) return
            const policies = prepared.messages.filter((message) => message.role === 'system')
            const chat = store.projection().messages.slice(-12).map((message) => ({ role: message.role, text: message.text.slice(0, 500) }))
            const id = randomUUID(); store.append({ type: 'flow/open', id, mode: 'plan', prefix: [...policies, { role: 'system', content: instructions.policy }, { role: 'system', content: JSON.stringify({ builtinCodingSkill: codingSkill }) }, { role: 'user', content: JSON.stringify({ conversationReference: chat }) }] }); linkGoal(id)
            options.entered?.()
          }).catch(() => {}).finally(() => { opening = false; options.changed() }); return
        }
        safe()
        if (command.type === 'flow.fetch.approve') return webFetch ? webFetch.dispatch(command) : 'unavailable'
        if (command.type === 'flow.computer.open' || command.type === 'flow.computer.approve') {
          if (options.booth || mode() !== 'execute') return 'permission-denied'
          if (command.type === 'flow.computer.open' && (options.busy() || operations?.active() || pending || running)) return 'unavailable'
          return computer ? computer.dispatch(command) : 'unavailable'
        }
        if (command.type === 'flow.init' || command.type === 'flow.review') {
          if (mode() !== 'execute') return 'permission-denied'
          if (options.busy() || pending || running) return 'unavailable'
          return operations!.start(command.type === 'flow.init' ? 'init' : 'review', command, signature)
        }
        if (command.type === 'flow.delegate.cancel') { return delegates?.views(open()!.id).some((job) => job.id === command.delegateId) && delegates.cancel(command.delegateId) ? undefined : 'unavailable' }
        if (command.type === 'flow.exit') { exit(); return }
        if (command.type === 'flow.mode') { if (options.busy()) return 'unavailable'; store.append({ type: 'flow/mode', id: open()!.id, mode: command.mode }); options.changed(); return }
        if (command.type === 'flow.compact') { if (options.busy()) return 'unavailable'; compact(command.focus?.trim().slice(0, 500)); return }
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
    read: (path: string) => { safe(); const text = desk.read(path); operations?.read(path, text); return text }, write,
    goals: () => { safe(); const state = goals(); return { selectedGoal: state.current ?? null, goals: state.visible, completionMeaning: 'user-confirmed-status-not-execution-evidence' } },
    list: () => { safe(); return operations!.list(desk.list()) },
    execute: async (code: string, signal: AbortSignal) => {
      signal.throwIfAborted(); requestRun(code)
      return await new Promise<string>((resolve) => { pending!.resolve = resolve; const stop = () => { cancel(); resolve('execution-cancelled') }; signal.addEventListener('abort', stop, { once: true }); const settle = resolve; pending!.resolve = (value) => { signal.removeEventListener('abort', stop); settle(value) }; if (signal.aborted) stop() })
    },
    stateChanged: () => { if (store.projection().lightsOut) cancel(); computer?.stateChanged(); webFetch?.stateChanged() },
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
  tools.push({ definition: { name: 'get_flow_goals', description: 'Read user-selected work goals across flow sessions. User status is not proof of external completion. This tool cannot edit or complete goals.', parameters: { type: 'object', properties: {}, additionalProperties: false } }, templateId: 'desk.goals', validate: (input) => z.strictObject({}).safeParse(input).success,
    run: async () => { const value = z.json().parse(flow.goals()); return { ok: true, raw: value, visible: value } } })
  const schema = z.strictObject({ code: z.string().min(1).max(10000) })
  tools.push({ definition: { name: 'run_javascript', description: instructions.tools.run_javascript, parameters: z.toJSONSchema(schema) }, templateId: 'desk.run', validate: (input) => schema.safeParse(input).success,
    run: async (input, context) => { const output = await flow.execute(schema.parse(input).code, context.signal); return { ok: !output.startsWith('execution-'), raw: { output }, visible: { output } } } })
  return tools
}
