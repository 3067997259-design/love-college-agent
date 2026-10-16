import type { DocumentScenarioId, MailScenarioId, PomodoroPlanInput, PublicError } from './state'

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
  | { type: 'pomodoro.start'; planId: string }
  | { type: 'pomodoro.plan'; plan: PomodoroPlanInput }
  | { type: 'pomodoro.confirm'; planId: string }
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
  | { type: 'privacy.set'; enabled: boolean }
  | { type: 'document.attachment'; attachmentId: string }
  | { type: 'document.retry'; documentId: string }
  | { type: 'document.cancel'; documentId: string }
  | { type: 'developer.documents'; scenarioId: DocumentScenarioId }
  | { type: 'developer.document.import'; fixtureId: 'assignment-pdf' | 'notes-text' | 'malformed-pdf' | 'scanned-pdf' }
  | { type: 'memory.extract' }
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
