import { createHash, randomUUID } from 'node:crypto'
import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import type { AppCommand, ExtensionsView, ExtensionOperation, ExtensionProposal, ExtensionView, PublicErrorCode } from '../../shared'
import type { DshExtensionReply, DshExtensionRequest, DshExtensionResult } from '../../shared/dsh-extensions'
import type { Clock } from '../clock'
import { atomicJson } from '../../../dsh/lca-bridge/profile.js'
import { fingerprintDirectory } from '../../../dsh/lca-bridge/extension-files.js'

export interface ExtensionTransport { extensions(input: DshExtensionRequest): Promise<DshExtensionReply> }
export interface ExtensionRuntime {
  host: ExtensionTransport
  restart(): Promise<ExtensionTransport>
}
type Candidate = ExtensionProposal & { path: string }
type RecordBook = { version: 1; operations: ExtensionOperation[]; requests: Record<string, string> }
const hash = (input: unknown) => createHash('sha256').update(JSON.stringify(input)).digest('hex')
const safeName = (name: unknown): name is string => typeof name === 'string' && /^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]{1,100}$/.test(name)
const errorOf = (error?: DshExtensionResult['error']): PublicErrorCode => error === 'protected' ? 'permission-denied' : error === 'stale' ? 'stale-candidate' : error === 'invalid' ? 'unsupported-file' : 'configuration-failed'

export function createExtensions(options: {
  dataDir: string; clock: Clock
  choose(): Promise<string | null>
  withRuntime<T>(job: (runtime: ExtensionRuntime) => Promise<T>): Promise<T>
  approve(input: { id: string; question: string; signal: AbortSignal }): Promise<boolean>
  changed(): void
}) {
  const file = join(options.dataDir, 'extensions.json')
  const saved: RecordBook = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) as RecordBook : { version: 1, operations: [], requests: {} }
  if (saved.version !== 1 || !Array.isArray(saved.operations) || !saved.requests || typeof saved.requests !== 'object' || Array.isArray(saved.requests)
    || Object.values(saved.requests).some((value) => typeof value !== 'string') || saved.operations.some((operation) => !operation || typeof operation.id !== 'string'
      || !Number.isSafeInteger(operation.revision) || !['pending', 'succeeded', 'cancelled', 'failed', 'unknown'].includes(operation.outcome)
      || !['preparing', 'awaiting-approval', 'running', 'cancelling', 'reconciling', 'settled'].includes(operation.phase))) throw new Error('LCA_EXTENSIONS_INVALID')
  for (const operation of saved.operations) if (operation.outcome === 'pending') {
    operation.outcome = ['preparing', 'awaiting-approval'].includes(operation.phase) ? 'cancelled' : 'unknown'
    operation.phase = 'settled'; operation.cancellable = false; operation.revision++
  }
  let items: ExtensionView[] = [], proposal: Candidate | null = null
  let status: ExtensionsView['status'] = 'unavailable', job: Promise<void> | null = null, closed = false
  let active: { operation: ExtensionOperation; abort: AbortController; host?: ExtensionTransport; sent: boolean } | null = null
  const notify = () => { if (!closed) options.changed() }
  const recorded = new Map<string, string>()
  const save = () => {
    mkdirSync(options.dataDir, { recursive: true })
    for (const operation of saved.operations) {
      const value = JSON.stringify(operation)
      if (recorded.get(operation.id) === value) continue
      appendFileSync(join(options.dataDir, 'extension-events.jsonl'), JSON.stringify({ id: randomUUID(), atMs: options.clock.nowMs(), operation }) + '\n', { mode: 0o600 })
      recorded.set(operation.id, value)
    }
    atomicJson(file, saved); notify()
  }
  save()
  const updateItems = (reply: DshExtensionReply) => {
    items = reply.items.map((item): ExtensionView => {
      const previous = items.find((old) => old.id === item.name)
      const value: ExtensionView = { id: item.name, revision: previous?.revision ?? 0, owner: 'dsh', kind: 'bundle', name: item.name,
        source: { kind: item.builtin ? 'builtin' : 'local', label: item.builtin ? '随应用提供' : '本地扩展', fingerprint: item.fingerprint }, version: item.version,
        scope: { kind: 'profile', projectId: null }, installation: item.builtin ? 'builtin' : item.installed ? 'installed' : 'absent', enabledIntent: item.enabled,
        applied: item.applied, protected: item.protected, restartReason: item.restartRequired ? 'enablement' : null, error: item.applied === 'failed' ? { code: 'configuration-failed', retryable: false } : null }
      if (!previous || JSON.stringify(value) !== JSON.stringify(previous)) value.revision++
      return value
    })
    status = 'ready'
  }
  const finish = (operation: ExtensionOperation, result: DshExtensionResult) => {
    operation.outcome = result.outcome; operation.restartRequired = result.restartRequired
    operation.phase = result.outcome === 'pending' ? 'reconciling' : 'settled'; operation.cancellable = result.outcome === 'pending'; operation.revision++
    operation.error = result.error ? { code: errorOf(result.error), retryable: false } : null
    operation.pendingBuilds = result.pendingBuilds?.filter(safeName)
    save()
  }
  const consume = (operation: ExtensionOperation, reply: DshExtensionReply) => { updateItems(reply); if (reply.operation) finish(operation, reply.operation); else save() }
  const launch = (work: () => Promise<void>) => {
    job = Promise.resolve() // Prevent a synchronous changed listener from starting a second operation.
    job = work().catch(() => {
      status = 'failed'
      if (active) finish(active.operation, { operationId: active.operation.id, outcome: active.sent ? 'unknown' : 'failed', restartRequired: false, error: 'unavailable' })
      else save()
    }).finally(() => { active = null; job = null; notify() })
  }
  const runMutation = async (operation: ExtensionOperation, candidate?: Candidate, expectedFingerprint?: string) => {
    const abort = new AbortController(); active = { operation, abort, sent: false }
    await options.withRuntime(async (runtime) => {
      if (closed || abort.signal.aborted) { finish(operation, { operationId: operation.id, outcome: 'cancelled', restartRequired: false }); return }
      active!.host = runtime.host
      // Obtain actual state before showing a concrete approval.
      updateItems(await runtime.host.extensions({ action: 'list' }))
      const item = items.find((item) => item.id === operation.extensionId)
      if (operation.action !== 'install' && operation.action !== 'restart' && (!item || item.protected)) throw new Error('EXTENSION_PROTECTED')
      if (expectedFingerprint && item?.source.fingerprint !== expectedFingerprint) { finish(operation, { operationId: operation.id, outcome: 'failed', restartRequired: false, error: 'stale' }); return }
      operation.phase = 'awaiting-approval'; operation.revision++; save()
      const text = operation.action === 'install' ? `安装 ${candidate!.name} ${candidate!.version ?? ''}（本地来源，指纹 ${candidate!.fingerprint.slice(0, 12)}）？这是可信主机代码；构建脚本另行批准，安装后默认停用。`
        : operation.action === 'restart' ? '重启扩展运行时？这会停止仍在活动的协作者，并使已保存的扩展设置生效。'
          : `${{ enable: '启用', disable: '停用', remove: '移除', reconcile: '核对' }[operation.action]} ${item!.name} ${item!.version ?? ''}（指纹 ${item!.source.fingerprint.slice(0, 12)}）？${operation.action === 'enable' ? '扩展是可信主机代码；重启后生效。' : '运行中的扩展需重启后才停止。'}`
      if (!await options.approve({ id: operation.id, question: text, signal: abort.signal }) || abort.signal.aborted || closed) {
        finish(operation, { operationId: operation.id, outcome: 'cancelled', restartRequired: false }); return
      }
      if (candidate && fingerprintDirectory(candidate.path) !== candidate.fingerprint) { finish(operation, { operationId: operation.id, outcome: 'failed', restartRequired: false, error: 'stale' }); return }
      operation.phase = 'running'; operation.revision++; active!.sent = true; save()
      if (operation.action === 'restart') {
        runtime.host = await runtime.restart(); active!.host = runtime.host
        updateItems(await runtime.host.extensions({ action: 'list' }))
        finish(operation, { operationId: operation.id, outcome: 'succeeded', restartRequired: false }); return
      }
      const request: DshExtensionRequest = candidate ? { action: 'install', operationId: operation.id, spec: `file:${candidate.path}`, fingerprint: candidate.fingerprint }
        : { action: operation.action as 'enable' | 'disable' | 'remove', operationId: operation.id, target: item!.id, fingerprint: item!.source.fingerprint }
      // A bounded wait never resends a mutation. Cancellation asks the same operation and waits for its receipt.
      const stop = options.clock.after(600_000, () => { abort.abort(); void runtime.host.extensions({ action: 'cancel', operationId: operation.id }).catch(() => {}) })
      try { consume(operation, await runtime.host.extensions(request)) } finally { stop() }
      if (candidate && operation.pendingBuilds?.length && operation.outcome === 'failed' && !abort.signal.aborted && !closed) {
        // A definite build-blocked failure may be retried only after a new, exact script approval.
        const names = [...operation.pendingBuilds]
        const retry: ExtensionOperation = { ...operation, id: randomUUID(), revision: 1, phase: 'awaiting-approval', outcome: 'pending', error: null, pendingBuilds: names, cancellable: true }
        saved.operations.push(retry); active = { operation: retry, abort, host: runtime.host, sent: false }; save()
        if (!await options.approve({ id: retry.id, question: `允许 ${candidate.name} 的构建脚本：${names.join('、')}？本次批准仅绑定来源指纹 ${candidate.fingerprint.slice(0, 12)}，这些脚本会在主机运行。`, signal: abort.signal }) || abort.signal.aborted || closed) {
          finish(retry, { operationId: retry.id, outcome: 'cancelled', restartRequired: false }); return
        }
        retry.phase = 'running'; active.sent = true; retry.revision++; save()
        const stopRetry = options.clock.after(600_000, () => { abort.abort(); void runtime.host.extensions({ action: 'cancel', operationId: retry.id }).catch(() => {}) })
        try { consume(retry, await runtime.host.extensions({ action: 'install', operationId: retry.id, spec: `file:${candidate.path}`, fingerprint: candidate.fingerprint, approvedBuilds: names })) } finally { stopRetry() }
      }
    })
  }
  return {
    view: (): ExtensionsView => ({ status, items: structuredClone(items), operations: structuredClone(saved.operations), proposal: proposal ? { id: proposal.id, fingerprint: proposal.fingerprint, name: proposal.name, version: proposal.version, sourceLabel: proposal.sourceLabel, scope: proposal.scope, requiresBuildScripts: proposal.requiresBuildScripts } : null }),
    busy: () => job !== null,
    idle: async () => { await job },
    dispatch: (command: AppCommand): PublicErrorCode | undefined => {
      if (!command.type.startsWith('extension.') || closed) return 'unavailable'
      const signature = hash(command), prior = saved.requests[command.requestId]
      if (prior) return prior === signature ? undefined : 'invalid-command'
      if (command.type === 'extension.cancel') {
        const operation = saved.operations.find((item) => item.id === command.operationId)
        if (!operation || operation.revision !== command.expectedRevision) return 'stale-candidate'
        if (!active || active.operation.id !== operation.id || !operation.cancellable) return 'unavailable'
        saved.requests[command.requestId] = signature; active.abort.abort()
        if (active.sent) { operation.phase = 'cancelling'; operation.revision++; save(); void active.host?.extensions({ action: 'cancel', operationId: operation.id }).then((reply) => consume(operation, reply), () => finish(operation, { operationId: operation.id, outcome: 'unknown', restartRequired: false, error: 'unavailable' })) }
        return
      }
      if (job) return 'unavailable'
      if (command.type === 'extension.pick') {
        saved.requests[command.requestId] = signature
        launch(async () => {
          const path = await options.choose(); if (!path || closed) return
          const fingerprint = fingerprintDirectory(path), meta = JSON.parse(readFileSync(join(path, 'package.json'), 'utf8')) as { name?: unknown; version?: unknown; scripts?: unknown; dsh?: { bundle?: unknown } }
          if (!safeName(meta.name) || meta.name.startsWith('@lca/') || meta.name.startsWith('@deepseek-ai/') || !meta.dsh?.bundle) throw new Error('EXTENSION_INVALID')
          const id = randomUUID(), staged = join(options.dataDir, 'extension-candidates', id)
          mkdirSync(staged, { recursive: true }); cpSync(path, staged, { recursive: true, filter: (source) => !['.git', 'node_modules'].includes(basename(source)) })
          if (fingerprintDirectory(staged) !== fingerprint) throw new Error('EXTENSION_CHANGED')
          proposal = { id, path: staged, fingerprint, name: meta.name, version: typeof meta.version === 'string' ? meta.version.slice(0, 50) : null, sourceLabel: '本地目录副本', scope: { kind: 'profile', projectId: null }, requiresBuildScripts: !!meta.scripts }
          status = 'ready'; save()
        }); return
      }
      if (command.type === 'extension.refresh' || command.type === 'extension.reconcile') {
        const operation = command.type === 'extension.reconcile' ? saved.operations.find((item) => item.id === command.operationId) : undefined
        if (command.type === 'extension.reconcile' && (!operation || operation.revision !== command.expectedRevision)) return 'stale-candidate'
        saved.requests[command.requestId] = signature
        launch(async () => { status = 'reconciling'; save(); await options.withRuntime(async ({ host }) => {
          const reply = await host.extensions(operation ? { action: 'reconcile', operationId: operation.id } : { action: 'list' })
          updateItems(reply); if (operation && reply.operation) finish(operation, reply.operation); else save()
        }) }); return
      }
      if (!['extension.install', 'extension.enable', 'extension.disable', 'extension.remove', 'extension.restart'].includes(command.type)) return 'invalid-command'
      let candidate: Candidate | undefined, target: ExtensionView | undefined
      if (command.type === 'extension.install') {
        if (!proposal || proposal.id !== command.proposalId || proposal.fingerprint !== command.fingerprint) return 'stale-candidate'
        candidate = proposal
      } else if (command.type !== 'extension.restart' && 'extensionId' in command && 'fingerprint' in command) {
        target = items.find((item) => item.id === command.extensionId)
        if (!target || target.revision !== command.expectedRevision || target.source.fingerprint !== command.fingerprint) return 'stale-candidate'
        if (target.protected) return 'permission-denied'
      }
      const operation: ExtensionOperation = { id: randomUUID(), extensionId: candidate?.name ?? target?.id ?? null, revision: 1, action: command.type.slice(10) as ExtensionOperation['action'], phase: 'preparing', cancellable: true, outcome: 'pending', restartRequired: false, error: null }
      saved.operations.push(operation); saved.requests[command.requestId] = signature; save()
      launch(() => runMutation(operation, candidate, target?.source.fingerprint)); return
    },
    disconnected: () => { status = 'unavailable'; items = items.map((item) => ({ ...item, applied: 'unknown', revision: item.revision + 1 })); notify() },
    close: () => { closed = true; active?.abort.abort(); if (active?.sent) void active.host?.extensions({ action: 'cancel', operationId: active.operation.id }).catch(() => {}) },
  }
}
export type ExtensionsService = ReturnType<typeof createExtensions>
