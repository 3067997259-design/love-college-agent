import { useEffect, useRef, useState } from 'react'
import type { AppBridge, AppCommand, AppSnapshot, SessionPage, RecallAnchor } from '../../../shared'
import failureWords from '../voice/failure.zh.json'
import { MemoryFactsControls } from './MemoryFactsControls'
import { MemorySettingsControls } from './MemorySettingsControls'
import { SettingsIssue } from './SettingsIssue'

/**
 * 记忆与日会话。日常只做一件事：看她记住了什么，要不要纠正或忘记。
 * 抽取、归并、压缩、翻页条件、旧版记忆列表和历史日页阅读器都是维护入口，
 * 收在下面两个折叠里；两个折叠默认收起，自动化脚本打开设置时会把它们展开。
 */
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
  const busy = memory.status === 'extracting' || memory.status === 'compacting' || snapshot.memorySettings?.status === 'saving'
  const send = async (body: Record<string, unknown>) => {
    try { const ack = await bridge.dispatch({ ...body, protocolVersion: 1, epoch: snapshot.epoch, requestId: crypto.randomUUID() } as AppCommand); setError(ack.status === 'rejected' ? ack.error.code : ''); return ack.status === 'accepted' }
    catch { setError('connection-failed'); return false }
  }
  return <div aria-label="记忆与日会话控制">
    <p className="settings-note">{memory.source === 'none' ? '还没配置整理记忆的模型' : `${memory.source === 'fake' ? '合成经历（开发场景）' : '由后台模型整理'} · ${{ unconfigured: '等配置', idle: '空闲', extracting: '正在整理', compacting: '正在收起旧对话', failed: '上次整理没做完' }[memory.status]}`}</p>
    <SettingsIssue code={error || memory.error?.code} />

    {/* 日常唯一要动的地方：她记得的事 */}
    <MemoryFactsControls memory={memory} busy={busy} send={send} />

    <details className="settings-advanced">
      <summary>维护操作与历史日页</summary>
      <p className="settings-advanced-note">平时不用管。整理记忆会在她空闲时自己做，这里的按钮只是手动催一次，或者翻翻以前的日页和旧版记忆。</p>
      <p>短期记忆 {memory.shortTermCount} 条 · 长期记忆 {memory.longTermCount} 条 · 上下文 {memory.contextChars.toLocaleString('en-US')} 字{memory.summaryCounts && ` · 日摘要 ${memory.summaryCounts.day} · 周摘要 ${memory.summaryCounts.week} · 月摘要 ${memory.summaryCounts.month}`}</p>
      <p className="settings-note">只整理她在对话里看到、并且允许记下的内容，引用和交班带过来的不会再记一遍。</p>
      <div className="settings-actions">
        <button type="button" disabled={busy || memory.status === 'unconfigured'} onClick={() => void send({ type: 'memory.extract' })}>抽取可见经历</button>
        <button type="button" disabled={busy || memory.status === 'unconfigured'} onClick={() => void send({ type: 'memory.consolidate' })}>整理成周、月摘要</button>
        <button type="button" disabled={busy || memory.status === 'unconfigured'} onClick={() => void send({ type: 'context.compact' })}>收起旧对话</button>
        <button type="button" disabled={busy || !session.rolloverPending} onClick={() => void send({ type: 'session.rollover' })}>检查翻页条件</button>
        {snapshot.history && <button type="button" disabled={snapshot.history.captureStatus === 'capturing'} onClick={() => void send({ type: 'history.photo.capture' })}>保存当前场景照片</button>}
      </div>
      {session.rolloverPending && <p className="settings-note">已经是新的一天了。等这一轮说完、空闲两分钟、灯还亮着时翻页。</p>}
      {snapshot.history?.captureStatus === 'capturing' && <p role="status">正在保存照片……</p>}
      {snapshot.history?.captureError && <p role="alert">照片没保存上，可以再试一次。</p>}
      {snapshot.runtime?.developer.mode === 'developer' && <label>记忆模型场景 <select value={memory.scenarioId ?? 'ready'} disabled={busy} onChange={(event) => void send({ type: 'developer.memory', scenarioId: event.target.value })}>
        <option value="ready">可用</option><option value="failure">后台失败</option><option value="invalid">无依据输出</option>
      </select></label>}
      {memory.items.length > 0 && <h3>旧版记忆条目</h3>}
      <ul className="memory-list">{memory.items.map((item) => <li className="memory-item" key={item.id} data-superseded={!!item.supersededBy}>
        <span>{item.text}</span><small> · 未审核 · {item.tier} · {item.sourceSessionCount} 天来源 · {item.accessCount} 次召回{item.supersededBy ? ' · 已被新事实取代' : ''}</small>
      </li>)}</ul>
      {bridge.readSession && <label>历史会话 <select aria-label="历史会话" value={pageId} onChange={(event) => {
        const id = event.target.value; const generation = ++request.current
        setPageId(id); setAnchor(null)
        if (!id) { setPage(null); return }
        void bridge.readSession!(id).then((next) => { if (request.current === generation) setPage(next) }, () => { if (request.current === generation) setError('unavailable') })
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
        {page.truncated && <p>这里只显示这一页最后的一段聊天，完整记录在本机日志里。</p>}
      </section>}
    </details>

    {snapshot.memorySettings && <MemorySettingsControls settings={snapshot.memorySettings} engine={memory.engine} busy={busy} send={send} />}
  </div>
}
