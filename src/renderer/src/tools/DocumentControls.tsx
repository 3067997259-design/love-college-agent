import { useState } from 'react'
import type { AppBridge, AppCommand, AppSnapshot, DocumentScenarioId } from '../../../shared'

export function DocumentControls({ bridge, snapshot }: { bridge: AppBridge; snapshot: AppSnapshot }) {
  const [error, setError] = useState('')
  const view = snapshot.documents
  if (!view) return null
  const send = async (body: Record<string, unknown>) => {
    try { const ack = await bridge.dispatch({ ...body, protocolVersion: 1, epoch: snapshot.epoch, requestId: crypto.randomUUID() } as AppCommand); setError(ack.status === 'rejected' ? ack.error.code : '') }
    catch { setError('connection-failed') }
  }
  const labels = { staged: '已暂存，等待滤芯', queued: '等待处理', processing: '正在整理', ready: '已交付', failed: '处理失败', cancelled: '已取消' }
  return <div aria-label="资料处理控制">
    <h2>附件与资料</h2>
    <label><input type="checkbox" aria-label="文件隐私过滤 /privacy" checked={snapshot.privacy.fileFilteringEnabled} disabled={!view.privacyAvailable && !snapshot.privacy.fileFilteringEnabled}
      onChange={(event) => void send({ type: 'privacy.set', enabled: event.target.checked })} /> /privacy · 文件只交给隔离滤芯</label>
    {!view.privacyAvailable && <p>隐私模型未配置。当前资料只暂存，开启隔离整理需先接通隐私模型。</p>}
    <p>开关重启后保持；关闭只影响后续处理。整理成品只给用户，原文和成品均不进她的上下文。</p>
    <p>每份最多 10 MiB、PDF 最多 60 页；只支持文字层 PDF 与 UTF-8 文本／Markdown。小型隐私模型的整理质量可能较低。</p>
    {snapshot.runtime?.developer.mode === 'developer' && <div>
      <p>合成文件 · fake 隐私模型；用于开发验证。</p>
      <label>资料滤芯场景 <select value={view.scenarioId ?? 'ready'} onChange={(event) => void send({ type: 'developer.documents', scenarioId: event.target.value as DocumentScenarioId })}>
        <option value="ready">可用</option><option value="privacy-failure">滤芯失败</option><option value="malicious">非法输出</option>
      </select></label>
      <button type="button" onClick={() => void send({ type: 'developer.document.import', fixtureId: 'notes-text' })}>暂存合成文本</button>
      <button type="button" onClick={() => void send({ type: 'developer.document.import', fixtureId: 'assignment-pdf' })}>暂存合成 PDF</button>
    </div>}
    <ul className="document-list">{view.attachments.map((attachment) => <li key={attachment.id} className="document-attachment" data-id={attachment.id}>
      {attachment.source === 'fake' ? '合成 · ' : ''}{attachment.displayName} · {attachment.byteLength} 字节
      <button type="button" disabled={snapshot.companion.lightsOut} onClick={() => void send({ type: 'document.attachment', attachmentId: attachment.id })}>整理附件</button>
    </li>)}</ul>
    <ul className="document-list">{view.jobs.map((job) => <li key={job.id} className="document-job" data-id={job.id} data-status={job.status}>
      <span>{job.source === 'fake' ? '合成 · ' : ''}{job.displayName} · {labels[job.status]}{job.pageCount ? ` · ${job.pageCount} 页` : ''}</span>
      {job.error && <span role="alert">{job.error.code}</span>}
      {['failed', 'cancelled'].includes(job.status) && <button type="button" onClick={() => void send({ type: 'document.retry', documentId: job.id })}>重试</button>}
      {!['ready', 'cancelled'].includes(job.status) && <button type="button" onClick={() => void send({ type: 'document.cancel', documentId: job.id })}>取消</button>}
    </li>)}</ul>
    {error && <p role="alert">操作未完成：{error}</p>}
  </div>
}
