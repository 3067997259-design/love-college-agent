import type { AttentionView, InteractionMode } from '../../shared'

export interface AttentionInputs {
  mode: InteractionMode
  lightsOut: boolean
  sleeping: boolean
  /** A user-triggered model turn is running (she is talking with the user). */
  userTurn: boolean
  /** A turn she opened on her own is computing. */
  taskComputing: boolean
  /** An accepted gift is being made. */
  giftMaking: boolean
  /** Her own reading/writing currently has a worker running. */
  lifeActive: boolean
  focusRunning: boolean
}

const poseForMode = (mode: InteractionMode): AttentionView['pose'] => mode === 'work' ? 'desk-computer' : mode === 'quiet' ? 'desk-writing' : 'facing-user'

/**
 * D3 attention precedence (D-8): user speaking > a turn she opened on her own > a promised gift > her own
 * reading/writing.
 */
export function deriveAttention(input: AttentionInputs): AttentionView {
  if (input.sleeping) return { kind: 'rest', pose: 'sleeping', focusRunning: input.focusRunning }
  // Lights out while awake is a pause, not sleep (art spec, user-approved retouch 2026-10-16): she keeps the pose of
  // the current mode, in the dark lighting; nothing else may occupy her.
  if (input.lightsOut) return { kind: 'rest', pose: poseForMode(input.mode), focusRunning: input.focusRunning }
  if (input.userTurn) return { kind: 'user', pose: 'facing-user', focusRunning: input.focusRunning }
  if (input.taskComputing) return { kind: 'task', pose: 'desk-computer', focusRunning: input.focusRunning }
  if (input.giftMaking) return { kind: 'gift', pose: 'desk-writing', focusRunning: input.focusRunning }
  if (input.lifeActive) return { kind: 'life', pose: 'desk-writing', focusRunning: input.focusRunning }
  return { kind: 'idle', pose: poseForMode(input.mode), focusRunning: input.focusRunning }
}

/** Her own work may start when nothing above it occupies her. */
export const attentionAllowsLife = (view: AttentionView) => view.kind !== 'rest' && view.kind !== 'user' && view.kind !== 'task' && view.kind !== 'gift'

export function createAttention(options: { inputs(): AttentionInputs }) {
  return {
    view: (): AttentionView => deriveAttention(options.inputs()),
    lifeAllowed: () => attentionAllowsLife(deriveAttention(options.inputs())),
  }
}
export type AttentionService = ReturnType<typeof createAttention>
