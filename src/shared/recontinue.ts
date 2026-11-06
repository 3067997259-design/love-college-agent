/** A day-local conversation projection. Raw history and executed effects survive. */
export type RecontinueCommand =
  | { type: 'recontinue.preview'; sessionId: string; messageId: string; revision: string }
  | { type: 'recontinue.commit'; previewId: string }
  | { type: 'recontinue.cancel' }

export interface RecontinueView {
  revision: string
  phase: 'idle' | 'previewing' | 'ready' | 'committing' | 'complete' | 'failed'
  preview?: { id: string; messageId: string; text: string; messages: number; memories: number; works: number; effects: number }
  completed?: { operationId: string; draft: string }
  error?: string
}

/** Trusted main/DSH contract; never a renderer-supplied log offset or root. */
export interface RecontinuePlan { messageSeq: number; boundary: number | null; prefixDigest: string; messageDigest: string }
export interface RecontinueFork { sourceId: string; target: { messageId: string; text: string }; plan: RecontinuePlan }
