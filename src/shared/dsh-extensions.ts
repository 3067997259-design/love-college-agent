/** Private, main-owned management IPC. Never accept this shape from renderer or a model. */
export type DshExtensionRequest =
  | { action: 'list' }
  | { action: 'reconcile' | 'cancel'; operationId: string }
  | { action: 'install'; operationId: string; spec: string; fingerprint: string; approvedBuilds?: string[] }
  | { action: 'enable' | 'disable' | 'remove'; operationId: string; target: string; fingerprint: string }

export interface DshExtensionItem {
  name: string
  version: string | null
  fingerprint: string
  installed: boolean
  enabled: boolean
  applied: 'ready' | 'disabled' | 'failed' | 'unknown'
  protected: boolean
  builtin: boolean
  restartRequired: boolean
}
export interface DshExtensionResult {
  operationId: string
  outcome: 'pending' | 'succeeded' | 'cancelled' | 'failed' | 'unknown'
  restartRequired: boolean
  error?: 'protected' | 'stale' | 'busy' | 'invalid' | 'stop-profile' | 'build-blocked' | 'timeout' | 'unavailable' | 'failed'
  pendingBuilds?: string[]
}
export interface DshExtensionReply {
  items: DshExtensionItem[]
  operation?: DshExtensionResult
}
