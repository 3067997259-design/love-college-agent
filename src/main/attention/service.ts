import type { AttentionView, InteractionMode } from '../../shared'

export interface AttentionInputs {
  mode: InteractionMode
  lightsOut: boolean
  sleeping: boolean
  /** A user-triggered model turn is running (she is talking with the user). */
  userTurn: boolean
  /** An autonomous task turn is computing (the in-hand task is being worked on). */
  taskComputing: boolean
  /** An approved task exists but is waiting for a user decision, approval or command. */
  taskWaiting: boolean
  /** An accepted gift is being made. */
  giftMaking: boolean
  /** Her own reading/writing currently has a worker running. */
  lifeActive: boolean
  focusRunning: boolean
}

const poseForMode = (mode: InteractionMode): AttentionView['pose'] => mode === 'work' ? 'desk-computer' : mode === 'quiet' ? 'desk-writing' : 'facing-user'

/**
 * D3 attention precedence (D-8): user speaking > the step of the user's task being computed >
 * a promised gift > her own reading/writing. A task that is merely waiting for approval, an answer
 * or a command does not occupy her, so her own work may continue during that time.
 */
export function deriveAttention(input: AttentionInputs): AttentionView {
  if (input.lightsOut || input.sleeping) return { kind: 'rest', pose: 'sleeping', taskWaiting: input.taskWaiting, focusRunning: input.focusRunning }
  if (input.userTurn) return { kind: 'user', pose: 'facing-user', taskWaiting: input.taskWaiting, focusRunning: input.focusRunning }
  if (input.taskComputing) return { kind: 'task', pose: 'desk-computer', taskWaiting: false, focusRunning: input.focusRunning }
  if (input.giftMaking) return { kind: 'gift', pose: 'desk-writing', taskWaiting: input.taskWaiting, focusRunning: input.focusRunning }
  if (input.lifeActive) return { kind: 'life', pose: 'desk-writing', taskWaiting: input.taskWaiting, focusRunning: input.focusRunning }
  return { kind: 'idle', pose: poseForMode(input.mode), taskWaiting: input.taskWaiting, focusRunning: input.focusRunning }
}

/** Her own work may start while the task is only waiting for the user. */
export const attentionAllowsLife = (view: AttentionView) => view.kind !== 'rest' && view.kind !== 'user' && view.kind !== 'task' && view.kind !== 'gift'

export function createAttention(options: { inputs(): AttentionInputs }) {
  return {
    view: (): AttentionView => deriveAttention(options.inputs()),
    lifeAllowed: () => attentionAllowsLife(deriveAttention(options.inputs())),
  }
}
export type AttentionService = ReturnType<typeof createAttention>
