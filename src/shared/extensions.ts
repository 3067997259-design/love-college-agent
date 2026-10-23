import type { PublicError } from './state'

export interface ExtensionView {
  id: string
  revision: number
  owner: 'lca' | 'dsh' | 'mcp'
  kind: 'plugin' | 'bundle' | 'skill' | 'server'
  name: string
  source: { kind: 'builtin' | 'local' | 'registry'; label: string; fingerprint: string }
  version: string | null
  scope: { kind: 'application' | 'profile' | 'project'; projectId: string | null }
  installation: 'builtin' | 'absent' | 'installing' | 'installed' | 'removing' | 'unknown'
  enabledIntent: boolean
  applied: 'ready' | 'disabled' | 'failed' | 'unknown'
  restartReason: 'install' | 'enablement' | 'removal' | 'configuration' | null
  protected: boolean
  error: PublicError | null
}
export interface ExtensionOperation {
  id: string
  extensionId: string | null
  revision: number
  action: 'install' | 'enable' | 'disable' | 'remove' | 'reconcile'
  phase: 'preparing' | 'awaiting-approval' | 'running' | 'cancelling' | 'reconciling' | 'settled'
  cancellable: boolean
  /** Cancelling a wait is not proof of rollback. Unknown outcomes must be reconciled first. */
  outcome: 'pending' | 'succeeded' | 'cancelled' | 'failed' | 'unknown'
  restartRequired: boolean
  error: PublicError | null
}
export interface ExtensionProposal {
  id: string
  fingerprint: string
  name: string
  version: string | null
  sourceLabel: string
  scope: ExtensionView['scope']
  requiresBuildScripts: boolean
}
export interface ExtensionsView {
  status: 'unavailable' | 'ready' | 'reconciling' | 'failed'
  items: readonly ExtensionView[]
  operations: readonly ExtensionOperation[]
  proposal: ExtensionProposal | null
}
/** Native selection first; renderer cannot supply a package path, registry URL or manager RPC. */
export type ExtensionCommand =
  | { type: 'extension.pick' }
  | { type: 'extension.install'; proposalId: string; fingerprint: string }
  | { type: 'extension.enable' | 'extension.disable' | 'extension.remove'; extensionId: string; expectedRevision: number; fingerprint: string }
  | { type: 'extension.cancel' | 'extension.reconcile'; operationId: string; expectedRevision: number }
