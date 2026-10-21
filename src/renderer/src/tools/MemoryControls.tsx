import { useEffect, useRef, useState } from 'react'
import type { AppBridge, AppCommand, AppSnapshot, SessionPage, RecallAnchor } from '../../../shared'
import failureWords from '../voice/failure.zh.json'

export function MemoryControls({ bridge, snapshot }: { bridge: AppBridge; snapshot: AppSnapshot }) {
  const [error, setError] = useState('')
  const [page, setPage] = useState<SessionPage | null>(null)
  const [pageId, setPageId] = useState('')
  const [anchor, setAnchor] = useState<RecallAnchor | null>(null)
  const [question, setQuestion] = useState('')
  const request = useRef(0)
  useEffect(() => { request.current++; setPage(null); setPageId(''); setError(''); setAnchor(null); setQuestion(''); return () => { request.current++ } }, [snapshot.epoch])
  const memory = snapshot.memory; const session = snapshot.session
  if (!memory || !session) return null
  const busy = memory.status === 'extracting' || memory.status === 'compacting'
  const send = async (body: Record<string, unknown>) => {
    try { const ack = await bridge.dispatch({ ...body, protocolVersion: 1, epoch: snapshot.epoch, requestId: crypto.randomUUID() } as AppCommand); setError(ack.status === 'rejected' ? ack.error.code : '') }
    catch { setError('connection-failed') }
  }
  return <div aria-label="记忆与日会话控制">
    <h2>记忆与日会话</h2>
    {snapshot.history && <p><button type="button" disabled={snapshot.history.captureStatus === 'capturing'} onClick={() => void send({ type: 'history.photo.capture' })}>保存当前场景照片</button> · {snapshot.history.captureStatus}{snapshot.history.captureError && ' · 照片未保存，可重试'}</p>}
    <p>{memory.source === 'fake' ? '合成经历 · fake 后台模型' : memory.source === 'none' ? '后台模型未配置' : '后台记忆模型'} · {memory.status}</p>
    <p>当前页 {session.dayKey} · 短期 {memory.shortTermCount} · 长期 {memory.longTermCount} · 上下文 {memory.contextChars} 字符</p>
    <p>只从实际模型可见记录抽取；原文和整理成品不进入记忆。抽取在空闲时进行，新回合会让后台让路。</p>
    <button type="button" disabled={busy || memory.status === 'unconfigured'} onClick={() => void send({ type: 'memory.extract' })}>抽取可见经历</button>
    <button type="button" disabled={busy || memory.status === 'unconfigured'} onClick={() => void send({ type: 'memory.consolidate' })}>归并已结束周期</button>
    {memory.summaryCounts && <p>日摘要 {memory.summaryCounts.day} · 周摘要 {memory.summaryCounts.week} · 月摘要 {memory.summaryCounts.month}</p>}
    <button type="button" disabled={busy || memory.status === 'unconfigured'} onClick={() => void send({ type: 'context.compact' })}>压缩旧回合</button>
    {session.rolloverPending && <p>新的一天已到；等待回合结束、空闲两分钟且未熄灯后翻页。</p>}
    <button type="button" disabled={busy || !session.rolloverPending} onClick={() => void send({ type: 'session.rollover' })}>检查翻页条件</button>
    {snapshot.runtime?.developer.mode === 'developer' && <label>记忆模型场景 <select value={memory.scenarioId ?? 'ready'} disabled={busy} onChange={(event) => void send({ type: 'developer.memory', scenarioId: event.target.value })}>
      <option value="ready">可用</option><option value="failure">后台失败</option><option value="invalid">无依据输出</option>
    </select></label>}
    {(error || memory.error) && <p role="alert">整理未完成：{error || memory.error?.code}</p>}
    <ul className="memory-list">{memory.items.map((item) => <li className="memory-item" key={item.id} data-superseded={!!item.supersededBy}>
      <span>{item.text}</span><small> · 未审核 · {item.tier} · {item.sourceSessionCount} 天来源 · {item.accessCount} 次召回{item.supersededBy ? ' · 已被新事实取代' : ''}</small>
    </li>)}</ul>
    {bridge.readSession && <label>历史会话 <select aria-label="历史会话" value={pageId} onChange={(event) => {
      const id = event.target.value; const generation = ++request.current
      setPageId(id); setAnchor(null)
      if (!id) { setPage(null); return }
      void bridge.readSession!(id).then((next) => { if (request.current === generation) setPage(next) }, () => { if (request.current === generation) setError('旧页读取失败') })
    }}><option value="">选择一页</option>{session.pages.map((info) => <option key={info.sessionId} value={info.sessionId}>{info.dayKey} · {info.messageCount} 条 · {info.summarized ? '有摘要' : '未生成摘要'}</option>)}</select></label>}
    {page && <section aria-label="历史聊天" className="memory-archive">
      <h3>{page.dayKey}</h3><button type="button" onClick={() => { request.current++; setPage(null); setPageId('') }}>收起旧页</button>
      {page.photo && <img data-history-photo src={page.photo.imageUrl} alt={`${page.dayKey} 保存的场景照片`} style={{ maxWidth: '100%', maxHeight: 240 }} />}
      {page.messages.map((message) => <p key={message.id}>{message.role === 'user' ? '你' : message.role === 'narrator' ? failureWords.label : '她'}：<span data-history-message={message.id} onMouseUp={(event) => {
        const selection = window.getSelection(); if (!selection?.rangeCount || !page.recallableMessageIds?.includes(message.id)) return
        const range = selection.getRangeAt(0); if (!event.currentTarget.contains(range.startContainer) || !event.currentTarget.contains(range.endContainer)) return
        const prefix = range.cloneRange(); prefix.selectNodeContents(event.currentTarget); prefix.setEnd(range.startContainer, range.startOffset)
        const start = prefix.toString().length; const end = start + range.toString().length
        if (end > start && end - start <= 1000) setAnchor({ sessionId: page.sessionId, messageId: message.id, start, end })
      }}>{message.text}</span> {page.recallableMessageIds?.includes(message.id) && <button type="button" data-quote-message={message.id} onClick={() => {
        let end = Math.min(1000, message.text.length); if (/[\uD800-\uDBFF]/.test(message.text[end - 1])) end--
        setAnchor({ sessionId: page.sessionId, messageId: message.id, start: 0, end })
      }}>引用这句话</button>}</p>)}
      {anchor?.sessionId === page.sessionId && <div aria-label="引用回忆">
        <blockquote>{page.messages.find((message) => message.id === anchor.messageId)?.text.slice(anchor.start, anchor.end)}</blockquote>
        <input aria-label="回忆问题" maxLength={4000} value={question} placeholder="想和她聊这段经历的什么？" onChange={(event) => setQuestion(event.target.value)} />
        <button type="button" disabled={!question.trim() || snapshot.history?.recall.status === 'recalling'} onClick={() => void send({ type: 'history.recall', anchor, question })}>引用并回忆</button>
        <p role="status" data-recall-status={snapshot.history?.recall.status}>{snapshot.history?.recall.status === 'recalling' ? '正在回忆……' : snapshot.history?.recall.status === 'ready' ? '已回忆，可回到书本查看回复。' : snapshot.history?.recall.status === 'failed' ? '本次回忆未完成。' : '只引用她当时看见过的对话。'}</p>
      </div>}
      {page.truncated && <p>当前仅显示这一页末尾的有限聊天；完整记录仍在本机日志中。</p>}
    </section>}
  </div>
}
