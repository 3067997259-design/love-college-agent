import { useState } from 'react'
import type { AppBridge, AppCommand, AppSnapshot } from '../../../shared'
import { RecontinueArchive } from '../book/RecontinueArchive'
import { formatClock } from '../book/format'

/** Read-only version list plus the one limited undo the main process still allows. */
export function ConversationVersionControls({ bridge, snapshot }: { bridge: AppBridge; snapshot: AppSnapshot }) {
  const [archive, setArchive] = useState(false)
  const [error, setError] = useState('')
  const versions = snapshot.recontinue?.versions ?? []
  if (!versions.length) return <p className="settings-note">今天还没有重新继续过。</p>
  const undo = async (operationId: string) => {
    try {
      const ack = await bridge.dispatch({ protocolVersion: 1, epoch: snapshot.epoch, requestId: crypto.randomUUID(), type: 'recontinue.undo', operationId } as AppCommand)
      setError(ack.status === 'rejected' ? ack.error.code : '')
    } catch { setError('connection-failed') }
  }
  return <section aria-label="对话版本">
    <h3>对话版本</h3>
    <p className="settings-note">重新继续会保留原始记录；旧后文只读。只有最近一次、且新分支还没开始聊天时才能撤销。</p>
    <ul className="version-list">{versions.slice().reverse().map(version => <li key={version.operationId} className="version-item" data-undone={version.undone}>
      <strong>{version.mode === 'retry' ? '重试' : '重新继续'} · {formatClock(version.atMs)}</strong>
      <p>{version.targetText || '（目标消息已不可见）'}</p>
      <small>撤下 {version.messages} 条{version.undone ? ' · 已撤销' : ''}</small>
      <div className="settings-actions">
        <button type="button" onClick={() => setArchive(true)}>查看撤下的内容</button>
        {version.undoable && <button type="button" onClick={() => void undo(version.operationId)}>撤销这次重新继续</button>}
      </div>
    </li>)}</ul>
    {error && <p role="alert">没能撤销：{error}</p>}
    {archive && <RecontinueArchive bridge={bridge} sessionId={snapshot.scope.sessionId} onClose={() => setArchive(false)} />}
  </section>
}
