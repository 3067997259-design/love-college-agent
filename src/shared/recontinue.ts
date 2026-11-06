/** A day-local conversation projection. Raw history and executed effects survive. */
export type RecontinueCommand =
  | { type: 'recontinue.preview'; sessionId: string; messageId: string; revision: string }
  | { type: 'recontinue.commit'; previewId: string }
  | { type: 'recontinue.undo'; operationId: string }
  | { type: 'recontinue.cancel' }

/** Why a message cannot be a cut point. Codes stay stable for tests and renderer copy. */
export type RecontinueUnavailable =
  | 'not-delivered'
  | 'question-answer'
  | 'other-project'
  | 'no-native-root'
  | 'no-session'
  | 'withdrawn'
  | 'busy'

export interface RecontinueCandidateView {
  available: boolean
  reason?: RecontinueUnavailable
}

export interface RecontinueVersionView {
  operationId: string
  atMs: number
  targetMessageId: string
  targetText: string
  messages: number
  mode: 'manual' | 'retry'
  undone: boolean
  undoable: boolean
}

export interface RecontinueView {
  revision: string
  phase: 'idle' | 'previewing' | 'ready' | 'committing' | 'complete' | 'failed'
  preview?: { id: string; messageId: string; text: string; messages: number; memories: number; works: number; effects: number }
  completed?: { operationId: string; draft: string }
  error?: string
  /** Current-projection user messages that may start a recontinue. */
  candidates: Record<string, RecontinueCandidateView>
  /** Current-projection assistant messages mapped to the user message that started their turn. */
  retryTargets: Record<string, string>
  /** The day's manual/retry versions, newest last. */
  versions: RecontinueVersionView[]
}

/** Trusted main/DSH contract; never a renderer-supplied log offset or root. */
export interface RecontinuePlan { messageSeq: number; boundary: number | null; prefixDigest: string; messageDigest: string }
export interface RecontinueFork { sourceId: string; target: { messageId: string; text: string }; plan: RecontinuePlan }
