import type { DocumentScenarioId, GiftMotif, GiftObjectId, MailScenarioId, PomodoroPlanInput, PublicError } from './state'

interface CommandEnvelope {
  protocolVersion: 1
  requestId: string
  epoch: string
}
/** Only main decides availability and permission. Undeveloped operations reject explicitly. */
export type AppCommand = CommandEnvelope & (
  | { type: 'message.send'; text: string }
  | { type: 'turn.stop'; taskId: string }
  | { type: 'mode.set'; mode: 'work' | 'quiet' | 'rest' }
  | { type: 'lights.set'; lightsOut: boolean }
  /** Trimmed single-line text: userName <= 20 code points, characterName <= 12. Empty resets to null / 桃子. */
  | { type: 'onboarding.profile'; userName?: string; characterName?: string }
  | { type: 'onboarding.complete' }
  /** Reopen initialization; retain names and all private business/history data. Refused in booth mode. */
  | { type: 'onboarding.reset' }
  /** Only an existing, witnessed experience may anchor a generated gift. Object descriptions are enum-derived. */
  | { type: 'gift.propose'; sourceMemoryId: string; objectId: GiftObjectId; motif: GiftMotif }
  | { type: 'gift.start'; giftId: string }
  | { type: 'gift.cancel'; giftId: string }
  | { type: 'gift.open'; giftId: string }
  | { type: 'pomodoro.start'; planId: string }
  | { type: 'pomodoro.plan'; plan: PomodoroPlanInput }
  | { type: 'pomodoro.confirm'; planId: string }
  | { type: 'pomodoro.discard'; planId: string }
  | { type: 'pomodoro.resume' }
  | { type: 'pomodoro.pause' }
  | { type: 'pomodoro.stop' }
  | { type: 'mail.scan' }
  /** Real candidate mutations require the rendered revision; omissions reject at runtime. */
  | { type: 'candidate.confirm'; candidateId: string; expectedRevision?: number; plannedCompletionIso?: string | null }
  | { type: 'candidate.ignore'; candidateId: string; expectedRevision?: number }
  | { type: 'campus.export' }
  | { type: 'artifact.open'; artifactId: string }
  | { type: 'backup.export' }
  | { type: 'backup.import' }
  /** Confirm only after native file selection, validation and the incoming summary are shown. */
  | { type: 'backup.restore'; restoreId: string }
  | { type: 'backup.cancel' }
  /** Native file chooser; configuration and credentials never pass through the renderer. */
  | { type: 'mcp.configure' }
  | { type: 'mcp.connect'; serverId: string; fingerprint: string }
  | { type: 'mcp.disconnect'; serverId: string }
  /** Native file chooser. Model URLs, names and credentials stay in main. Restart applies the imported configuration. */
  | { type: 'models.configure' }
  | { type: 'window.mini' }
  /** Expand the book and destroy its companion window; no timer or session change. */
  | { type: 'window.expand' }
  /** Compatibility alias for window.expand. */
  | { type: 'window.book' }
  /** Mini renderer only; main clamps motion to the connected work areas. */
  | { type: 'window.mini.hover'; over: boolean }
  /** Integer physical-screen pixel displacement, sent at most once per renderer frame. */
  | { type: 'window.mini.moveBy'; dx: number; dy: number }
  /** Compatibility: legacy logical-pixel movement; new renderers use moveBy. */
  | { type: 'window.mini.move'; dx: number; dy: number }
  /** Developer-only, read-only diagnostics BrowserWindow; refused in normal/booth mode. */
  | { type: 'window.diagnostics.open' }
  | { type: 'privacy.set'; enabled: boolean }
  | { type: 'document.attachment'; attachmentId: string }
  | { type: 'document.retry'; documentId: string }
  | { type: 'document.cancel'; documentId: string }
  | { type: 'developer.documents'; scenarioId: DocumentScenarioId }
  | { type: 'developer.document.import'; fixtureId: 'assignment-pdf' | 'notes-text' | 'malformed-pdf' | 'scanned-pdf' }
  | { type: 'memory.extract' }
  /** Consolidate closed calendar periods from grounded day summaries; repeated identical inputs are no-ops. */
  | { type: 'memory.consolidate' }
  | { type: 'context.compact' }
  | { type: 'session.rollover' }
  | { type: 'developer.memory'; scenarioId: 'ready' | 'failure' | 'invalid' }
  | { type: 'plugin.enable'; pluginId: string; fingerprint: string }
  | { type: 'plugin.disable'; pluginId: string }
  | { type: 'plugin.privacy.set'; pluginId: string; privacy: 'none' | 'optional' | 'always' }
  | { type: 'developer.set'; enabled: boolean }
  | { type: 'developer.clock'; nowMs?: number; rate?: number; frozen?: boolean }
  | { type: 'developer.scenario'; scenarioId: 'empty' | 'clock-tool' | 'pomodoro-demo' }
  | { type: 'developer.mailbox'; scenarioId: MailScenarioId }
  | { type: 'app.restart' }
)

export type CommandAck = {
  protocolVersion: 1
  requestId: string
  epoch: string
} & ({ status: 'accepted' } | { status: 'rejected'; error: PublicError })
