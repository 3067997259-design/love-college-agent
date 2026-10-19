import type { AppBridge, AppSnapshot } from '../../../shared'
import words from '../voice/book.zh.json'
import { formatClock } from '../book/format'

/**
 * D2: the heart-flow panel is retired. Old flow records stay readable here as history only:
 * no entry, mode change, run approval or write control is offered any more.
 */
export function LegacyFlowRecords({ snapshot, bridge }: { snapshot: AppSnapshot; bridge: AppBridge }) {
  const sessions = snapshot.heartFlow?.sessions ?? []
  if (!sessions.length) return null
  const inspect = async (section: 'status' | 'diff', flowId: string) => {
    try { await bridge.readHeartFlow?.({ section, flowId }) } catch { /* Native preview may be unavailable in tests. */ }
  }
  return <details className="legacy-flow">
    <summary>{words.legacyFlow.title}（{sessions.length}）</summary>
    <p>{words.legacyFlow.note}</p>
    <ol>
      {sessions.map((session) => <li key={session.id} data-flow-id={session.id}>
        <code>{session.id.slice(0, 8)}</code> · {session.endedAtMs === null ? words.legacyFlow.open : formatClock(session.startedAtMs)}
        {session.endedAtMs !== null && <>
          {' '}<button type="button" className="link-button" onClick={() => void inspect('status', session.id)}>{words.legacyFlow.status}</button>
          {' '}<button type="button" className="link-button" onClick={() => void inspect('diff', session.id)}>{words.legacyFlow.diff}</button>
        </>}
      </li>)}
    </ol>
  </details>
}
