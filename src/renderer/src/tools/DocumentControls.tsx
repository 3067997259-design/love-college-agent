import { useState } from 'react'
import type { AppBridge, AppCommand, AppSnapshot, DocumentScenarioId, PublicErrorCode } from '../../../shared'
import { SettingsIssue } from './SettingsIssue'

/** Short, human reasons for a failed document job — shown inline instead of a second warning box. */
const JOB_REASON: Partial<Record<PublicErrorCode, string>> = {
  'privacy-unavailable': '独立隐私模型未接通',
  'privacy-invalid-output': '模型返回结果未通过检查',
  'document-parse-failed': '没有可解析的文字层',
  'document-interrupted': '整理中途断了',
  'file-too-large': '文件超过大小上限',
  'file-unreadable': '文件读不了',
  'unsupported-file': '暂不支持这种格式',
  'operation-cancelled': '已取消',
}

export function DocumentControls({ bridge, snapshot }: { bridge: AppBridge; snapshot: AppSnapshot }) {
  const [error, setError] = useState('')
  const view = snapshot.documents
  if (!view) return null
  const send = async (body: Record<string, unknown>) => {
    try { const ack = await bridge.dispatch({ ...body, protocolVersion: 1, epoch: snapshot.epoch, requestId: crypto.randomUUID() } as AppCommand); setError(ack.status === 'rejected' ? ack.error.code : '') }
    catch { setError('connection-failed') }
  }
  const labels = { staged: '先收着，可以再整理', queued: '排队中', processing: '正在整理', ready: '整理好了', failed: '没整理成', cancelled: '已取消' }
  const isolated = snapshot.privacy.fileFilteringEnabled
  return <div aria-label="资料处理控制">
    <h3>附件与资料</h3>
    <label><input type="checkbox" aria-label="用独立隐私模型隔离整理文件" checked={isolated} disabled={!view.privacyAvailable && !isolated}
      onChange={(event) => void send({ type: 'privacy.set', enabled: event.target.checked })} /> 用独立隐私模型隔离整理文件</label>
    <p className="settings-note">{isolated
      ? '已开启隔离：文件原文只由独立隐私模型处理，她只收到脱敏后的短字段。'
      : view.privacyAvailable
        ? '当前由聊天模型直接读取并整理新文件。'
        : '当前由聊天模型直接读取并整理新文件；要隔离原文，先在「模型与声音」里配置独立隐私模型。'}
      {' '}也可以在对话里发 /privacy 快速开关。支持 10 MB 内的文字层 PDF、TXT、Markdown。</p>
    {snapshot.runtime?.developer.mode === 'developer' && <details className="settings-advanced">
      <summary>开发：隐私隔离测试场景</summary>
      <label>隐私隔离测试场景 <select aria-label="隐私隔离测试场景" value={view.scenarioId ?? 'ready'} onChange={(event) => void send({ type: 'developer.documents', scenarioId: event.target.value as DocumentScenarioId })}>
        <option value="ready">可用</option><option value="privacy-failure">隐私模型不可用</option><option value="malicious">非法输出</option>
      </select></label>
      <div className="card-actions">
        <button type="button" onClick={() => void send({ type: 'developer.document.import', fixtureId: 'notes-text' })}>暂存合成文本</button>
        <button type="button" onClick={() => void send({ type: 'developer.document.import', fixtureId: 'assignment-pdf' })}>暂存合成 PDF</button>
      </div>
    </details>}
    {view.attachments.length > 0 && <ul className="document-list">{view.attachments.map((attachment) => <li key={attachment.id} className="document-attachment" data-id={attachment.id}>
      <span>{attachment.source === 'fake' ? '合成 · ' : ''}{attachment.displayName} · {Math.max(1, Math.round(attachment.byteLength / 1024)).toLocaleString('en-US')} KB</span>
      <button type="button" disabled={snapshot.companion.lightsOut} onClick={() => void send({ type: 'document.attachment', attachmentId: attachment.id })}>整理附件</button>
    </li>)}</ul>}
    {view.jobs.length > 0 && <ul className="document-list">{view.jobs.map((job) => <li key={job.id} className="document-job" data-id={job.id} data-status={job.status}>
      <span className="document-job-name">{job.source === 'fake' ? '合成 · ' : ''}{job.displayName}</span>
      <small className="document-job-state">{labels[job.status]}{job.pageCount ? ` · ${job.pageCount} 页` : ''}{job.error?.code && ` · ${JOB_REASON[job.error.code] ?? '这次没处理成'}`}</small>
      <span className="document-job-actions">
        {['staged', 'failed', 'cancelled'].includes(job.status) && <button type="button" onClick={() => void send({ type: 'document.retry', documentId: job.id })}>{!isolated && snapshot.runtime?.developer.mode !== 'developer' ? '交给主模型整理' : '重试'}</button>}
        {!['ready', 'cancelled'].includes(job.status) && <button type="button" onClick={() => void send({ type: 'document.cancel', documentId: job.id })}>取消</button>}
      </span>
    </li>)}</ul>}
    <SettingsIssue code={error} />
  </div>
}
