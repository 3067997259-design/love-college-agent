import type { AppCommand, CommandAck } from './commands'
import type { AppEvent } from './events'
import type { AppSnapshot, DiagnosticsView, EvidenceView, FileImportAck, SessionPage, DiaryRead, HeartFlowInspection, OpticalMemoryRead } from './state'

export interface AppBridge {
  getSnapshot(): Promise<AppSnapshot>
  subscribe(listener: (event: AppEvent) => void): () => void
  dispatch(command: AppCommand): Promise<CommandAck>
  /** User-only evidence view. Never feed this return value to model context. */
  readEvidence(evidenceRef: string): Promise<EvidenceView>
  /** User drop/chooser only. Preload resolves native File handles; paths never return to renderer.
   * Optional solely for older UI fixtures. Real preload supplies this method. */
  importFiles?(files: readonly File[], epoch: string): Promise<FileImportAck>
  /** User-only chat archive. Not a raw journal, tool evidence or model read API. */
  readSession?(sessionId: string): Promise<SessionPage>
  /** Developer mode only; safe projections and counters, never raw evidence or configuration. */
  readDiagnostics?(): Promise<DiagnosticsView>
  readDiary?(diaryId: string): Promise<DiaryRead>
  readHeartFlow?(input: { section: 'status' | 'permissions' | 'diff'; flowId?: string }): Promise<HeartFlowInspection>
  readOpticalMemory?(frameId: string): Promise<OpticalMemoryRead>
}

export const IPC_CHANNELS = {
  snapshot: 'lca:snapshot',
  event: 'lca:event',
  command: 'lca:command',
  evidence: 'lca:user-evidence',
  files: 'lca:user-files',
  session: 'lca:user-session',
  diagnostics: 'lca:diagnostics',
  diary: 'lca:user-diary',
  heartFlow: 'lca:user-heart-flow',
  opticalMemory: 'lca:user-optical-memory',
} as const
