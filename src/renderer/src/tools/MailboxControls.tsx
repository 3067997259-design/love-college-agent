import { useState } from 'react'
import type { AppBridge, AppCommand, AppSnapshot, MailScenarioId } from '../../../shared'
import { formatClock } from '../book/format'
import { SettingsIssue } from './SettingsIssue'

const LABELS = { blocked: '还没连上', idle: '还没看过', scanning: '正在看邮件', ready: '看过了', failed: '有几封没处理好', disabled: '邮件插件停用了' }

/** 邮箱的来源和状态。看邮件是她用邮件工具做的事；这里只显示状态，并给你一次手动重连。 */
export function MailboxControls({ bridge, snapshot }: { bridge: AppBridge; snapshot: AppSnapshot }) {
  const [error, setError] = useState('')
  const mailbox = snapshot.mailbox
  if (!mailbox) return null
  const dispatch = async (body: Record<string, unknown>) => {
    try {
      const ack = await bridge.dispatch({ ...body, protocolVersion: 1, epoch: snapshot.epoch, requestId: crypto.randomUUID() } as AppCommand)
      setError(ack.status === 'rejected' ? ack.error.code : '')
    } catch { setError('connection-failed') }
  }
  const unconfigured = mailbox.source === 'real' && mailbox.status === 'blocked' && snapshot.modelSettings?.services?.mail === false
  // A mailbox that is merely not connected yet is a normal state, not an error: one quiet line.
  const quiet = mailbox.source === 'real' && mailbox.status === 'blocked' && !error
  const retryable = mailbox.source === 'real' && !unconfigured && mailbox.status !== 'scanning' && mailbox.status !== 'disabled'
  const lastAttempt = mailbox.lastAttemptAtMs === null ? null : formatClock(mailbox.lastAttemptAtMs)
  const lastSuccess = mailbox.lastSuccessAtMs === null ? null : formatClock(mailbox.lastSuccessAtMs)
  return <div aria-label="邮箱控制" data-source={mailbox.source} data-status={mailbox.status}>
    <h3>邮箱{mailbox.source === 'fake' ? '（合成数据）' : ''}</h3>
    {unconfigured ? <p>还没配置邮箱。在上面「其他连接」里填好邮箱，重启后她就能看邮件。</p> : <>
      <p className="settings-note">文件夹「{mailbox.folderLabel}」 · {LABELS[mailbox.status]}{mailbox.processedCount > 0 ? ` · 已处理 ${mailbox.processedCount} 封` : ''}{mailbox.pendingReviewCount > 0 ? ` · 等你确认 ${mailbox.pendingReviewCount} 件` : ''}</p>
      <p className="settings-note">她查邮件时才会连一次邮箱。{lastAttempt ? `上次尝试 ${lastAttempt}` : '这次启动还没试过连接'}；{lastSuccess ? `上次成功 ${lastSuccess}` : '还没有成功过'}。</p>
      {retryable && <div className="card-actions"><button type="button" onClick={() => void dispatch({ type: 'mail.scan' })}>重新连接并检查</button></div>}
    </>}
    {snapshot.runtime?.developer.mode === 'developer' && <details className="settings-advanced"><summary>开发：合成邮件场景</summary>
      <label>合成邮件场景 <select aria-label="合成邮件场景" value={mailbox.scenarioId ?? 'initial'} disabled={mailbox.status === 'scanning'} onChange={(event) => void dispatch({ type: 'developer.mailbox', scenarioId: event.target.value as MailScenarioId })}>
        <option value="initial">初始：作业、活动与无待办馆讯</option><option value="deadline-change">新增截止时间变更</option><option value="malicious">恶意输出拒绝</option><option value="privacy-failure">隐私模型不可用</option><option value="empty">空邮箱</option>
      </select></label>
    </details>}
    {!quiet && <SettingsIssue code={error || mailbox.error?.code} />}
    <p className="settings-note">确认过的事可以在日程页导出成日历文件。</p>
  </div>
}
