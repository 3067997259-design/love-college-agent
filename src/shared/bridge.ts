import type { AppCommand, CommandAck } from './commands'
import type { AppEvent } from './events'
import type { AppSnapshot, EvidenceView } from './state'

export interface AppBridge {
  getSnapshot(): Promise<AppSnapshot>
  subscribe(listener: (event: AppEvent) => void): () => void
  dispatch(command: AppCommand): Promise<CommandAck>
  /** User-only evidence view. Never feed this return value to model context. */
  readEvidence(evidenceRef: string): Promise<EvidenceView>
}

export const IPC_CHANNELS = {
  snapshot: 'lca:snapshot',
  event: 'lca:event',
  command: 'lca:command',
  evidence: 'lca:user-evidence',
} as const
