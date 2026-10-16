import { useState } from 'react'
import type { AppBridge, AppSnapshot } from '../../../shared'

/** Plain functional entry; the book's final gift art and animation remain on the visual line. */
export function QuillEntry({ snapshot, bridge }: { snapshot: AppSnapshot; bridge: AppBridge }) {
  const [error, setError] = useState('')
  if (snapshot.quill?.state !== 'given') return null
  return <aside className="quill-entry" aria-label="羽毛笔存档入口">
    <button type="button" disabled={!!snapshot.backup && ['exporting', 'validating', 'restoring'].includes(snapshot.backup.status)} onClick={() => {
      void bridge.dispatch({ protocolVersion: 1, epoch: snapshot.epoch, requestId: crypto.randomUUID(), type: 'backup.export' }).then((ack) => setError(ack.status === 'rejected' ? ack.error.code : ''), () => setError('connection-failed'))
    }}>羽毛笔 · 导出存档</button>{error && <span role="alert">{error}</span>}
  </aside>
}
