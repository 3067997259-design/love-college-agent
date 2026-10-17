import { useState } from 'react'
import type { AppBridge, AppCommand, AppSnapshot, NotificationRule } from '../../../shared'
import { SettingsIssue, settingStatus } from './SettingsIssue'
const roles = { any: '任意来源', 'teaching-assistant': '课程助教', 'student-club': '社团活动', library: '图书馆', other: '校园信息' }
export function NotificationControls({ bridge, snapshot }: { bridge: AppBridge; snapshot: AppSnapshot }) {
  const [keyword, setKeyword] = useState(''); const [sourceRole, setRole] = useState<NotificationRule['sourceRole']>('teaching-assistant'); const [error, setError] = useState(''); const view = snapshot.notifications
  if (!view) return null
  const send = async (body: Record<string, unknown>) => { try { const result = await bridge.dispatch({ ...body, protocolVersion: 1, epoch: snapshot.epoch, requestId: crypto.randomUUID() } as AppCommand); setError(result.status === 'rejected' ? result.error.code : '') } catch { setError('connection-failed') } }
  return <section aria-label="急件提醒"><h2>急件提醒</h2><p>{settingStatus(view.delivery)} · 待合并 {view.pendingCount} · 一小时内 {view.sentLastHour}/3 次</p>
    <p>只通知近 24 小时截止、已校验的紧急枚举、你指定的标准和专注中的审批。通知不带发件人、标题或正文。</p>
    <label>提醒来源<select value={sourceRole} onChange={(event) => setRole(event.target.value as NotificationRule['sourceRole'])}>{Object.entries(roles).map(([id, name]) => <option value={id} key={id}>{name}</option>)}</select></label>
    <label>短标题包含<input aria-label="提醒关键词" maxLength={20} value={keyword} onChange={(event) => setKeyword(event.target.value)} /></label><button onClick={() => void send({ type: 'notification.rule.add', sourceRole, keyword })}>添加这个提醒标准</button>
    <ul>{view.rules.map((rule) => <li key={rule.id}>{roles[rule.sourceRole]} · {rule.keyword || '全部短标题'}<button onClick={() => void send({ type: 'notification.rule.remove', ruleId: rule.id })}>删除标准</button></li>)}</ul>
    {view.proposal && <div role="alertdialog" aria-label="提醒标准草案"><p>{roles[view.proposal.sourceRole]} · {view.proposal.keyword || '全部短标题'}</p><button onClick={() => void send({ type: 'notification.rule.confirm', ruleId: view.proposal!.id })}>确认提醒草案</button><button onClick={() => void send({ type: 'notification.rule.discard', ruleId: view.proposal!.id })}>丢弃提醒草案</button></div>}
    <SettingsIssue code={error} />
  </section>
}
