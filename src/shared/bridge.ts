import type { AppCommand, CommandAck } from './commands'
import type { AppEvent } from './events'
import type { AppSnapshot, EvidenceView, FileImportAck } from './state'

export interface AppBridge {
  getSnapshot(): Promise<AppSnapshot>
  subscribe(listener: (event: AppEvent) => void): () => void
  dispatch(command: AppCommand): Promise<CommandAck>
  /** User-only evidence view. Never feed this return value to model context. */
  readEvidence(evidenceRef: string): Promise<EvidenceView>
  /** User drop/chooser only. Preload resolves native File handles; paths never return to renderer.
   * Optional solely for older UI fixtures. Real preload supplies this method. */
  importFiles?(files: readonly File[], epoch: string): Promise<FileImportAck>
}

export const IPC_CHANNELS = {
  snapshot: 'lca:snapshot',
  event: 'lca:event',
  command: 'lca:command',
  evidence: 'lca:user-evidence',
  files: 'lca:user-files',
} as const
