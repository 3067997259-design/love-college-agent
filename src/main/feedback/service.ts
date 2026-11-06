import { randomUUID } from 'node:crypto'
import type { AppCommand, PublicErrorCode } from '../../shared'
import type { SessionStore } from '../store/session'

/**
 * A user verdict about one of her replies. It never changes the raw conversation:
 * "bad" only removes that turn's assistant words from later memory/summary inputs.
 */
export function createReplyFeedback(options: { store: SessionStore; changed(): void; onGood?(): void }) {
  return {
    dispatch(command: Extract<AppCommand, { type: 'reply.feedback' }>): PublicErrorCode | undefined {
      const rows = options.store.records()
      const target = rows.find(row => row.type === 'assistant/message' && row.id === command.messageId)
      if (target?.type !== 'assistant/message' || target.displayOnly) return 'invalid-command'
      options.store.append({ type: 'reply/feedback', id: randomUUID(), messageId: target.id, turnId: target.turnId, verdict: command.verdict })
      if (command.verdict === 'good') options.onGood?.()
      options.changed()
    },
  }
}
export type ReplyFeedbackService = ReturnType<typeof createReplyFeedback>
