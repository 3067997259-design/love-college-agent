import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { AppCommand, DeskCommandView, PublicErrorCode } from '../../shared'
import { systemClock, type Clock } from '../clock'
import type { SessionStore } from '../store/session'
import type { HarnessTool, ToolResult } from '../harness/tools'
import type { JournalInput } from '../journal/schema'
import { contentHash } from '../legacy-flow/desk'
import { appliedDeskChanges } from '../legacy-flow/changes'
import { CommandProcessFailure, type CommandProcessPort, type CommandProcessResult } from './process'
import { deskCommandInput } from './schema'
import { commandEdits, commandTreeHash, disposeCommandSnapshot, prepareCommandSnapshot, readCommandTree, type CommandSnapshot, type CommandEdit } from './snapshot'
import manifest from './tool.json'

type Receipt = { requestId: string; commandHash: string }
type Job = { view: DeskCommandView; flowId: string; abort: AbortController; turnId?: string; snapshot?: CommandSnapshot; decision?: (allow: boolean) => void; publishing: boolean }
type Metadata = Extract<JournalInput, { type: 'flow/command' }>
export function createDeskCommands(options: {
  store: SessionStore; clock: Clock; deskRoot: string; cacheRoot: string; booth: boolean; port: CommandProcessPort;
  flowId(): string | null; allowed(): boolean; manualAllowed(): boolean; changed(): void; safeText(text: string): string;
  current(path: string): string | null; publish(commandId: string, edit: CommandEdit): void; preview(id: string, text: string): void; failed?(): void;
}) {
  const { store, clock } = options; let enabled = true; let closed = false; let current: Job | undefined; let view: DeskCommandView | undefined
  let worker: Promise<ToolResult> | undefined; let output: { id: string; text: string } | undefined; let viewFlowId: string | undefined
  const history = () => store.history?.() ?? store.records()
  // Recovery works even when this service is opened without HeartFlow first.
  for (const row of history()) if (row.type === 'desk/change' && row.commandId && row.pending && !history().some((other) => other.type === 'desk/settled' && other.id === row.id)) {
    let matches = false; try { matches = contentHash(options.current(row.path)) === contentHash(row.after) } catch { /* No confirmed publication. */ }
    store.append({ type: 'desk/settled', id: row.id, status: matches ? 'applied' : 'failed' })
  }
  const published = (id: string) => appliedDeskChanges(history()).filter((row) => row.commandId === id).length
  const rows = history()
  for (const row of rows) if (row.type === 'flow/command' && !['completed', 'failed', 'cancelled', 'interrupted'].includes(row.status) && rows.findLast((other) => other.type === 'flow/command' && other.id === row.id) === row) {
    const { version: _version, seq: _seq, atMs: _atMs, requestId: _request, commandHash: _hash, ...data } = row
    void _version; void _seq; void _atMs; void _request; void _hash
    const appliedFiles = Math.max(row.outcome?.appliedFiles ?? 0, published(row.id))
    const outcome: NonNullable<DeskCommandView['outcome']> = row.outcome
      ? { ...row.outcome, appliedFiles, publication: row.outcome.changedFiles !== null && appliedFiles > 0 && appliedFiles === row.outcome.changedFiles ? 'applied' : appliedFiles > 0 && row.outcome.changedFiles !== null ? 'partial' : row.outcome.publication }
      : { exitCode: null, elapsedMs: null, processTreeTerminated: null, publication: row.status === 'running' || appliedFiles > 0 ? 'unknown' : 'not-applied', changedFiles: null, appliedFiles }
    store.append({ ...data, status: 'interrupted', outcome })
  }
  const record = (job: Job, status: Metadata['status'], receipt?: Receipt) => {
    try { store.append({ type: 'flow/command', id: job.view.id, flowId: job.flowId, ...(job.turnId ? { turnId: job.turnId } : {}), executionHash: contentHash(job.view.command), timeoutMs: job.view.timeoutMs,
      status, fileCount: job.view.fileCount, ...(job.view.snapshotHash ? { snapshotHash: job.view.snapshotHash } : {}), ...(job.view.outcome ? { outcome: job.view.outcome } : {}), ...receipt }) }
    catch { closed = true; job.abort.abort(); job.decision?.(false); options.failed?.(); throw new Error('COMMAND_STORAGE_FAILED') }
    options.changed()
  }
  const usable = () => !closed && enabled && !options.booth && !!options.flowId() && options.allowed() && options.port.available()
  const cancel = () => { if (current) { current.abort.abort(); current.decision?.(false) } }
  const safeCommand = (command: string) => {
    if (options.safeText(command) !== command) return false
    const encoded = /^powershell(?:\.exe)?\s+(?:(?:-NoLogo|-NoProfile|-NonInteractive)\s+)*-EncodedCommand\s+([a-z0-9+/]+={0,2})\s*$/i.exec(command)?.[1]
    if (!encoded) return true
    const script = Buffer.from(encoded, 'base64').toString('utf16le')
    return options.safeText(script) === script
  }
  const request = (input: unknown, receipt?: Receipt, context?: { turnId: string; signal: AbortSignal }): Promise<ToolResult> => {
    const data = deskCommandInput.parse(input)
    if (!usable() || current || worker || !context && !options.manualAllowed() || !safeCommand(data.command) || context?.signal.aborted) throw new Error('COMMAND_UNAVAILABLE')
    const flowId = options.flowId()!; const job: Job = { view: { id: randomUUID(), shell: 'cmd', scope: 'desk-snapshot', command: data.command, timeoutMs: data.timeoutMs, createdAtMs: clock.nowMs(), status: 'preparing', fileCount: 0 }, flowId, abort: new AbortController(), ...(context ? { turnId: context.turnId } : {}), publishing: false }
    current = job; view = job.view; viewFlowId = flowId; output = undefined; record(job, 'preparing', receipt)
    const abort = () => { job.abort.abort(); job.decision?.(false) }; context?.signal.addEventListener('abort', abort, { once: true })
    const operation = (async (): Promise<ToolResult> => {
      let process: CommandProcessResult | undefined; let edits: CommandEdit[] = []; let diffReady = false; let applied = 0; let attempts = 0; let publication: NonNullable<DeskCommandView['outcome']>['publication'] = 'not-applied'
      let failure = false; let encodingFailure = false; let outputTruncated = false
      try {
        job.snapshot = await prepareCommandSnapshot(options.deskRoot, options.cacheRoot); job.abort.signal.throwIfAborted()
        if (!usable() || options.flowId() !== job.flowId) throw new Error('COMMAND_UNAVAILABLE')
        job.view.fileCount = job.snapshot.files.size; job.view.snapshotHash = job.snapshot.hash
        const approval = new Promise<boolean>((done) => { job.decision = done })
        job.view.status = 'awaiting-approval'; record(job, 'awaiting-approval')
        if (!await approval) { job.abort.abort(); throw new Error('COMMAND_DECLINED') }; job.decision = undefined
        job.abort.signal.throwIfAborted()
        if (!usable() || options.flowId() !== job.flowId || commandTreeHash(await readCommandTree(options.deskRoot)) !== job.snapshot.hash || commandTreeHash(await readCommandTree(job.snapshot.root)) !== job.snapshot.hash) throw new Error('COMMAND_INPUT_CHANGED')
        job.view.status = 'running'; record(job, 'running')
        process = await options.port.run({ root: job.snapshot.root, command: job.view.command, timeoutMs: job.view.timeoutMs }, job.abort.signal)
        job.view.outcome = { exitCode: process.exitCode, elapsedMs: process.elapsedMs, processTreeTerminated: process.processTreeTerminated, publication: 'not-applied', changedFiles: null, appliedFiles: 0 }
        record(job, 'running') // Process evidence is durable before diffing or publishing any file.
        const clean = (text: string) => {
          const safe = options.safeText(text).replaceAll(job.snapshot!.root, '[desk snapshot]'); let end = Math.min(16000, safe.length)
          if (end < safe.length && /[\ud800-\udbff]/.test(safe.charAt(end - 1))) end--
          if (end < safe.length) { outputTruncated = true; return safe.slice(0, end) + '\n[truncated]' }
          return safe
        }
        output = { id: job.view.id, text: ['COMMAND', job.view.command, 'STDOUT', clean(process.stdout), 'STDERR', clean(process.stderr)].join('\n') }
        job.abort.signal.throwIfAborted()
        if (!usable() || options.flowId() !== job.flowId || process.status !== 'completed' || process.exitCode !== 0 || !process.processTreeTerminated) throw new Error('COMMAND_FAILED')
        edits = await commandEdits(job.snapshot); diffReady = true; job.abort.signal.throwIfAborted()
        // All-file preflight first; no user file is overwritten to conceal a conflict.
        if (edits.some((edit) => contentHash(options.current(edit.path)) !== contentHash(edit.before))) throw new Error('COMMAND_OUTPUT_CONFLICT')
        job.view.outcome = { ...job.view.outcome, changedFiles: edits.length }; record(job, 'running')
        job.publishing = true
        for (const edit of edits) {
          job.abort.signal.throwIfAborted()
          if (!usable() || options.flowId() !== job.flowId || contentHash(options.current(edit.path)) !== contentHash(edit.before)) throw new Error('COMMAND_OUTPUT_CONFLICT')
          attempts++; options.publish(job.view.id, edit); applied++
          job.view.outcome = { ...job.view.outcome, appliedFiles: applied, publication: applied === edits.length ? 'applied' : 'partial' }; record(job, 'running')
          await new Promise<void>((done) => { systemClock.after(0, done) }) // Yield to stop/lights IPC between durable file writes.
        }
        publication = edits.length ? 'applied' : 'unchanged'
      } catch (cause) { if (cause instanceof CommandProcessFailure) { encodingFailure = cause.stage === 'encoding'; console.error('COMMAND_SANDBOX_FAILURE', cause.stage, cause.nativeCode ?? 0) }; failure = true; if (attempts) publication = 'partial' }
      finally {
        job.publishing = false; job.decision = undefined
        job.view.status = job.abort.signal.aborted ? 'cancelled' : failure ? 'failed' : 'completed'
        if (failure && !job.abort.signal.aborted) job.view.error = { code: encodingFailure ? 'command-encoding-unsupported' : 'unavailable', retryable: false }
        if (process) job.view.outcome = { exitCode: process.exitCode, elapsedMs: process.elapsedMs, processTreeTerminated: process.processTreeTerminated, publication, changedFiles: diffReady ? edits.length : null, appliedFiles: Math.max(applied, published(job.view.id)) }
        record(job, job.view.status)
        if (job.snapshot) { try { await disposeCommandSnapshot(job.snapshot) } catch { /* An altered scratch path is never followed or removed recursively. */ } }
        context?.signal.removeEventListener('abort', abort); if (current === job) current = undefined
      }
      const value = { status: job.view.status, commandId: job.view.id, ...(job.view.error ? { error: job.view.error.code } : {}), ...(job.view.outcome ? { receipt: job.view.outcome } : {}), ...(output?.id === job.view.id ? { output: output.text, outputTruncated } : {}) }
      return { ok: job.view.status === 'completed', raw: value, visible: value }
    })()
    worker = operation
    void operation.finally(() => { if (worker === operation) worker = undefined; options.changed() }).catch(() => {})
    return operation
  }
  return {
    active: () => !!current || !!worker,
    publishing: (id: string) => current?.view.id === id && current.publishing,
    capability: () => options.booth ? 'disabled' as const : enabled && options.port.available() ? 'windows-appcontainer' as const : 'unavailable' as const,
    view: () => view && options.flowId() === viewFlowId ? structuredClone(view) : undefined,
    cancel,
    stateChanged: () => { if (current && (!usable() || options.flowId() !== current.flowId || current.turnId && store.projection().task?.id !== current.turnId)) cancel() },
    setEnabled: (value: boolean) => { enabled = value; if (!value) cancel() },
    dispatch: (command: AppCommand, hash: string): PublicErrorCode | undefined => {
      try {
        if (command.type === 'flow.command.run') { void request({ command: command.command, ...(command.timeoutMs !== undefined ? { timeoutMs: command.timeoutMs } : {}) }, { requestId: command.requestId, commandHash: hash }).catch(() => {}); return }
        if (command.type === 'flow.command.open') { if (output?.id !== command.commandId || options.flowId() !== viewFlowId) return 'unavailable'; options.preview(output.id, output.text); return }
        if (!current || (command.type !== 'flow.command.approve' && command.type !== 'flow.command.cancel') || current.view.id !== command.commandId) return 'invalid-command'
        if (command.type === 'flow.command.cancel') { cancel(); return }
        if (current.abort.signal.aborted || current.view.status !== 'awaiting-approval' || !current.decision) return 'invalid-command'
        if (command.allow && !usable()) return 'permission-denied'
        record(current, command.allow ? 'approved' : 'denied', { requestId: command.requestId, commandHash: hash }); current.decision(command.allow); current.decision = undefined; return
      } catch { return options.booth ? 'permission-denied' : 'unavailable' }
    },
    tool: (): HarnessTool => ({ definition: { ...manifest, parameters: z.toJSONSchema(deskCommandInput) }, templateId: 'desk.command', validate: (input) => deskCommandInput.safeParse(input).success,
      run: (input, context) => request(input, undefined, { turnId: context.turnId, signal: context.signal }) }),
    close: async () => { closed = true; cancel(); await worker },
  }
}
export type DeskCommands = ReturnType<typeof createDeskCommands>
