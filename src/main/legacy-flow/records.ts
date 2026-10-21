import type { DeskShadowView, HeartFlowInspection, LegacyFlowSessionView } from '../../shared'
import type { SessionStore } from '../store/session'
import type { createDesk } from './desk'
import { inspectHeartFlow } from './inspection'

/** Shadow-commit receipts the retired flow recorded for its desk changes. */
const shadowViews = (store: SessionStore) => new Map((store.history?.() ?? store.records()).flatMap((row) => row.type === 'desk/shadow'
  ? [[row.changeId, { status: row.status, ...(row.commit ? { commit: row.commit } : {}) } as DeskShadowView] as const] : []))

/**
 * The heart flow is retired (DSH does her work now). Its old sessions stay readable here as history only: a list, and
 * on your request a status or diff page in the preview window. Nothing here can enter, change or run anything.
 */
export function createLegacyFlowRecords(options: { store: SessionStore; desk: ReturnType<typeof createDesk>; booth: boolean; preview(view: HeartFlowInspection): void }) {
  const { store } = options
  const rows = () => store.history?.() ?? store.records()
  return {
    sessions: (): LegacyFlowSessionView[] => rows().filter((row) => row.type === 'flow/open').slice(-30).map((row) => {
      const closed = rows().find((other) => other.type === 'flow/close' && other.id === row.id)
      return { id: row.id, startedAtMs: row.atMs, endedAtMs: closed?.atMs ?? null, summary: closed?.type === 'flow/close' ? closed.summary : null }
    }),
    inspect: (input: { section: HeartFlowInspection['section']; flowId: string }): HeartFlowInspection => {
      const result = inspectHeartFlow(store, options.desk, options.booth, input); const receipts = shadowViews(store)
      const view = { ...result, changes: result.changes.map((change) => { const shadow = receipts.get(change.id); return { ...change, ...(shadow ? { shadow } : {}) } }) }
      options.preview(view)
      return view
    },
  }
}
export type LegacyFlowRecords = ReturnType<typeof createLegacyFlowRecords>
