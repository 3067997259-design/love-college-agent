import type { PomodoroPlanInput, PublicError } from './state'

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
  | { type: 'candidate.confirm'; candidateId: string }
  | { type: 'candidate.ignore'; candidateId: string }
  | { type: 'artifact.open'; artifactId: string }
  | { type: 'backup.export' }
  | { type: 'backup.import' }
  | { type: 'privacy.set'; enabled: boolean }
  | { type: 'plugin.enable'; pluginId: string; fingerprint: string }
  | { type: 'plugin.disable'; pluginId: string }
  | { type: 'plugin.privacy.set'; pluginId: string; privacy: 'none' | 'optional' | 'always' }
  | { type: 'developer.set'; enabled: boolean }
  | { type: 'developer.clock'; nowMs?: number; rate?: number; frozen?: boolean }
  | { type: 'developer.scenario'; scenarioId: 'empty' | 'clock-tool' | 'pomodoro-demo' }
  | { type: 'app.restart' }
)

export type CommandAck = {
  protocolVersion: 1
  requestId: string
  epoch: string
} & ({ status: 'accepted' } | { status: 'rejected'; error: PublicError })
