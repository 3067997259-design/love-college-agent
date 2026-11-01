import { useState } from 'react'
import type { MemoryView } from '../../../shared'

export function MemoryFactsControls({ memory, busy, send }: { memory: MemoryView; busy: boolean; send(body: Record<string, unknown>): Promise<boolean> }) {
  const [content, setContent] = useState('')
  const [correcting, setCorrecting] = useState<{ id: string; revision: number } | null>(null)
  const selected = memory.facts?.find(fact => fact.id === correcting?.id && fact.revision === correcting.revision)
  return <section aria-label="事实记忆">
    <h3>她记得的事</h3>
    <p>新建议先等你审阅。纠正和忘记会保留操作记录，生效后才更新对话中的记忆。</p>
    {memory.engine && <p role="status">记忆库：{memory.engine.state === 'ready' ? '已就绪' : memory.engine.state === 'failed' ? '暂时不可用' : '正在准备'} · 待审阅 {memory.engine.pendingOperations} 项</p>}
    <ul className="memory-list">{memory.operations?.filter(item => item.status === 'pending_review' || item.status === 'conflict').map(item => <li className="memory-item" key={item.operationId}>
      <strong>{item.kind === 'remember' ? '记住' : item.kind === 'correct' ? '纠正' : '忘记'}{item.title ? `：${item.title}` : ''}</strong>
      {item.previousContent && <p>原内容：{item.previousContent}</p>}{item.content && <p>新内容：{item.content}</p>}
      {item.status === 'conflict' ? <p role="alert">这条记忆已变化，请按当前内容重新提出更正。</p> : <>
        <button type="button" disabled={busy} onClick={() => void send({ type: 'memory.review', operationId: item.operationId, approve: true })}>确认{item.kind === 'forget' ? '忘记' : '保存'}</button>
        <button type="button" disabled={busy} onClick={() => void send({ type: 'memory.review', operationId: item.operationId, approve: false })}>拒绝这项更改</button>
      </>}
    </li>)}</ul>
    <ul className="memory-list">{memory.facts?.map(fact => <li className="memory-item" key={fact.id} data-superseded={fact.factStatus !== 'active'}>
      {fact.title && <strong>{fact.title}</strong>}<p>{fact.content}</p>
      <small>{fact.factStatus === 'superseded' ? '已有新值' : fact.factStatus === 'disputed' ? '存在冲突' : fact.reviewStatus === 'pending' ? '待审阅建议' : fact.reviewStatus === 'rejected' ? '已拒绝' : '已确认'} · 版本 {fact.revision}{fact.pinned ? ' · 已固定' : ''}</small>
      {fact.reviewStatus === 'pending' && <>
        <button type="button" disabled={busy} onClick={() => void send({ type: 'memory.fact.review', id: fact.id, expectedRevision: fact.revision, approve: true })}>确认这条建议</button>
        <button type="button" disabled={busy} onClick={() => void send({ type: 'memory.fact.review', id: fact.id, expectedRevision: fact.revision, approve: false })}>拒绝这条建议</button>
      </>}
      {fact.reviewStatus === 'approved' && fact.factStatus === 'active' && <>
        <button type="button" disabled={busy} onClick={() => void send({ type: 'memory.presentation', id: fact.id, expectedRevision: fact.revision, title: fact.title, summary: fact.summary, pinned: !fact.pinned, pinOrder: fact.pinOrder })}>{fact.pinned ? '取消固定' : '固定到记忆目录'}</button>
        <button type="button" disabled={busy} onClick={() => { setCorrecting({ id: fact.id, revision: fact.revision }); setContent(fact.content) }}>纠正</button>
        <button type="button" disabled={busy} onClick={() => void send({ type: 'memory.propose', kind: 'forget', targetId: fact.id, expectedRevision: fact.revision })}>提出忘记</button>
      </>}
    </li>)}</ul>
    <label>{selected ? '更正后的内容' : '希望她记住的事'}<textarea value={content} maxLength={2000} onChange={event => setContent(event.target.value)} /></label>
    {correcting && !selected && <p role="alert">这条记忆已经变化，请重新选择要纠正的版本。</p>}
    <button type="button" disabled={busy || !content.trim() || !!correcting && !selected} onClick={() => void send({ type: 'memory.propose', kind: selected ? 'correct' : 'remember', content: content.trim(),
      ...(selected ? { targetId: selected.id, expectedRevision: selected.revision } : {}) }).then(accepted => { if (accepted) { setContent(''); setCorrecting(null) } })}>提出{selected ? '更正' : '记忆'}</button>
    {correcting && <button type="button" onClick={() => { setCorrecting(null); setContent('') }}>取消编辑</button>}
  </section>
}
