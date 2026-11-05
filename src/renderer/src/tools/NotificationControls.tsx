import { useState } from 'react'
import type { AppBridge, AppCommand, AppSnapshot, NotificationRule } from '../../../shared'
import { SettingsIssue, settingStatus } from './SettingsIssue'
const roles = { any: '任意来源', 'teaching-assistant': '课程助教', 'student-club': '社团活动', library: '图书馆', other: '校园信息' }
const ruleText = (sourceRole: NotificationRule['sourceRole'], keyword: string) => `${roles[sourceRole]} · ${keyword ? `标题含“${keyword}”` : '所有邮件'}`

/** 急件提醒：什么时候弹系统通知。设置页把它放在“急件提醒”组里，组名就是标题。 */
export function NotificationControls({ bridge, snapshot }: { bridge: AppBridge; snapshot: AppSnapshot }) {
  const [keyword, setKeyword] = useState(''); const [sourceRole, setRole] = useState<NotificationRule['sourceRole']>('teaching-assistant'); const [error, setError] = useState(''); const view = snapshot.notifications
  if (!view) return null
  const send = async (body: Record<string, unknown>) => { try { const result = await bridge.dispatch({ ...body, protocolVersion: 1, epoch: snapshot.epoch, requestId: crypto.randomUUID() } as AppCommand); setError(result.status === 'rejected' ? result.error.code : '') } catch { setError('connection-failed') } }
  return <section aria-label="急件提醒">
    <p>{settingStatus(view.delivery)} · 这一小时提醒了 {view.sentLastHour}/3 次{view.pendingCount > 0 && ` · ${view.pendingCount} 条等着合并`}</p>
    <p className="settings-note">只在这几种时候提醒你：24 小时内截止的事，邮件里标出的急事（今天要回、地点改了），符合你定的标准的邮件，还有专注时等你批准的操作。提醒里不带发件人、标题和正文。</p>
    <label>提醒来源<select value={sourceRole} onChange={(event) => setRole(event.target.value as NotificationRule['sourceRole'])}>{Object.entries(roles).map(([id, name]) => <option value={id} key={id}>{name}</option>)}</select></label>
    <label>关键词（标题里含有）<input aria-label="提醒关键词" maxLength={20} value={keyword} placeholder="留空表示这个来源的所有邮件" onChange={(event) => setKeyword(event.target.value)} /></label>
    <div className="settings-actions"><button onClick={() => void send({ type: 'notification.rule.add', sourceRole, keyword })}>添加这个提醒标准</button></div>
    {view.rules.length > 0 && <ul>{view.rules.map((rule) => <li key={rule.id}>{ruleText(rule.sourceRole, rule.keyword)} <button onClick={() => void send({ type: 'notification.rule.remove', ruleId: rule.id })}>删除标准</button></li>)}</ul>}
    {view.proposal && <div role="alertdialog" aria-label="提醒标准草案"><p>她建议加一条提醒标准：{ruleText(view.proposal.sourceRole, view.proposal.keyword)}</p>
      <div className="settings-actions"><button onClick={() => void send({ type: 'notification.rule.confirm', ruleId: view.proposal!.id })}>确认提醒草案</button><button onClick={() => void send({ type: 'notification.rule.discard', ruleId: view.proposal!.id })}>丢弃提醒草案</button></div></div>}
    <SettingsIssue code={error} />
  </section>
}
