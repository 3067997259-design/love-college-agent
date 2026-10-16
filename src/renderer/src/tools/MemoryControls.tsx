import { useEffect, useRef, useState } from 'react'
import type { AppBridge, AppCommand, AppSnapshot, SessionPage } from '../../../shared'

export function MemoryControls({ bridge, snapshot }: { bridge: AppBridge; snapshot: AppSnapshot }) {
  const [error, setError] = useState('')
  const [page, setPage] = useState<SessionPage | null>(null)
  const [pageId, setPageId] = useState('')
  const request = useRef(0)
  useEffect(() => { request.current++; setPage(null); setPageId(''); setError(''); return () => { request.current++ } }, [snapshot.epoch])
  const memory = snapshot.memory; const session = snapshot.session
  if (!memory || !session) return null
  const busy = memory.status === 'extracting' || memory.status === 'compacting'
  const send = async (body: Record<string, unknown>) => {
    try { const ack = await bridge.dispatch({ ...body, protocolVersion: 1, epoch: snapshot.epoch, requestId: crypto.randomUUID() } as AppCommand); setError(ack.status === 'rejected' ? ack.error.code : '') }
    catch { setError('connection-failed') }
  }
  return <div aria-label="记忆与日会话控制">
    <h2>记忆与日会话</h2>
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
      setPageId(id)
      if (!id) { setPage(null); return }
      void bridge.readSession!(id).then((next) => { if (request.current === generation) setPage(next) }, () => { if (request.current === generation) setError('旧页读取失败') })
    }}><option value="">选择一页</option>{session.pages.map((info) => <option key={info.sessionId} value={info.sessionId}>{info.dayKey} · {info.messageCount} 条 · {info.summarized ? '有摘要' : '未生成摘要'}</option>)}</select></label>}
    {page && <section aria-label="历史聊天" className="memory-archive">
      <h3>{page.dayKey}</h3><button type="button" onClick={() => { request.current++; setPage(null); setPageId('') }}>收起旧页</button>
      {page.messages.map((message) => <p key={message.id}>{message.role === 'user' ? '你' : '她'}：{message.text}</p>)}
      {page.truncated && <p>当前仅显示这一页末尾的有限聊天；完整记录仍在本机日志中。</p>}
    </section>}
  </div>
}
