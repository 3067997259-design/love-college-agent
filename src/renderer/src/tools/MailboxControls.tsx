import { useState } from 'react'
import type { AppBridge, AppCommand, AppSnapshot, MailScenarioId } from '../../../shared'
import { SettingsIssue } from './SettingsIssue'

export function MailboxControls({ bridge, snapshot }: { bridge: AppBridge; snapshot: AppSnapshot }) {
  const [error, setError] = useState('')
  const mailbox = snapshot.mailbox
  if (!mailbox) return null
  const send = async (body: { type: 'developer.mailbox'; scenarioId: MailScenarioId }) => {
    try {
      const ack = await bridge.dispatch({ ...body, protocolVersion: 1, epoch: snapshot.epoch, requestId: crypto.randomUUID() } as AppCommand)
      setError(ack.status === 'rejected' ? ack.error.code : '')
    } catch { setError('connection-failed') }
  }
  const labels = { blocked: '来源阻塞', idle: '等待扫描', scanning: '正在扫描', ready: '扫描完成', failed: '部分内容未能处理', disabled: '插件已停用' }
  return <div aria-label="邮箱控制" data-source={mailbox.source} data-status={mailbox.status}>
    <h2>邮箱 · {mailbox.source === 'fake' ? '合成数据' : '真实来源'}</h2>
    <p>{mailbox.folderLabel} · {labels[mailbox.status]}</p>
    {mailbox.source === 'real' && mailbox.status === 'blocked' && <p>邮箱连接受阻，尚未扫描。请核对网络与配置；失败不表示没有新邮件。</p>}
    <p>服务器未读：{mailbox.unseenCount ?? '未能观察'} · 已处理：{mailbox.processedCount} · 待确认：{mailbox.pendingReviewCount}</p>
    {snapshot.runtime?.developer.mode === 'developer' && <label>合成邮件场景 <select value={mailbox.scenarioId ?? 'initial'} disabled={mailbox.status === 'scanning'} onChange={(event) => void send({ type: 'developer.mailbox', scenarioId: event.target.value as MailScenarioId })}>
      <option value="initial">初始：作业、活动与无待办馆讯</option><option value="deadline-change">新增截止时间变更</option><option value="malicious">恶意输出拒绝</option><option value="privacy-failure">隐私模型不可用</option><option value="empty">空邮箱</option>
    </select></label>}
    <SettingsIssue code={mailbox.error?.code ?? error} />
    <p>扫描和导出新确认事项在日程页；这里只保留来源状态、合成场景和附件整理。</p>
  </div>
}
