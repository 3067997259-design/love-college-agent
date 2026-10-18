import { useState } from 'react'
import type { AppBridge, AppCommand, AppSnapshot, DocumentScenarioId } from '../../../shared'
import { SettingsIssue } from './SettingsIssue'

export function DocumentControls({ bridge, snapshot }: { bridge: AppBridge; snapshot: AppSnapshot }) {
  const [error, setError] = useState('')
  const view = snapshot.documents
  if (!view) return null
  const send = async (body: Record<string, unknown>) => {
    try { const ack = await bridge.dispatch({ ...body, protocolVersion: 1, epoch: snapshot.epoch, requestId: crypto.randomUUID() } as AppCommand); setError(ack.status === 'rejected' ? ack.error.code : '') }
    catch { setError('connection-failed') }
  }
  const labels = { staged: '已暂存，可重试处理', queued: '等待处理', processing: '正在整理', ready: '已交付', failed: '处理失败', cancelled: '已取消' }
  return <div aria-label="资料处理控制">
    <h2>附件与资料</h2>
    <label><input type="checkbox" aria-label="文件隐私过滤 /privacy" checked={snapshot.privacy.fileFilteringEnabled} disabled={!view.privacyAvailable && !snapshot.privacy.fileFilteringEnabled}
      onChange={(event) => void send({ type: 'privacy.set', enabled: event.target.checked })} /> /privacy · 文件只交给隔离滤芯</label>
    {!view.privacyAvailable && <p>文件滤芯尚未接通。关闭滤芯时，新资料由主模型整理；开启隔离需先配置独立隐私模型。</p>}
    <p>{snapshot.privacy.fileFilteringEnabled ? '滤芯已开启：原文和成品只给用户，她只收到校验后的短字段。' : snapshot.runtime?.developer.mode === 'developer' ? '开发模式下关闭滤芯只暂存。' : '滤芯已关闭：新资料由主模型整理，原文可进入对话。以前隔离的资料不会自动公开；对旧资料重试时采用当前设置。'}</p>
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
      <SettingsIssue code={job.error?.code} />
      {['staged', 'failed', 'cancelled'].includes(job.status) && <button type="button" onClick={() => void send({ type: 'document.retry', documentId: job.id })}>{!snapshot.privacy.fileFilteringEnabled && snapshot.runtime?.developer.mode !== 'developer' ? '交给主模型整理' : '重试'}</button>}
      {!['ready', 'cancelled'].includes(job.status) && <button type="button" onClick={() => void send({ type: 'document.cancel', documentId: job.id })}>取消</button>}
    </li>)}</ul>
    <SettingsIssue code={error} />
  </div>
}
