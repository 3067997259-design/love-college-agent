import type { PublicError } from './state'

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
  | { type: 'pomodoro.pause' }
  | { type: 'pomodoro.stop' }
  | { type: 'candidate.confirm'; candidateId: string }
  | { type: 'candidate.ignore'; candidateId: string }
  | { type: 'artifact.open'; artifactId: string }
  | { type: 'backup.export' }
  | { type: 'backup.import' }
  | { type: 'privacy.set'; enabled: boolean }
)

export type CommandAck = {
  protocolVersion: 1
  requestId: string
  epoch: string
} & ({ status: 'accepted' } | { status: 'rejected'; error: PublicError })
