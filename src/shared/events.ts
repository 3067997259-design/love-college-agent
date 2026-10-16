import type { AppSnapshot } from './state'

/** A public projection stream, not the protected append-only journal. */
export interface AppEvent {
  protocolVersion: 1
  epoch: string
  revision: number
  occurredAtMs: number
  requestId?: string
  type: 'state.snapshot'
  reason: 'initial' | 'message' | 'task' | 'timer' | 'mode' | 'connection' | 'restore'
  snapshot: AppSnapshot
}
