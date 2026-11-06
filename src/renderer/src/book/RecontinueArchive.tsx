import { useEffect, useState } from 'react'
import type { AppBridge, MessageView } from '../../../shared'

/** Read-only floating archive for one recontinue version. Never a model input. */
export function RecontinueArchive({ bridge, sessionId, onClose }: { bridge: AppBridge; sessionId: string; onClose(): void }) {
  const [messages, setMessages] = useState<MessageView[] | null>(null)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    if (!bridge.readSession) { setFailed(true); return }
    void bridge.readSession(sessionId).then(page => setMessages(page.messages.filter(message => message.withdrawn)), () => setFailed(true))
  }, [bridge, sessionId])
  return <div className="recontinue-archive-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
    <section className="recontinue-archive-panel" role="dialog" aria-modal="true" aria-label="撤下的内容">
      <header>
        <strong>撤下的内容</strong>
        <button type="button" className="link-button" onClick={onClose}>关闭</button>
      </header>
      <p>只作留档，不再进入上下文、记忆和日记取材。</p>
      {failed ? <p role="alert">历史版本暂时无法读取。</p> : messages === null ? <p role="status">正在读取……</p> : messages.length === 0 ? <p>这次没有可显示的消息。</p>
        : <ul className="recontinue-archive-list">{messages.map(message => <li key={message.id} className={`recontinue-archive-${message.role}`}>
          <small>{message.role === 'user' ? '你' : message.role === 'assistant' ? '她' : '旁白'}</small>
          <p>{message.text}</p>
        </li>)}</ul>}
    </section>
  </div>
}
